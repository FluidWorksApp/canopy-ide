import { beforeEach, describe, expect, it, vi } from "vitest";
import type { askBrain, BrainAnswer } from "../brainCall";
import type { LedgerDraft, LedgerEntry } from "../ledger";
import { assembleSessionDoc } from "./assemble";
import {
  buildPacket,
  generateHandoff,
  handoffPrompt,
  packetMarkdown,
  takeoverBrief,
  validateBrainPacket,
  type HandoffPacket,
} from "./handoff";
import {
  cachedNarrative,
  narrativePrompt,
  resetNarrativesForTests,
  validateNarrative,
  writeNarrative,
} from "./narrative";
import { buildHandoffCard } from "./card";
import { cardDraft, cardFreeText, cardText, parseCard, secretKinds, type Card } from "../teamMessaging/cardSchema";

const doc = assembleSessionDoc({
  sessionId: "sess-1",
  agent: "claude",
  cwd: "/repo/app",
  digest: { session_id: "sess-1", first_prompt: "Add login", prompts: ["Add login", "Add tests"], files: ["src/login.tsx"] },
  transcript: [
    { role: "user", text: "Add login" },
    { role: "assistant", text: "Using Supabase since it's already a dependency." },
  ],
});

const ok = <T,>(value: T): BrainAnswer<T> => ({
  ok: true,
  text: JSON.stringify(value),
  value,
  costUsd: 0.01,
  inputTokens: 1,
  outputTokens: 1,
} as BrainAnswer<T>);

const NARRATIVE = {
  summary: "Built a login page.",
  decisions: [{ decision: "Supabase auth", why: "Already a dependency", alternativesRejected: ["Auth0"] }],
  openQuestions: ["Rate limits?"],
  nextSteps: ["Add tests"],
  risks: [],
};

beforeEach(() => resetNarrativesForTests());

describe("narrative", () => {
  it("validates strictly where it matters and leniently elsewhere", () => {
    expect(validateNarrative(NARRATIVE)).toEqual(NARRATIVE);
    expect(validateNarrative({ ...NARRATIVE, summary: "" })).toBeNull();
    expect(validateNarrative({ ...NARRATIVE, decisions: "no" })).toBeNull();
    expect(validateNarrative({ ...NARRATIVE, risks: "no" })).toBeNull();
    // Missing lists are empty; decisions without a why are dropped.
    expect(validateNarrative({ summary: "s", decisions: [{ decision: "d" }] })).toEqual({
      summary: "s",
      decisions: [],
      openQuestions: [],
      nextSteps: [],
      risks: [],
    });
  });

  it("puts the goal, turns, files and transcript in the prompt", () => {
    const p = narrativePrompt(doc);
    expect(p).toContain("Add login");
    expect(p).toContain("2. Add tests");
    expect(p).toContain("src/login.tsx");
    expect(p).toContain("[AGENT]\nUsing Supabase");
    expect(p).toContain('"alternativesRejected"');
  });

  it("asks on the background tier as handoff, caches by turn, and shares an in-flight call", async () => {
    let resolve!: (v: BrainAnswer<unknown>) => void;
    const ask = vi.fn(() => new Promise<BrainAnswer<unknown>>((r) => (resolve = r))) as unknown as typeof askBrain;
    const a = writeNarrative(doc, { cwd: "/repo/app", ask });
    const b = writeNarrative(doc, { cwd: "/repo/app", ask });
    expect(ask).toHaveBeenCalledTimes(1);
    const req = (ask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req).toMatchObject({ feature: "handoff", tier: "background", json: true, cwd: "/repo/app" });
    expect(req.validate(NARRATIVE)).toEqual(NARRATIVE);
    resolve(ok(NARRATIVE));
    expect((await a).ok).toBe(true);
    expect(await b).toBe(await a);
    expect(cachedNarrative("sess-1")).toMatchObject({ turnKey: doc.lastTurnKey, narrative: NARRATIVE });
  });

  it("retries without a directory when the session's directory is gone", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "failed", message: "brain call cwd does not exist: /gone" })
      .mockResolvedValueOnce(ok(NARRATIVE)) as unknown as typeof askBrain;
    const answer = await writeNarrative(doc, { cwd: "/gone", ask });
    expect(answer.ok).toBe(true);
    expect((ask as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0].cwd).toBe("");
  });
});

const BRAIN_PACKET = {
  title: "Passwordless login",
  state: "Login page works; tests not written.",
  decisions: NARRATIVE.decisions,
  constraints: ["Don't change the session cookie name"],
  openQuestions: ["Rate limits?"],
  nextSteps: ["Write tests for the magic-link flow", "Open a PR"],
  risks: ["Emails may land in spam"],
  howToResume: "Run npm test first.",
};

describe("handoff packet", () => {
  it("validates the brain's part", () => {
    expect(validateBrainPacket(BRAIN_PACKET)).toEqual(BRAIN_PACKET);
    expect(validateBrainPacket({ ...BRAIN_PACKET, state: " " })).toBeNull();
    expect(validateBrainPacket({ ...BRAIN_PACKET, constraints: "x" })).toBeNull();
  });

  it("includes an earlier narrative in the prompt when there is one", () => {
    expect(handoffPrompt(doc, NARRATIVE)).toContain("Already a dependency");
    expect(handoffPrompt(doc)).not.toContain("An earlier reading");
  });

  it("renders the packet as markdown, leaving out empty sections", () => {
    const packet = buildPacket(doc, { ...validateBrainPacket(BRAIN_PACKET)!, risks: [] }, {
      branch: "feat/login",
      resumeCommand: "agent --resume sess-1",
      now: Date.UTC(2026, 9, 27, 12, 30),
    });
    const md = packetMarkdown(packet);
    expect(md).toBe(
      [
        "# Handoff: Passwordless login",
        "",
        "From a claude session (`sess-1`) in `app` on branch `feat/login` · 2026-10-27 12:30 UTC",
        "",
        "## Goal",
        "",
        "Add login",
        "",
        "## Where it stands",
        "",
        "Login page works; tests not written.",
        "",
        "## Decisions and why",
        "",
        "- **Supabase auth** — Already a dependency (rejected: Auth0)",
        "",
        "## Constraints",
        "",
        "- Don't change the session cookie name",
        "",
        "## Open questions",
        "",
        "- Rate limits?",
        "",
        "## Next steps",
        "",
        "1. Write tests for the magic-link flow",
        "2. Open a PR",
        "",
        "## Files changed",
        "",
        "- `src/login.tsx`",
        "",
        "## How to resume",
        "",
        "Run npm test first.",
        "",
        "The original claude conversation can be resumed on the machine it ran on with: agent --resume sess-1",
      ].join("\n"),
    );
    expect(takeoverBrief(md)).toMatch(/^You are taking over a coding task[\s\S]*# Handoff: Passwordless login/);
  });

  it("asks on the main tier and files the packet in the ledger against the session", async () => {
    const ask = vi.fn().mockResolvedValue(ok(BRAIN_PACKET)) as unknown as typeof askBrain;
    const appended: LedgerDraft<HandoffPacket>[] = [];
    const append = vi.fn(async (_root: string, draft: LedgerDraft<unknown>) => {
      appended.push(draft as LedgerDraft<HandoffPacket>);
      return { ...draft, id: "h1", ts: 1, root: "/repo/app" } as LedgerEntry<unknown>;
    });
    const r = await generateHandoff(doc, { cwd: "/repo/app", ask, append: append as never });
    expect((ask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ feature: "handoff", tier: "main", json: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.markdown).toContain("# Handoff: Passwordless login");
    expect(appended[0]).toMatchObject({ kind: "handoff", scope: "personal", ref: { kind: "session", id: "sess-1" } });
    expect(appended[0].data.nextSteps).toEqual(BRAIN_PACKET.nextSteps);
  });

  it("reports the brain declining, and survives a ledger failure", async () => {
    const no = vi.fn().mockResolvedValue({ ok: false, reason: "no-brain", message: "none" }) as unknown as typeof askBrain;
    expect(await generateHandoff(doc, { cwd: "", ask: no })).toEqual({ ok: false, reason: "no-brain", message: "none" });
    const yes = vi.fn().mockResolvedValue(ok(BRAIN_PACKET)) as unknown as typeof askBrain;
    const broken = vi.fn().mockRejectedValue(new Error("disk full"));
    const r = await generateHandoff(doc, { cwd: "", ask: yes, append: broken as never });
    expect(r.ok && r.entry).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});

describe("handoff card", () => {
  it("round-trips through the wire schema with its text fallback", async () => {
    const md = "# Handoff: X\n\n## Next steps\n\n1. Do it";
    const card = await buildHandoffCard({ title: "X", agent: "claude", sessionId: "sess-1", markdown: md, cwd: "/home/me/repo/app" });
    expect(card).toEqual({ type: "handoff", v: 1, title: "X", agent: "claude", session: "sess-1", packet: md, dir: "app" });
    expect(parseCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
    const draft = cardDraft(card, "Can you take this?");
    expect(draft.text).toBe(`Can you take this?\nHandoff: X\n${md}`);
    expect(cardText(card)).toContain("1. Do it");
    // The credential check sees the packet.
    expect(secretKinds(cardFreeText({ ...card, packet: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }))).toContain("a GitHub token");
  });

  it("refuses malformed handoff cards and clips oversized packets to fit", async () => {
    const base: Card = { type: "handoff", v: 1, title: "X", agent: "a", session: "s", packet: "p" };
    expect(parseCard({ ...base, session: "../etc/passwd" })).toBeUndefined();
    expect(parseCard({ ...base, dir: "a/b" })).toBeUndefined();
    expect(parseCard({ ...base, packet: "bad\u0007bell" })).toBeUndefined();
    expect(parseCard({ ...base, extra: 1 })).toBeUndefined();
    const huge = await buildHandoffCard({ title: "X", agent: "a", sessionId: "s", markdown: "line\n".repeat(10_000) });
    expect(huge.truncated).toBe(true);
    expect(parseCard(huge)).toEqual(huge);
  });
});

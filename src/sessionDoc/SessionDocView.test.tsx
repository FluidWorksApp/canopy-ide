import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { askBrain, BrainAnswer } from "../brainCall";
import type { LedgerDraft, LedgerEntry } from "../ledger";
import type { HandoffCard } from "../teamMessaging/cardSchema";
import { assembleSessionDoc } from "./assemble";
import { buildHandoffCard } from "./card";
import { resetNarrativesForTests, storeNarrative } from "./narrative";
import { ReceivedHandoffView, SessionDocView, type SessionDocDeps } from "./SessionDocView";
import { ChatCard } from "../components/ChatCard";
import { OPEN_SESSION_DOC_EVENT, type SessionDocRequest } from "./events";

vi.mock("../prWatchStore", () => ({ watchedPaths: () => [] }));

const SID = "sess-42";
const T0 = 1_760_000_000_000;
const doc = assembleSessionDoc({
  sessionId: SID,
  agent: "claude",
  cwd: "/repo/app",
  digest: { session_id: SID, first_prompt: "Add a login page", files: [] },
  turns: {
    git: true,
    root: "/repo/app",
    shared: false,
    peers: [],
    restores: [],
    turns: [
      {
        n: 1,
        prompt: "Add a login page",
        start: { ref: "a", commit: "c", tree: "t", ts_ms: T0 },
        end: { ref: "b", commit: "c", tree: "t", ts_ms: T0 + 60_000 },
        late: false,
        native_uuid: null,
      },
    ],
  },
  edits: [{ ts: Math.floor((T0 + 1000) / 1000), path: "src/login.tsx", tool: "Edit", old: null, new: "x", present: true }],
  ledger: [
    {
      id: "r1",
      kind: "receipt",
      ts: T0 + 61_000,
      root: "/repo/app",
      author: { kind: "brain", name: "receipt" },
      scope: "project",
      ref: { kind: "session", id: SID },
      data: { verdict: "pass", summary: "Page renders" },
    },
  ],
  transcript: [{ role: "assistant", text: "Going with Supabase." }],
});

const ok = <T,>(value: T) =>
  ({ ok: true, text: "", value, costUsd: 0, inputTokens: 0, outputTokens: 0 }) as BrainAnswer<T>;

const NARRATIVE = {
  summary: "The agent built a passwordless login page and verified it renders.",
  decisions: [{ decision: "Use Supabase magic links", why: "The project already depends on Supabase", alternativesRejected: ["Auth0"] }],
  openQuestions: ["Should links expire after 10 minutes?"],
  nextSteps: ["Write tests"],
  risks: [],
};
const PACKET = {
  title: "Passwordless login",
  state: "Page done; no tests yet.",
  decisions: NARRATIVE.decisions,
  constraints: [],
  openQuestions: NARRATIVE.openQuestions,
  nextSteps: ["Write tests"],
  risks: [],
  howToResume: "Run the dev server and open /login.",
};

function makeDeps(over: Partial<SessionDocDeps> = {}) {
  const ask = vi.fn(async (req: { tier?: string }) => (req.tier === "main" ? ok(PACKET) : ok(NARRATIVE)));
  const appended: LedgerDraft<unknown>[] = [];
  const deps: SessionDocDeps = {
    load: async () => ({ doc, missing: [] }),
    ask: ask as unknown as typeof askBrain,
    append: (async (_root: string, draft: LedgerDraft<unknown>) => {
      appended.push(draft);
      return { ...draft, id: "h1", ts: 1, root: "/repo/app" } as LedgerEntry<unknown>;
    }) as never,
    share: vi.fn(),
    buildCard: buildHandoffCard,
    copy: vi.fn(async () => {}),
    launch: vi.fn(async () => ({ started: true, note: "Started an agent in /repo/app." })),
    agents: async () => [
      { id: "brain-cli", name: "Brain CLI", brain: true },
      { id: "other-cli", name: "Other CLI", brain: false },
    ],
    projects: () => [{ name: "App", dirs: ["/repo/app"] }],
    autoSummary: () => true,
    onTurnEnd: () => () => {},
    ...over,
  };
  return { deps, ask, appended };
}

const request: Extract<SessionDocRequest, { kind: "session" }> = {
  kind: "session",
  sessionId: SID,
  agent: "claude",
  cwd: "/repo/app",
};

// The machine running the suite is busy; give renders room.
const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => resetNarrativesForTests());
afterEach(cleanup);

describe("SessionDocView", () => {
  it("shows the facts and the brain's narrative, written on the background tier", async () => {
    const { deps, ask } = makeDeps();
    render(<SessionDocView request={request} onClose={() => {}} deps={deps} />);
    expect(await screen.findByText(NARRATIVE.summary, undefined, WAIT)).toBeTruthy();
    expect(ask.mock.calls[0][0]).toMatchObject({ feature: "handoff", tier: "background" });
    const decisions = screen.getByRole("region", { name: "Decisions" });
    expect(within(decisions).getByText("Use Supabase magic links")).toBeTruthy();
    expect(within(decisions).getByText(/Not chosen: Auth0/)).toBeTruthy();
    expect(screen.getByText("Should links expire after 10 minutes?")).toBeTruthy();
    const timeline = screen.getByRole("region", { name: "Timeline" });
    expect(within(timeline).getByText("Add a login page")).toBeTruthy();
    expect(within(timeline).getByText("login.tsx")).toBeTruthy();
    expect(within(timeline).getByText(/did what was asked/)).toBeTruthy();
    expect(screen.getByText(/Lines from this session: 1 edit it wrote/)).toBeTruthy();
    expect(screen.getByText(/Private to you/)).toBeTruthy();
  });

  it("uses a current cached narrative without asking, and does not auto-ask when turned off", async () => {
    storeNarrative(SID, { narrative: { ...NARRATIVE, summary: "Cached reading." }, turnKey: doc.lastTurnKey, at: 1 });
    const cached = makeDeps();
    render(<SessionDocView request={request} onClose={() => {}} deps={cached.deps} />);
    expect(await screen.findByText("Cached reading.", undefined, WAIT)).toBeTruthy();
    expect(cached.ask).not.toHaveBeenCalled();
    cleanup();

    storeNarrative(SID, { narrative: { ...NARRATIVE, summary: "Old reading." }, turnKey: "older", at: 1 });
    const off = makeDeps({ autoSummary: () => false });
    render(<SessionDocView request={request} onClose={() => {}} deps={off.deps} />);
    expect(await screen.findByText("Old reading.", undefined, WAIT)).toBeTruthy();
    expect(screen.getByText(/Written before the latest turn/)).toBeTruthy();
    expect(off.ask).not.toHaveBeenCalled();
  });

  it("stays live: re-reads after every turn, re-asks the brain only every few turns", async () => {
    // A doc whose timeline has `n` turns.
    const withTurns = (n: number) =>
      assembleSessionDoc({
        sessionId: SID,
        agent: "claude",
        cwd: "/repo/app",
        digest: { session_id: SID, first_prompt: "Add a login page", files: [] },
        turns: {
          git: true,
          root: "/repo/app",
          shared: false,
          peers: [],
          restores: [],
          turns: Array.from({ length: n }, (_, i) => ({
            n: i + 1,
            prompt: `Step ${i + 1}`,
            start: { ref: `s${i}`, commit: "c", tree: "t", ts_ms: T0 + i * 60_000 },
            end: { ref: `e${i}`, commit: "c", tree: "t", ts_ms: T0 + i * 60_000 + 30_000 },
            late: false,
            native_uuid: null,
          })),
        },
        edits: [],
        ledger: [],
        transcript: [],
        live: true,
      });
    let turns = 1;
    let turnEnded: (sid: string) => void = () => {};
    const { deps, ask } = makeDeps({
      load: async () => ({ doc: withTurns(turns), missing: [] }),
      onTurnEnd: (cb) => {
        turnEnded = cb;
        return () => {};
      },
    });
    render(<SessionDocView request={{ ...request, live: true }} onClose={() => {}} deps={deps} />);
    await screen.findByText(NARRATIVE.summary, undefined, WAIT);
    expect(ask).toHaveBeenCalledTimes(1);

    // Two more turns: the timeline follows, the summary is the cached one.
    for (const n of [2, 3]) {
      turns = n;
      act(() => turnEnded(SID));
      await screen.findByText(`Step ${n}`, undefined, WAIT);
    }
    expect(screen.getByText(/rewritten every few turns while the session runs/)).toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(1);
    // Another session's turn changes nothing.
    turns = 9;
    act(() => turnEnded("someone-else"));
    // The third turn since the summary: now it is re-asked, once.
    turns = 4;
    act(() => turnEnded(SID));
    await screen.findByText("Step 4", undefined, WAIT);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2), WAIT);
  });

  it("says plainly when there is no brain", async () => {
    const { deps } = makeDeps({
      ask: (async () => ({ ok: false, reason: "no-brain", message: "" })) as unknown as typeof askBrain,
    });
    render(<SessionDocView request={request} onClose={() => {}} deps={deps} />);
    expect(await screen.findByText(/No brain connected/, undefined, WAIT)).toBeTruthy();
  });

  it("hands off: previews an editable packet, files it, and offers every target", async () => {
    const { deps, ask, appended } = makeDeps();
    const onResume = vi.fn();
    render(<SessionDocView request={{ ...request, onResume, resumeCommand: "cli --resume sess-42" }} onClose={() => {}} deps={deps} />);
    await screen.findByText(NARRATIVE.summary, undefined, WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Hand off…" }));
    // Nothing is generated or sent before the person asks.
    expect(screen.getByText(/Nothing is sent anywhere until you choose/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Write hand-off packet" }));
    const packet = (await screen.findByLabelText("Hand-off packet", undefined, WAIT)) as HTMLTextAreaElement;
    expect(ask.mock.calls.some((c) => (c[0] as { tier?: string }).tier === "main")).toBe(true);
    expect(packet.value).toContain("# Handoff: Passwordless login");
    expect(packet.value).toContain("Use Supabase magic links");
    expect(packet.value).toContain("cli --resume sess-42");
    expect(appended[0]).toMatchObject({ kind: "handoff", ref: { kind: "session", id: SID } });

    // Edit, then copy: the copy is the edited text.
    fireEvent.change(packet, { target: { value: `${packet.value}\n\nPS: ping me` } });
    fireEvent.click(screen.getByRole("button", { name: "Copy as markdown" }));
    expect(deps.copy).toHaveBeenCalledWith(expect.stringContaining("PS: ping me"));

    fireEvent.click(screen.getByRole("button", { name: "Send to a teammate…" }));
    await waitFor(() => expect(deps.share).toHaveBeenCalled(), WAIT);
    const card = (deps.share as ReturnType<typeof vi.fn>).mock.calls[0][0] as HandoffCard;
    expect(card).toMatchObject({ type: "handoff", session: SID, title: "Passwordless login" });
    expect(card.packet).toContain("PS: ping me");

    fireEvent.click(screen.getByRole("button", { name: "Continue in a new agent…" }));
    const start = await screen.findByRole("button", { name: "Start agent from this packet" }, WAIT);
    await waitFor(() => expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("brain-cli"), WAIT);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "other-cli" } });
    fireEvent.click(start);
    await screen.findByText("Started an agent in /repo/app.", undefined, WAIT);
    expect(deps.launch).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/repo/app", agent: "other-cli", prompt: expect.stringContaining("You are taking over") }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume the original session" }));
    expect(onResume).toHaveBeenCalled();
  });
});

describe("receiving a handoff", () => {
  it("a handoff card's Take over opens the packet, which starts an agent here", async () => {
    const md = "# Handoff: Passwordless login\n\n## Next steps\n\n1. Write tests";
    const card = await buildHandoffCard({ title: "Passwordless login", agent: "claude", sessionId: SID, markdown: md });
    const opened: SessionDocRequest[] = [];
    const listen = (e: Event) => opened.push((e as CustomEvent<SessionDocRequest>).detail);
    window.addEventListener(OPEN_SESSION_DOC_EVENT, listen);
    const message = { id: "00000000-0000-4000-8000-000000000001", sender: "bob", recipient: "me", text: "x", created: 1, card };
    render(<ChatCard message={message as never} userId="me" messages={[message as never]} name={(id) => (id === "bob" ? "Bob" : id)} />);
    expect(screen.getByText(/handed off by Bob/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    window.removeEventListener(OPEN_SESSION_DOC_EVENT, listen);
    expect(opened[0]).toMatchObject({ kind: "received", packet: md, from: "Bob", session: SID });
    cleanup();

    const { deps } = makeDeps();
    render(<ReceivedHandoffView request={opened[0] as Extract<SessionDocRequest, { kind: "received" }>} onClose={() => {}} deps={deps} />);
    expect(screen.getByText(/1\. Write tests/)).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start agent from this packet" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false), WAIT);
    fireEvent.click(start);
    await screen.findByText("Started an agent in /repo/app.", undefined, WAIT);
    expect(deps.launch).toHaveBeenCalledWith(expect.objectContaining({ agent: "brain-cli", prompt: expect.stringContaining(md) }));
  });
});

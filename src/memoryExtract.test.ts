import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnEnd } from "./agentTurns";
import type { BrainAnswer } from "./brainCall";
import type { LedgerEntry } from "./ledger";
import {
  EXTRACT_WINDOW_MS,
  flush,
  observeMemoryEvents,
  onTurnEnd,
  resetMemoryExtractForTests,
  reviewProposal,
  setMemoryExtractDepsForTests,
} from "./memoryExtract";
import type { MemoryEntry, NewMemory } from "./memoryLedger";
import { updateSettings } from "./settings";
import type { AgentEventData } from "../shared/notifications";

const ok = <T,>(value: T): BrainAnswer<T> => ({
  ok: true,
  text: JSON.stringify(value),
  value,
  costUsd: 0.001,
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  model: null,
});

const turn = (over: Partial<AgentTurnEnd> = {}): AgentTurnEnd => ({
  turnId: "s1:100",
  ptyId: 4,
  sessionId: "s1",
  cli: "agent-x",
  cwd: "/repo/wt",
  root: "/repo",
  prompt: "Lock down tenant data",
  startedAt: 100,
  endedAt: 200,
  filesTouched: ["db/rls.sql"],
  ...over,
});

const ev = (over: Partial<AgentEventData>): AgentEventData => ({
  sessionId: "s1",
  cwd: "/repo/wt",
  pty: 4,
  event: "PostToolUse",
  tool: "",
  agent: "agent-x",
  ...over,
});

const approved = (memoryId: string, text: string): MemoryEntry => ({
  id: `id-${memoryId}`,
  kind: "memory",
  ts: 1,
  root: "/repo",
  author: { kind: "brain", name: "memory" },
  scope: "project",
  status: "approved",
  data: { memoryId, type: "decision", text, why: "", confidence: 0.8, createdAt: 1, source: "brain", provenance: { files: [] } },
});

let now = 1_000_000;
let ask: ReturnType<typeof vi.fn>;
let append: ReturnType<typeof vi.fn>;
let revise: ReturnType<typeof vi.fn>;
let existing: MemoryEntry[];
let lease: ReturnType<typeof vi.fn>;
let tail: ReturnType<typeof vi.fn>;
let changes: ReturnType<typeof vi.fn>;
let tidy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  resetMemoryExtractForTests();
  now = 1_000_000;
  existing = [];
  ask = vi.fn(async (req: { prompt: string }) =>
    req.prompt.includes("compare") || req.prompt.includes("Compare")
      ? ok({ contradicts: [], supersedes: [] })
      : ok([
          { type: "decision", text: "Tenant isolation uses Postgres row level security", why: "app checks were missed", scope: "team", confidence: 0.9 },
        ]),
  );
  append = vi.fn(async (_root: string, m: NewMemory) => ({ id: "new", data: m }));
  revise = vi.fn(async () => ({}));
  lease = vi.fn(async () => true);
  tail = vi.fn(async () => []);
  changes = vi.fn(async () => null);
  tidy = vi.fn(async () => {});
  setMemoryExtractDepsForTests({
    tidy: tidy as never,
    ask: ask as never,
    list: async () => existing,
    append: append as never,
    revise: revise as never,
    now: () => now,
    lease: lease as never,
    transcriptTail: tail as never,
    turnChanges: changes as never,
  });
});

afterEach(() => {
  resetMemoryExtractForTests();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("memory extraction after a turn", () => {
  it("asks the brain on the background tier with the prompt, final message and files, and files a proposal", async () => {
    observeMemoryEvents([ev({ event: "Stop", lastAssistantMessage: "Moved every tenant query behind RLS policies." })]);
    onTurnEnd(turn());
    await settle();

    expect(ask).toHaveBeenCalledTimes(1);
    const req = ask.mock.calls[0][0];
    expect(req).toMatchObject({ feature: "memory", tier: "background", json: true, cwd: "/repo/wt" });
    expect(req.prompt).toContain("Asked: Lock down tenant data");
    expect(req.prompt).toContain("Moved every tenant query behind RLS policies.");
    expect(req.prompt).toContain("Files changed: db/rls.sql");
    // The validator is the brain's contract, not a pass-through.
    expect(req.validate({ entries: [{ type: "nope", text: "whatever it is" }] })).toEqual([]);

    expect(append).toHaveBeenCalledTimes(1);
    const [root, m] = append.mock.calls[0];
    expect(root).toBe("/repo");
    expect(m).toMatchObject({
      type: "decision",
      scope: "team",
      source: "brain",
      author: { kind: "brain", name: "memory", sessionId: "s1", cli: "agent-x", ptyId: 4 },
      provenance: { sessionId: "s1", cli: "agent-x", turnId: "s1:100", files: ["db/rls.sql"] },
    });
    expect(m.untrusted).toBeUndefined();
  });

  it("quarantines when the session read untrusted content", async () => {
    observeMemoryEvents([
      ev({ tool: "WebFetch" }),
      ev({ tool: "Bash", toolCommand: "gh pr view 9 --comments" }),
      ev({ tool: "Edit" }),
    ]);
    onTurnEnd(turn());
    await settle();
    expect(append.mock.calls[0][1].untrusted).toEqual(["read a web page", "read issues or pull request comments"]);
  });

  it("does not learn from untrusted sessions at all when set to skip", async () => {
    updateSettings({ memoryQuarantine: "skip" });
    observeMemoryEvents([ev({ tool: "mcp__canopy__canopy_browser_snapshot" })]);
    onTurnEnd(turn());
    await settle();
    expect(ask).not.toHaveBeenCalled();
  });

  it("does nothing when automatic memory is off", async () => {
    updateSettings({ memoryAutoExtract: false });
    onTurnEnd(turn());
    await settle();
    expect(ask).not.toHaveBeenCalled();
  });

  it("calls the brain at most once per session per window, then catches up on session end", async () => {
    onTurnEnd(turn());
    await settle();
    now += 60_000;
    onTurnEnd(turn({ turnId: "s1:300", prompt: "Also add the audit table", filesTouched: ["db/audit.sql"] }));
    onTurnEnd(turn({ turnId: "s1:400", prompt: "And the index", filesTouched: [] }));
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);

    observeMemoryEvents([ev({ event: "SessionEnd" })]);
    await settle();
    expect(ask).toHaveBeenCalledTimes(2);
    const prompt = ask.mock.calls[1][0].prompt as string;
    expect(prompt).toContain("Also add the audit table");
    expect(prompt).toContain("And the index");
    expect(EXTRACT_WINDOW_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("skips turns with nothing to learn from, and memories already known", async () => {
    onTurnEnd(turn({ prompt: undefined, filesTouched: [] }));
    await settle();
    expect(ask).not.toHaveBeenCalled();

    existing = [approved("m1", "Tenant isolation uses Postgres row-level security")];
    onTurnEnd(turn());
    await flush("s1");
    expect(append).not.toHaveBeenCalled();
  });

  it("runs the contradiction check only when an approved entry shares the topic", async () => {
    existing = [approved("m1", "Tenant isolation is done with app-level checks in services")];
    ask.mockImplementation(async (req: { prompt: string }) =>
      req.prompt.includes("Existing:")
        ? ok({ contradicts: ["m1"], supersedes: [] })
        : ok([{ type: "decision", text: "Tenant isolation uses Postgres row level security", why: "", scope: "team", confidence: 0.9 }]),
    );
    onTurnEnd(turn());
    await settle();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toMatchObject({ feature: "memory", tier: "background" });
    expect(append.mock.calls[0][1].verdict).toEqual({ contradicts: ["m1"], supersedes: [] });

    resetMemoryExtractForTests();
    setMemoryExtractDepsForTests({ ask: ask as never, list: async () => [approved("m2", "Deploys happen on Tuesdays")], append: append as never, now: () => now });
    ask.mockClear();
    onTurnEnd(turn());
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("degrades quietly with no brain", async () => {
    ask.mockResolvedValue({ ok: false, reason: "no-brain", message: "none" });
    onTurnEnd(turn());
    await settle();
    expect(append).not.toHaveBeenCalled();
  });
});

describe("a long review queue", () => {
  const waiting = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...approved(`p${i}`, `Pending rule number ${i} about deploys`), status: "proposed" }));

  it("tidies the queue after adding to it", async () => {
    onTurnEnd(turn());
    await settle();
    expect(append).toHaveBeenCalledTimes(1);
    expect(tidy).toHaveBeenCalledWith("/repo", "/repo/wt");
  });

  it("only lets confident proposals join a queue that is already long", async () => {
    existing = waiting(12);
    ask.mockImplementation(async () =>
      ok([
        { type: "fact", text: "Staging runs in eu-west-1 only", why: "", scope: "team", confidence: 0.6 },
        { type: "decision", text: "Tenant isolation uses Postgres row level security", why: "", scope: "team", confidence: 0.9 },
      ]),
    );
    onTurnEnd(turn());
    await settle();
    expect(append.mock.calls.map(([, m]) => m.text)).toEqual(["Tenant isolation uses Postgres row level security"]);
  });

  it("asks for durable knowledge, not the steps of the task underway", async () => {
    onTurnEnd(turn());
    await settle();
    expect(ask.mock.calls[0][0].prompt).toContain("which\n  issues or pull requests to leave open");
  });
});

describe("what extraction reads and who does it", () => {
  it("stands aside when another Canopy window holds the session's lease", async () => {
    lease.mockResolvedValue(false);
    onTurnEnd(turn());
    await settle();
    expect(lease).toHaveBeenCalledWith("/repo", "session:s1", 2 * EXTRACT_WINDOW_MS);
    expect(ask).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("reads the agent's final words from the transcript when the Stop carried none", async () => {
    tail.mockResolvedValue([
      { role: "user", text: "Lock down tenant data" },
      { role: "assistant", text: "Every tenant query now goes through RLS." },
      { role: "user", text: "" },
    ]);
    onTurnEnd(turn());
    await settle();
    expect(tail).toHaveBeenCalledWith("s1", "agent-x", ["/repo", "/repo/wt"]);
    expect(ask.mock.calls[0][0].prompt).toContain("Agent's final message: Every tenant query now goes through RLS.");
  });

  it("does not read the transcript when the Stop said it", async () => {
    observeMemoryEvents([ev({ event: "Stop", lastAssistantMessage: "Done." })]);
    onTurnEnd(turn());
    await settle();
    expect(tail).not.toHaveBeenCalled();
  });

  it("includes changes made by shell commands, from the turn's snapshots", async () => {
    changes.mockResolvedValue([
      { path: "db/rls.sql", status: "modify" },
      { path: "db/seed.sql", status: "add" },
      { path: "scripts/old.sh", status: "delete" },
    ]);
    onTurnEnd(turn());
    await settle();
    expect(changes).toHaveBeenCalledWith({ cwd: "/repo/wt", sessionId: "s1", startedAt: 100, endedAt: 200 });
    const prompt = ask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Files changed: db/rls.sql");
    expect(prompt).toContain("Also changed by shell commands or tools: db/seed.sql (new), scripts/old.sh (deleted)");
    expect(append.mock.calls[0][1].provenance.files).toEqual(["db/rls.sql", "db/seed.sql", "scripts/old.sh"]);
  });
});

describe("agent proposals", () => {
  const proposal = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: "p1",
    kind: "memory",
    ts: 1,
    root: "/repo",
    author: { kind: "agent", name: "wt (/repo/wt)", ptyId: 4 },
    scope: "project",
    status: "proposed",
    data: { memoryId: "mem-a", type: "constraint", text: "Never call billing from a request handler", why: "slow", provenance: { files: [] } },
    ...over,
  });

  it("quarantines a proposal from a terminal whose session browsed the web", async () => {
    observeMemoryEvents([ev({ tool: "WebSearch" })]);
    await reviewProposal(proposal());
    expect(revise).toHaveBeenCalledWith(
      "/repo",
      "mem-a",
      expect.objectContaining({
        status: "quarantined",
        data: expect.objectContaining({ untrusted: ["searched the web"], provenance: { files: [], sessionId: "s1" } }),
      }),
    );
  });

  it("still checks a proposal the bridge quarantined on arrival, keeping its reason", async () => {
    await reviewProposal(
      proposal({ status: "quarantined", data: { memoryId: "mem-q", type: "fact", text: "Staging resets nightly", why: "", untrusted: ["read untrusted content (WebFetch)"], provenance: { files: [] } } }),
    );
    expect(revise).toHaveBeenCalledTimes(1);
    const patch = revise.mock.calls[0][2];
    expect(patch.status).toBeUndefined();
    expect(patch.data.checkedAt).toBe(now);
  });

  it("leaves a proposal to the window that holds its lease", async () => {
    lease.mockResolvedValue(false);
    await reviewProposal(proposal());
    expect(revise).not.toHaveBeenCalled();
  });

  it("checks a clean proposal once and leaves it proposed", async () => {
    await reviewProposal(proposal());
    await reviewProposal(proposal());
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0][2].status).toBeUndefined();
    // The brain's own entries and already-checked ones are not re-reviewed.
    await reviewProposal(proposal({ author: { kind: "brain", name: "memory" }, data: { memoryId: "mem-b", text: "x" } }));
    expect(revise).toHaveBeenCalledTimes(1);
  });
});

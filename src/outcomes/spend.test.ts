import { describe, expect, it, vi } from "vitest";
import type * as ipc from "../ipc";
import type { LedgerDraft, LedgerEntry } from "../ledger";
import type { AgentTurnEnd } from "../agentTurns";
import {
  buildSpend,
  createSpendRecorder,
  MAX_FILES,
  mergeFiles,
  normalizePath,
  personOf,
  spendChanged,
  usageFor,
} from "./spend";
import { attributeSpend } from "./attribution";
import type { SpendData } from "./types";

const usage = (over: Partial<ipc.AgentSessionUsage> = {}): ipc.AgentSessionUsage => ({
  session_id: "s1",
  agent: "cli-a",
  profile: "default",
  cwd: "/repo",
  title: null,
  model: "sonnet-x",
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_tokens: 100,
  cache_creation_tokens: 0,
  cost: 1.25,
  turns: 3,
  updated: 0,
  supported: true,
  ...over,
});

const turn = (over: Partial<AgentTurnEnd> = {}): AgentTurnEnd => ({
  turnId: "s1:1000",
  ptyId: 7,
  sessionId: "s1",
  cli: "cli-a",
  cwd: "/repo",
  root: "/repo",
  filesTouched: ["/repo/src/a.ts", "src/b.ts"],
  startedAt: 1000,
  endedAt: 2000,
  ...over,
});

/** An in-memory ledger that honours supersession like the Rust store. */
function memoryLedger() {
  const rows: LedgerEntry[] = [];
  let n = 0;
  const append = vi.fn(async <D,>(root: string, d: LedgerDraft<D>) => {
    const e = { ...d, id: d.id ?? `e${++n}`, ts: d.ts ?? Date.now(), root } as LedgerEntry<D>;
    rows.push(e as LedgerEntry);
    return e;
  });
  const query = vi.fn(async <D,>(_root: string, q: { kinds?: string[]; refKind?: string; refId?: string; limit?: number }) => {
    const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
    return rows
      .filter((r) => !superseded.has(r.id))
      .filter((r) => !q.kinds || q.kinds.includes(r.kind))
      .filter((r) => !q.refKind || (r.ref?.kind === q.refKind && r.ref?.id === q.refId))
      .reverse()
      .slice(0, q.limit ?? 200) as LedgerEntry<D>[];
  });
  return { rows, append, query };
}

describe("spend records", () => {
  it("normalizes paths to the repo so worktrees compare equal", () => {
    expect(normalizePath("/repo/src/a.ts", "/repo", "/repo")).toBe("src/a.ts");
    expect(normalizePath("/wt/x/src/a.ts", "/repo", "/wt/x")).toBe("src/a.ts");
    expect(normalizePath("./src/a.ts", "/repo", "/repo")).toBe("src/a.ts");
  });

  it("merges files keeping the newest edit time and caps the list", () => {
    const merged = mergeFiles([{ path: "a", ts: 5 }], ["a", "b"], 10);
    expect(merged).toEqual([
      { path: "a", ts: 10 },
      { path: "b", ts: 10 },
    ]);
    const many = Array.from({ length: MAX_FILES + 20 }, (_, i) => `f${i}`);
    expect(mergeFiles([], many, 1)).toHaveLength(MAX_FILES);
  });

  it("builds a record from usage, plan and the previous record", () => {
    const s = buildSpend(turn(), usage(), null, { id: "plan-1", data: { class: "ui-feature" } });
    expect(s).toMatchObject({
      sessionId: "s1",
      cli: "cli-a",
      person: "You",
      costUsd: 1.25,
      costReported: true,
      inputTokens: 1100,
      outputTokens: 500,
      turns: 3,
      planId: "plan-1",
      taskClass: "ui-feature",
      firstTs: 1000,
      lastTs: 2000,
    });
    expect(s.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // A later empty usage read never rolls cost back.
    const later = buildSpend(turn({ endedAt: 3000, filesTouched: [] }), null, s, null);
    expect(later.costUsd).toBe(1.25);
    expect(later.planId).toBe("plan-1");
    expect(later.firstTs).toBe(1000);
  });

  it("attributes non-default accounts to the account", () => {
    expect(personOf("work")).toBe("work");
    expect(personOf("default")).toBe("You");
  });

  it("matches usage by session id only, never by cwd", () => {
    const rows = [usage({ session_id: "other" })];
    expect(usageFor(rows, "s1", "cli-a")).toBeNull();
    expect(usageFor([usage()], "s1", "cli-a")?.cost).toBe(1.25);
  });

  it("writes a spend entry, supersedes it on change and skips unchanged turns", async () => {
    const ledger = memoryLedger();
    ledger.rows.push({
      id: "plan-1",
      kind: "plan",
      ts: 1,
      root: "/repo",
      author: { kind: "brain", name: "plan" },
      scope: "project",
      ref: { kind: "session", id: "s1" },
      data: { class: "deps" },
    });
    let current = usage();
    const rec = createSpendRecorder({
      usage: async () => [current],
      append: ledger.append as never,
      query: ledger.query as never,
    });
    await rec.record(turn());
    expect(ledger.append).toHaveBeenCalledTimes(1);
    const first = ledger.append.mock.calls[0][1] as LedgerDraft<SpendData>;
    expect(first.kind).toBe("spend");
    expect(first.ref).toEqual({ kind: "session", id: "s1" });
    expect(first.data.planId).toBe("plan-1");
    expect(first.data.taskClass).toBe("deps");

    // Same numbers, same files: nothing written.
    await rec.record(turn({ filesTouched: [] }));
    expect(ledger.append).toHaveBeenCalledTimes(1);

    current = usage({ cost: 2.5, turns: 4 });
    await rec.record(turn({ endedAt: 5000, filesTouched: [] }));
    expect(ledger.append).toHaveBeenCalledTimes(2);
    const second = ledger.append.mock.calls[1][1] as LedgerDraft<SpendData>;
    expect(second.supersedes).toBe("e1");
    expect(second.data.costUsd).toBe(2.5);
    const heads = await ledger.query("/repo", { kinds: ["spend"] });
    expect(heads).toHaveLength(1);
  });

  it("detects meaningful changes only", () => {
    const a = buildSpend(turn(), usage(), null, null);
    expect(spendChanged(a, { ...a })).toBe(false);
    expect(spendChanged(a, { ...a, costUsd: a.costUsd + 0.01 })).toBe(true);
    expect(spendChanged(null, a)).toBe(true);
  });
});

describe("attribution joins", () => {
  const spend = (over: Partial<SpendData>): SpendData => ({
    type: "session",
    sessionId: "s",
    cli: "cli-a",
    profile: "default",
    person: "You",
    cwd: "/repo",
    costUsd: 1,
    costReported: true,
    inputTokens: 10,
    outputTokens: 5,
    turns: 1,
    model: null,
    files: [],
    firstTs: 100,
    lastTs: 100,
    ...over,
  });

  it("attributes session spend to plan, class, person and CLI, beside Canopy's brain spend", () => {
    const a = attributeSpend(
      [
        spend({ sessionId: "s1", costUsd: 3, planId: "p1", taskClass: "ui" }),
        spend({ sessionId: "s2", costUsd: 2, planId: "p1", taskClass: "ui", cli: "cli-b", costReported: false }),
        spend({ sessionId: "s3", costUsd: 1, person: "work" }),
        spend({ sessionId: "old", costUsd: 50, lastTs: 1 }),
      ],
      {
        sinceMs: 50,
        planTitles: new Map([["p1", "Redo settings"]]),
        cliName: (id) => id.toUpperCase(),
        brainByFeature: {
          review: { calls: 4, failures: 0, costUsd: 0.4, inputTokens: 0, outputTokens: 0 },
          outcomes: { calls: 1, failures: 0, costUsd: 0.05, inputTokens: 0, outputTokens: 0 },
        },
      },
    );
    expect(a.totalUsd).toBe(6);
    expect(a.byPlan[0]).toMatchObject({ key: "p1", label: "Redo settings", sessions: 2, costUsd: 5, estimated: true });
    expect(a.byPlan[1]).toMatchObject({ label: "No plan", costUsd: 1 });
    expect(a.byClass.map((c) => [c.key, c.costUsd])).toEqual([
      ["ui", 5],
      ["unplanned", 1],
    ]);
    expect(a.byPerson.map((p) => p.key)).toEqual(["You", "work"]);
    expect(a.byCli.find((c) => c.key === "cli-b")?.label).toBe("CLI-B");
    expect(a.canopy[0]).toEqual({ feature: "review", calls: 4, costUsd: 0.4 });
    expect(a.canopyUsd).toBeCloseTo(0.45);
  });
});

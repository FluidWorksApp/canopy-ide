import { describe, expect, it, vi } from "vitest";
import type { TurnList } from "./ipc";
import { pickTurnSnapshots, turnFileChanges } from "./turnDiff";

const list = (turns: Array<[number, string, string | null]>): TurnList => ({
  git: true,
  root: "/r",
  shared: false,
  peers: [],
  restores: [],
  turns: turns.map(([ts, start, end], n) => ({
    n,
    start: { ref: `s${n}`, commit: start, tree: "t", ts_ms: ts },
    end: end ? { ref: `e${n}`, commit: end, tree: "t", ts_ms: ts + 10 } : null,
    prompt: null,
    late: false,
    native_uuid: null,
  })),
});

describe("turn diff from rollback snapshots", () => {
  it("picks the snapshot pair closest to the turn's start", () => {
    const l = list([
      [1_000, "a", "b"],
      [50_000, "c", "d"],
    ]);
    expect(pickTurnSnapshots(l, 49_000, 60_000)).toEqual({ start: "c", end: "d" });
    expect(pickTurnSnapshots(l, 500_000, 600_000)).toBeNull();
    expect(pickTurnSnapshots({ ...l, git: false }, 49_000, 60_000)).toBeNull();
  });

  it("reports every change between the pair, shell-made ones included", async () => {
    const run = vi.fn(async (..._a: unknown[]) => ({
      code: 0,
      stdout: "M\tsrc/a.ts\nA\tdb/seed.sql\nD\tscripts/old.sh\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
      spawnError: null,
    }));
    const changes = await turnFileChanges(
      { cwd: "/r", sessionId: "s", startedAt: 1_000, endedAt: 2_000 },
      { turnList: async () => list([[1_000, "a", "b"]]), run: run as never },
    );
    expect(run.mock.calls[0][1]).toEqual(["git", "diff", "--name-status", "--no-renames", "a", "b"]);
    expect(changes).toEqual([
      { path: "src/a.ts", status: "modify" },
      { path: "db/seed.sql", status: "add" },
      { path: "scripts/old.sh", status: "delete" },
    ]);
    // No end snapshot yet: nothing to diff, the caller keeps the journal.
    expect(
      await turnFileChanges(
        { cwd: "/r", sessionId: "s", startedAt: 1_000, endedAt: 2_000 },
        { turnList: async () => list([[1_000, "a", null]]), run: run as never },
      ),
    ).toBeNull();
  });
});

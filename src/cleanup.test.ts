import { beforeEach, describe, expect, it } from "vitest";
import {
  bytesOf,
  countOf,
  defaultSelection,
  diskFill,
  fmtBytes,
  groupState,
  groupTargets,
  lastScan,
  lastScanNote,
  outcomeSummary,
  rememberScan,
  reclaimLabel,
  scanSummary,
  stateChips,
  toggleGroup,
  toggleTarget,
  workspaceLabel,
} from "./cleanup";
import type * as ipc from "./ipc";

const GB = 1024 ** 3;

const ws = (over: Partial<ipc.CleanupWorkspace> = {}): ipc.CleanupWorkspace => ({
  path: "/repo",
  name: "repo",
  branch: "main",
  main: true,
  dirty: 0,
  busy: false,
  asleep: false,
  idle_days: 5,
  landed: null,
  bytes: 0,
  recommended_bytes: 0,
  ...over,
});

const target = (over: Partial<ipc.CleanupTarget> = {}): ipc.CleanupTarget => ({
  path: "/repo/node_modules",
  name: "node_modules",
  rel: "node_modules",
  category: "deps",
  bytes: GB,
  files: 40_000,
  idle_days: 40,
  regenerate: "npm install",
  workspace: "/repo",
  recommended: true,
  hold: null,
  partial: false,
  ...over,
});

const scanOf = (
  workspaces: ipc.CleanupWorkspace[],
  targets: ipc.CleanupTarget[],
): ipc.CleanupScan => ({
  workspaces,
  targets,
  bytes: targets.reduce((n, t) => n + t.bytes, 0),
  recommended_bytes: targets.reduce((n, t) => (t.recommended ? n + t.bytes : n), 0),
  skipped: [],
  truncated: false,
});

describe("grouping", () => {
  it("puts the biggest opportunity first, and never reorders on selection", () => {
    const scan = scanOf(
      [
        ws({ path: "/a", name: "a", bytes: GB, recommended_bytes: 0 }),
        ws({ path: "/b", name: "b", bytes: GB, recommended_bytes: GB }),
      ],
      [
        target({ path: "/a/node_modules", workspace: "/a", recommended: false }),
        target({ path: "/b/node_modules", workspace: "/b" }),
      ],
    );
    expect(groupTargets(scan).map((g) => g.workspace.path)).toEqual(["/b", "/a"]);
    // The order is a property of the scan: ticking or unticking changes nothing.
    expect(groupTargets(scan).map((g) => g.workspace.path)).toEqual(["/b", "/a"]);
  });

  it("drops a workspace with nothing to reclaim", () => {
    const scan = scanOf(
      [ws({ path: "/a" }), ws({ path: "/empty" })],
      [target({ workspace: "/a", path: "/a/node_modules" })],
    );
    expect(groupTargets(scan).map((g) => g.workspace.path)).toEqual(["/a"]);
  });
});

describe("selection", () => {
  const scan = scanOf(
    [ws({ path: "/a" })],
    [
      target({ path: "/a/node_modules", workspace: "/a", bytes: 2 * GB }),
      target({
        path: "/a/target",
        workspace: "/a",
        name: "target",
        rel: "target",
        category: "build",
        bytes: GB,
        recommended: false,
        hold: "3 uncommitted files here",
      }),
    ],
  );

  it("starts at exactly what Rust recommended", () => {
    expect([...defaultSelection(scan)]).toEqual(["/a/node_modules"]);
  });

  it("counts and totals only what is ticked", () => {
    const sel = defaultSelection(scan);
    expect(countOf(scan.targets, sel)).toBe(1);
    expect(bytesOf(scan.targets, sel)).toBe(2 * GB);
  });

  it("toggles one row without touching the rest", () => {
    const sel = toggleTarget("/a/target", defaultSelection(scan));
    expect(bytesOf(scan.targets, sel)).toBe(3 * GB);
    expect(bytesOf(scan.targets, toggleTarget("/a/target", sel))).toBe(2 * GB);
  });

  it("fills a partly-ticked group and empties a full one", () => {
    const [group] = groupTargets(scan);
    expect(groupState(group, defaultSelection(scan))).toBe("some");
    const all = toggleGroup(group, defaultSelection(scan));
    expect(groupState(group, all)).toBe("all");
    const none = toggleGroup(group, all);
    expect(groupState(group, none)).toBe("none");
  });
});

describe("what the workspace row says", () => {
  it("names the branch, falling back to the folder", () => {
    expect(workspaceLabel(ws({ branch: "feat/x" }))).toBe("feat/x");
    expect(workspaceLabel(ws({ branch: null, name: "detached-pr" }))).toBe(
      "detached-pr",
    );
  });

  it("shows every reason it is being held, hibernation included", () => {
    const chips = stateChips(
      ws({ busy: true, asleep: true, dirty: 2, main: false, idle_days: 12 }),
    );
    expect(chips.map((c) => c.label)).toEqual([
      "in use",
      "hibernating",
      "±2 uncommitted",
      "idle 12d",
    ]);
    expect(chips.filter((c) => c.tone === "hold").map((c) => c.label)).toEqual([
      "in use",
      "hibernating",
      "±2 uncommitted",
    ]);
  });

  it("says the work is done, which is why a two-day-old branch is offered", () => {
    const chips = stateChips(
      ws({
        main: false,
        idle_days: 2,
        landed: "already merged into origin/main",
      }),
    );
    expect(chips.map((c) => c.label)).toEqual(["done", "idle 2d"]);
    expect(chips[0].tone).toBe("done");
  });

  it("says nothing about idleness for a folder with no history", () => {
    expect(stateChips(ws({ idle_days: null, main: false })).map((c) => c.label)).toEqual(
      [],
    );
  });
});

describe("wording", () => {
  it("scales the unit to the number", () => {
    expect(fmtBytes(2 * GB)).toBe("2.0 GB");
    expect(fmtBytes(40 * 1024 * 1024)).toBe("40 MB");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(12)).toBe("12 B");
  });

  it("puts the consequence in the button", () => {
    expect(reclaimLabel(2 * GB, true)).toBe("Move 2.0 GB to Trash");
    expect(reclaimLabel(2 * GB, false)).toBe("Delete 2.0 GB");
    expect(reclaimLabel(0, true)).toBe("Move to Trash");
  });

  it("says where the space went, and that the Trash still holds it", () => {
    const base = { failed: [], refused: [] } as Pick<
      ipc.CleanupOutcome,
      "failed" | "refused"
    >;
    expect(
      outcomeSummary({ ...base, removed: ["/a"], bytes: GB, trashed: true }),
    ).toContain("back when you empty it");
    expect(
      outcomeSummary({ ...base, removed: ["/a", "/b"], bytes: GB, trashed: false }),
    ).toBe("Deleted 2 directories — 1.0 GB reclaimed.");
  });

  it("never hides a failure inside a success", () => {
    const line = outcomeSummary({
      removed: ["/a"],
      bytes: GB,
      failed: [["/b", "permission denied"]],
      refused: ["/c — not something a build can make again"],
      trashed: false,
    });
    expect(line).toContain("1 couldn't be removed");
    expect(line).toContain("1 refused");
  });

  it("admits when the scan gave up early", () => {
    const scan = scanOf([ws({ bytes: GB })], [target()]);
    expect(scanSummary(scan)).toBe("1.0 GB across 1 workspace; 1.0 GB of it looks idle.");
    expect(scanSummary({ ...scan, truncated: true })).toContain("stopped early");
    expect(scanSummary(scanOf([], []))).toContain("Nothing to reclaim");
  });
});

describe("disk", () => {
  it("turns free space into a bar, and shouts only when it matters", () => {
    expect(diskFill({ mount: "/", label: "d", total_bytes: 100, free_bytes: 50 })).toEqual(
      { pct: 50, tone: "normal" },
    );
    expect(
      diskFill({ mount: "/", label: "d", total_bytes: 100, free_bytes: 10 }).tone,
    ).toBe("warn");
    expect(
      diskFill({ mount: "/", label: "d", total_bytes: 100, free_bytes: 2 }).tone,
    ).toBe("critical");
    // An unreadable volume reports zero total; that is 0%, not NaN.
    expect(
      diskFill({ mount: "/", label: "d", total_bytes: 0, free_bytes: 0 }).pct,
    ).toBe(0);
  });
});

describe("the last scan", () => {
  beforeEach(() => localStorage.clear());

  it("is remembered with its age, and shown with it", () => {
    const scan = scanOf([ws()], [target({ bytes: 2 * GB })]);
    const at = 1_700_000_000_000;
    rememberScan(scan, at);
    const held = lastScan();
    expect(held).toEqual({ bytes: 2 * GB, recommendedBytes: 2 * GB, at });
    expect(lastScanNote(held, at + 3 * 3_600_000)).toBe("2.0 GB idle of 2.0 GB · 3h ago");
    expect(lastScanNote(held, at + 30_000)).toContain("just now");
  });

  it("ages out rather than showing a figure nobody would trust", () => {
    const at = 1_700_000_000_000;
    rememberScan(scanOf([ws()], [target()]), at);
    expect(lastScanNote(lastScan(), at + 6 * 86_400_000)).toContain("6d ago");
    expect(lastScanNote(lastScan(), at + 8 * 86_400_000)).toBeNull();
  });

  it("says so when there was nothing to reclaim", () => {
    const at = 1_700_000_000_000;
    rememberScan(scanOf([], []), at);
    expect(lastScanNote(lastScan(), at)).toBe("nothing to reclaim · just now");
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("canopy.cleanup.lastScan.v1", "{oops");
    expect(lastScan()).toBeNull();
    expect(lastScanNote(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  LANE_ORDER,
  allRows,
  applySnapshot,
  laneOf,
  lanes,
  needsYouCount,
  prContextActions,
  prMergeReady,
  prQuickTask,
  rowChanged,
  rowState,
  since,
  sortRows,
  toPrInfo,
} from "./prInbox";
import type * as ipc from "./ipc";

const row = (over: Partial<ipc.PrRow> = {}): ipc.PrRow => ({
  repo: "/repo",
  nwo: "o/r",
  number: 1,
  title: "Tighten the parser",
  author: "alice",
  url: "https://github.com/o/r/pull/1",
  branch: "fix",
  base: "main",
  draft: false,
  created: "2026-07-01T09:00:00Z",
  updated: "2026-07-01T09:00:00Z",
  additions: 10,
  deletions: 2,
  mergeable: "MERGEABLE",
  review_decision: "",
  checks: "PASS",
  comments: 0,
  threads: 0,
  requested_from_me: false,
  mine: false,
  ...over,
});

describe("laneOf", () => {
  it("puts anything asked of you first, whoever wrote it", () => {
    expect(laneOf(row({ requested_from_me: true }))).toBe("needs-you");
    // Your own PR with changes requested is equally "you are the hold-up".
    expect(laneOf(row({ mine: true, review_decision: "CHANGES_REQUESTED" }))).toBe("needs-you");
  });

  it("calls your own broken or conflicting PR blocked, not waiting", () => {
    expect(laneOf(row({ mine: true, checks: "FAIL" }))).toBe("blocked");
    expect(laneOf(row({ mine: true, mergeable: "CONFLICTING" }))).toBe("blocked");
    // Someone else's broken PR isn't your problem to unblock.
    expect(laneOf(row({ mine: false, checks: "FAIL" }))).toBe("waiting");
  });

  it("only calls it ready when GitHub says approved, green and mergeable", () => {
    expect(laneOf(row({ review_decision: "APPROVED" }))).toBe("ready");
    expect(laneOf(row({ review_decision: "APPROVED", checks: "FAIL" }))).toBe("waiting");
    expect(laneOf(row({ review_decision: "APPROVED", mergeable: "CONFLICTING" }))).toBe("waiting");
  });

  it("keeps drafts out of every other lane, however alarming they look", () => {
    expect(laneOf(row({ draft: true, checks: "FAIL", mine: true, requested_from_me: true }))).toBe(
      "draft",
    );
  });

  it("assigns exactly one lane to every row", () => {
    const rows = [
      row({ requested_from_me: true }),
      row({ mine: true, checks: "FAIL" }),
      row({ review_decision: "APPROVED" }),
      row({ draft: true }),
      row(),
    ];
    const grouped = lanes(rows);
    expect(grouped.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
    // Lanes come back in the fixed display order, with empties dropped.
    const order = grouped.map((g) => g.lane);
    expect(order).toEqual(LANE_ORDER.filter((l) => order.includes(l)));
  });
});

describe("needsYouCount", () => {
  it("counts only what is actually waiting on you", () => {
    expect(
      needsYouCount([
        row({ requested_from_me: true }),
        row({ mine: true, review_decision: "CHANGES_REQUESTED" }),
        row({ draft: true, requested_from_me: true }),
        row({ review_decision: "APPROVED" }),
        row(),
      ]),
    ).toBe(2);
  });
});

describe("sortRows", () => {
  it("puts your own first, then the most recently touched", () => {
    const rows = [
      row({ number: 1, updated: "2026-07-01T00:00:00Z" }),
      row({ number: 2, updated: "2026-07-03T00:00:00Z" }),
      row({ number: 3, mine: true, updated: "2026-07-02T00:00:00Z" }),
    ];
    expect(sortRows(rows).map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it("is stable on identical timestamps, so the list doesn't shuffle on refresh", () => {
    const rows = [row({ number: 9 }), row({ number: 4 })];
    expect(sortRows(rows).map((r) => r.number)).toEqual([4, 9]);
  });
});

describe("rowState", () => {
  it("shows one thing, worst first", () => {
    expect(rowState(row({ mergeable: "CONFLICTING", checks: "FAIL" })).text).toBe("conflicts");
    expect(rowState(row({ checks: "FAIL", review_decision: "APPROVED" })).text).toBe("checks failed");
    expect(rowState(row({ requested_from_me: true })).tone).toBe("warn");
    expect(rowState(row({ review_decision: "APPROVED" })).tone).toBe("ok");
    expect(rowState(row({ draft: true, checks: "FAIL" })).text).toBe("draft");
    expect(rowState(row()).text).toBe("open");
  });
});

describe("prQuickTask", () => {
  it("offers the task that unblocks the row, in blocking order", () => {
    expect(prQuickTask(row({ mergeable: "CONFLICTING", checks: "FAIL" }))).toEqual({
      id: "resolve-conflicts",
      label: "Resolve conflicts",
    });
    expect(prQuickTask(row({ checks: "FAIL" }))).toEqual({ id: "fix-ci", label: "Fix CI" });
    expect(prQuickTask(row({ mine: true, review_decision: "CHANGES_REQUESTED" }))).toEqual({
      id: "address",
      label: "Address comments",
    });
    expect(
      prQuickTask(row({ requested_from_me: true, review_decision: "CHANGES_REQUESTED" })),
    ).toEqual({ id: "review", label: "Review" });
    expect(prQuickTask(row())).toEqual({ id: "review", label: "Review" });
  });

  it("does not offer a mutating task for someone else's requested changes or merge", () => {
    expect(prQuickTask(row({ review_decision: "CHANGES_REQUESTED" }))).toBeNull();
    expect(prQuickTask(row({ review_decision: "APPROVED" }))).toBeNull();
  });
});

describe("applySnapshot", () => {
  it("replaces a repo wholesale — a snapshot is that repo's whole truth", () => {
    let map = new Map<string, ipc.PrRow[]>();
    map = applySnapshot(map, {
      repo: "/a",
      nwo: "o/a",
      viewer: "me",
      fetched_ms: 1,
      rows: [row({ repo: "/a", number: 1 }), row({ repo: "/a", number: 2 })],
    });
    map = applySnapshot(map, {
      repo: "/b",
      nwo: "o/b",
      viewer: "me",
      fetched_ms: 2,
      rows: [row({ repo: "/b", number: 7 })],
    });
    // A PR that closed is simply absent from its repo's next snapshot.
    map = applySnapshot(map, {
      repo: "/a",
      nwo: "o/a",
      viewer: "me",
      fetched_ms: 3,
      rows: [row({ repo: "/a", number: 2 })],
    });
    expect(allRows(map).map((r) => `${r.repo}#${r.number}`)).toEqual(["/a#2", "/b#7"]);
  });

  it("does not mutate the map it was given", () => {
    const before = new Map<string, ipc.PrRow[]>([["/a", [row()]]]);
    applySnapshot(before, { repo: "/b", nwo: "o/b", viewer: "me", fetched_ms: 1, rows: [] });
    expect(before.has("/b")).toBe(false);
  });
});

describe("rowChanged", () => {
  it("fires on a new row and on a moved updatedAt, not on an identical one", () => {
    const a = row({ updated: "2026-07-01T00:00:00Z" });
    expect(rowChanged(undefined, a)).toBe(true);
    expect(rowChanged(a, a)).toBe(false);
    expect(rowChanged(a, row({ updated: "2026-07-02T00:00:00Z" }))).toBe(true);
    expect(rowChanged(a, undefined)).toBe(false);
  });
});

describe("since", () => {
  const now = Date.parse("2026-07-01T12:00:00Z");
  it("reads as a human would say it", () => {
    expect(since(0, now)).toBe("never");
    expect(since(now - 3_000, now)).toBe("just now");
    expect(since(now - 30_000, now)).toBe("30s ago");
    expect(since(now - 5 * 60_000, now)).toBe("5m ago");
    expect(since(now - 3 * 3600_000, now)).toBe("3h ago");
  });
});

describe("prContextActions", () => {
  it("offers each action the row's state calls for, most urgent first", () => {
    expect(
      prContextActions(
        row({ mine: true, mergeable: "CONFLICTING", checks: "FAIL", review_decision: "CHANGES_REQUESTED" }),
      ).map((a) => a.id),
    ).toEqual(["resolve-conflicts", "fix-ci", "address"]);
  });

  it("offers a review while the PR is still unreviewed or asked of you", () => {
    expect(prContextActions(row()).map((a) => a.id)).toEqual(["review"]);
    expect(prContextActions(row({ requested_from_me: true, review_decision: "REVIEW_REQUIRED" })).map((a) => a.id)).toEqual(["review"]);
    // Approved and clean: nothing left for an agent — merging is the human's.
    expect(prContextActions(row({ review_decision: "APPROVED" }))).toEqual([]);
  });

  it("offers addressing comments only on your own PR with something to answer", () => {
    expect(prContextActions(row({ mine: true, threads: 2, review_decision: "APPROVED" })).map((a) => a.id)).toEqual(["address"]);
    // Someone else's comments are not yours to address.
    expect(prContextActions(row({ mine: false, threads: 2, review_decision: "APPROVED" }))).toEqual([]);
  });
});

describe("prMergeReady", () => {
  it("mirrors the ready lane: approved, green, mergeable, not a draft", () => {
    expect(prMergeReady(row({ review_decision: "APPROVED" }))).toBe(true);
    expect(prMergeReady(row({ review_decision: "APPROVED", checks: "FAIL" }))).toBe(false);
    expect(prMergeReady(row({ review_decision: "APPROVED", mergeable: "CONFLICTING" }))).toBe(false);
    expect(prMergeReady(row({ review_decision: "APPROVED", draft: true }))).toBe(false);
    expect(prMergeReady(row())).toBe(false);
  });
});

describe("toPrInfo", () => {
  it("hands the detail tab everything it needs without another call", () => {
    const pr = toPrInfo(row({ number: 12, mine: true, review_decision: "APPROVED" }));
    expect(pr).toMatchObject({
      number: 12,
      state: "OPEN",
      mine: true,
      review_decision: "APPROVED",
      branch: "fix",
      base: "main",
    });
    // The one thing the batched query doesn't carry; the tab fetches it live.
    expect(pr.checks_summary).toBe("");
  });
});

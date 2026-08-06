import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ROUNDS,
  ROUND_STALE_MS,
  beginRound,
  failRoundLaunch,
  emptyLoop,
  finishRound,
  forgetLoop,
  isLandable,
  isRoundStale,
  loadLoop,
  loopKey,
  markDone,
  markReady,
  newSinceHandled,
  resetLoop,
  roundGate,
  saveLoop,
  takeUnnoticed,
} from "./prLoop";
import type * as ipc from "./ipc";

const thread = (id: string, over: Partial<ipc.PrThread> = {}): ipc.PrThread => ({
  id,
  path: "src/a.ts",
  line: 3,
  start_line: 0,
  side: "RIGHT",
  resolved: false,
  outdated: false,
  comments: [
    {
      id: `${id}-c`,
      author: "alice",
      body: "this leaks",
      created: "2026-07-01T10:00:00Z",
      url: "u",
      mine: false,
      association: "COLLABORATOR",
    },
  ],
  ...over,
});

const conv = (over: Partial<ipc.PrConversation> = {}): ipc.PrConversation => ({
  node_id: "PR_1",
  body: "",
  head_sha: "head1",
  viewer: "me",
  review_decision: "",
  mergeable: "MERGEABLE",
  state: "OPEN",
  checks: "PASS",
  auto_merge: false,
  draft: false,
  comments: [],
  reviews: [],
  threads: [],
  files: [],
  my_last_review_sha: "",
  ...over,
});

const pr = (over: Partial<ipc.PrInfo> = {}): ipc.PrInfo => ({
  number: 7,
  title: "t",
  author: "me",
  branch: "b",
  base: "main",
  draft: false,
  state: "OPEN",
  url: "https://github.com/o/r/pull/7",
  created: "",
  updated: "",
  review_decision: "",
  additions: 1,
  deletions: 1,
  mine: true,
  mergeable: "MERGEABLE",
  checks: "PASS",
  checks_summary: "",
  ...over,
});

describe("rounds", () => {
  it("marks comments handled the moment a round starts", () => {
    // Up front, not on completion: an agent that dies mid-round must not cause
    // the same comments to be addressed twice.
    const l = beginRound(
      emptyLoop("/repo", 7),
      ["T_1", "C_2"],
      "head1",
      { runId: "run-1", attemptId: "attempt-1" },
    );
    expect(l.status).toBe("working");
    expect(l.cycle).toBe(1);
    expect(l.handled).toEqual(["T_1", "C_2"]);
    expect(l.rounds).toHaveLength(1);
    expect(l.rounds[0].headSha).toBe("head1");
    expect(l.rounds[0]).toMatchObject({
      runId: "run-1",
      attemptId: "attempt-1",
      ids: ["T_1", "C_2"],
    });
  });

  it("returns comments when a reserved round never launches", () => {
    const running = beginRound(emptyLoop("/repo", 7), ["T_1"], "head1", {
      runId: "run-1",
      attemptId: "attempt-1",
    });
    const next = failRoundLaunch(running, "attempt-1");
    expect(next.status).toBe("waiting");
    expect(next.handled).toEqual([]);
    expect(next.rounds[0].status).toBe("stopped");
  });

  it("goes back to waiting when a round pushes", () => {
    const l = finishRound(beginRound(emptyLoop("/repo", 7), ["T_1"], "head1"), "done", "1 addressed", true);
    expect(l.status).toBe("waiting");
    expect(l.noPush).toBe(0);
    expect(l.rounds[0].summary).toBe("1 addressed");
  });

  it("blocks when the agent reports blocked, keeping its words", () => {
    const l = finishRound(
      beginRound(emptyLoop("/repo", 7), ["T_1"], "head1"),
      "blocked",
      "need a decision on the API shape",
      false,
    );
    expect(l.status).toBe("blocked");
    expect(l.blockedReason).toContain("API shape");
  });

  it("stops after two rounds that changed no code — that is a disagreement", () => {
    let l = emptyLoop("/repo", 7);
    l = finishRound(beginRound(l, ["T_1"], "head1"), "done", "replied", false);
    expect(l.status).toBe("waiting");
    l = finishRound(beginRound(l, ["T_2"], "head1"), "done", "replied again", false);
    expect(l.status).toBe("blocked");
    expect(l.blockedReason).toContain("no code");
  });

  it("stops at the round cap even when everything else looks fine", () => {
    let l = emptyLoop("/repo", 7);
    for (let i = 0; i < MAX_ROUNDS; i++) {
      l = finishRound(beginRound(l, [`T_${i}`], `head${i}`), "done", "done", true);
    }
    expect(l.cycle).toBe(MAX_ROUNDS);
    expect(l.status).toBe("blocked");
    expect(l.blockedReason).toContain("rounds");
  });

  it("treats a round whose agent went quiet as needing a person", () => {
    const l = beginRound(emptyLoop("/repo", 7), ["T_1"], "head1");
    expect(isRoundStale(l)).toBe(false);
    expect(isRoundStale(l, Date.now() + ROUND_STALE_MS + 1)).toBe(true);
    // Only ever a working round: a waiting loop is meant to sit there.
    expect(isRoundStale({ ...l, status: "waiting" }, Date.now() + ROUND_STALE_MS + 1)).toBe(false);
  });
});

describe("newSinceHandled", () => {
  it("is driven by ids, never by timestamps", () => {
    const l = beginRound(emptyLoop("/repo", 7), ["T_1"], "head1");
    const c = conv({ threads: [thread("T_1"), thread("T_2")] });
    // T_1 was handled; only the genuinely new thread counts, even though our own
    // push moved the PR's updatedAt in between.
    expect(newSinceHandled(c, l)).toEqual(["T_2"]);
  });

  it("returns nothing when the only comments are ones we already took", () => {
    const l = beginRound(emptyLoop("/repo", 7), ["T_1"], "head1");
    expect(newSinceHandled(conv({ threads: [thread("T_1")] }), l)).toEqual([]);
  });
});

describe("takeUnnoticed", () => {
  it("announces each actionable comment only once without marking it handled", () => {
    const noticed = new Set<string>();
    const first = conv({ threads: [thread("T_1")] });

    expect(takeUnnoticed(first, noticed)).toEqual(["T_1"]);
    expect(takeUnnoticed(first, noticed)).toEqual([]);
    expect(takeUnnoticed(conv({ threads: [thread("T_1"), thread("T_2")] }), noticed)).toEqual([
      "T_2",
    ]);
    expect(newSinceHandled(first, emptyLoop("/repo", 7))).toEqual(["T_1"]);
  });
});

describe("roundGate", () => {
  it("refuses to address comments on a failing build", () => {
    const g = roundGate(pr(), conv({ checks: "FAIL", threads: [thread("T_1")] }), emptyLoop("/repo", 7));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("checks are failing");
  });

  it("refuses while the branch conflicts", () => {
    const g = roundGate(
      pr(),
      conv({ mergeable: "CONFLICTING", threads: [thread("T_1")] }),
      emptyLoop("/repo", 7),
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("conflicts");
  });

  it("refuses when there is nothing new to address", () => {
    expect(roundGate(pr(), conv(), emptyLoop("/repo", 7)).reason).toBe("no comments to address");
  });

  it("refuses while a round is already running", () => {
    const l = beginRound(emptyLoop("/repo", 7), ["T_1"], "head1");
    const g = roundGate(pr(), conv({ threads: [thread("T_2")] }), l);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("already running");
  });

  it("refuses on a closed PR", () => {
    const g = roundGate(pr({ state: "MERGED" }), conv({ threads: [thread("T_1")] }), emptyLoop("/repo", 7));
    expect(g.ok).toBe(false);
  });

  it("opens with the ids to hand over when everything is in order", () => {
    const g = roundGate(pr(), conv({ threads: [thread("T_1")] }), emptyLoop("/repo", 7));
    expect(g).toMatchObject({ ok: true, ids: ["T_1"] });
  });
});

describe("isLandable", () => {
  it("is GitHub's verdict, not ours", () => {
    expect(isLandable(conv({ review_decision: "APPROVED" }))).toBe(true);
    expect(isLandable(conv({ review_decision: "APPROVED", checks: "FAIL" }))).toBe(false);
    expect(isLandable(conv({ review_decision: "APPROVED", mergeable: "CONFLICTING" }))).toBe(false);
    expect(isLandable(conv({ review_decision: "CHANGES_REQUESTED" }))).toBe(false);
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("survives a reload, keyed by repo and number", () => {
    const l = saveLoop(beginRound(emptyLoop("/repo", 7), ["T_1"], "head1"));
    expect(l.key).toBe(loopKey("/repo", 7));
    const back = loadLoop("/repo", 7);
    expect(back.cycle).toBe(1);
    expect(back.handled).toEqual(["T_1"]);
    // A different PR is a different loop.
    expect(loadLoop("/repo", 8).cycle).toBe(0);
  });

  it("forgets on request and hands back a fresh loop", () => {
    saveLoop(beginRound(emptyLoop("/repo", 7), ["T_1"], "head1"));
    forgetLoop("/repo", 7);
    expect(loadLoop("/repo", 7).status).toBe("idle");
  });

  it("survives corrupt storage rather than taking the tab down with it", () => {
    localStorage.setItem("canopy.prLoops", "{not json");
    expect(loadLoop("/repo", 7).status).toBe("idle");
  });

  it("keeps the auto-merge choice through a reset but drops the rounds", () => {
    const l = { ...beginRound(emptyLoop("/repo", 7), ["T_1"], "h"), autoMerge: true };
    const fresh = resetLoop(l);
    expect(fresh.autoMerge).toBe(true);
    expect(fresh.rounds).toEqual([]);
    expect(fresh.handled).toEqual([]);
  });

  it("marks ready and done without inventing a merge", () => {
    expect(markReady(emptyLoop("/repo", 7)).status).toBe("ready");
    expect(markDone(emptyLoop("/repo", 7)).status).toBe("done");
  });
});

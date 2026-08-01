import { describe, expect, it } from "vitest";
import {
  DOC_STACKS,
  STATUS_ORDER,
  docStackFor,
  sameGroups,
  settleGroups,
  shownInStack,
  targetsKey,
  type Settled,
  type TabStatus,
} from "./tabGroups";

const prev = (entries: Record<string, Settled>) => new Map(Object.entries(entries));
const want = (entries: Record<string, TabStatus>) => new Map(Object.entries(entries));
const plain = (m: Map<string, Settled>) =>
  Object.fromEntries([...m].map(([id, s]) => [id, s.group]));

describe("settleGroups", () => {
  const DELAY = 60_000;

  it("adopts the raw status for a tab it has never seen", () => {
    const { groups, wake } = settleGroups(new Map(), want({ a: "quiet", b: "active" }), 0, DELAY);
    expect(plain(groups)).toEqual({ a: "quiet", b: "active" });
    expect(wake).toBeNull();
  });

  it("promotes to attention immediately, with no settling", () => {
    const { groups } = settleGroups(
      prev({ a: { group: "quiet" }, b: { group: "active" } }),
      want({ a: "attention", b: "attention" }),
      0,
      DELAY,
    );
    expect(plain(groups)).toEqual({ a: "attention", b: "attention" });
  });

  it("holds a tab in place until it has been quiet for the whole delay", () => {
    let state = prev({ a: { group: "active" } });
    const targets = want({ a: "quiet" });

    ({ groups: state } = settleGroups(state, targets, 1_000, DELAY));
    expect(plain(state)).toEqual({ a: "active" });

    ({ groups: state } = settleGroups(state, targets, 1_000 + DELAY - 1, DELAY));
    expect(plain(state)).toEqual({ a: "active" });

    ({ groups: state } = settleGroups(state, targets, 1_000 + DELAY, DELAY));
    expect(plain(state)).toEqual({ a: "quiet" });
  });

  it("reports when a pending fall is due, so a caller can wake for it", () => {
    const { groups, wake } = settleGroups(
      prev({ a: { group: "active" }, b: { group: "attention" } }),
      want({ a: "quiet", b: "quiet" }),
      500,
      DELAY,
    );
    expect(wake).toBe(500 + DELAY);
    expect(groups.get("a")?.pendingSince).toBe(500);
  });

  it("restarts the clock when work resumes mid-fall", () => {
    let state = prev({ a: { group: "active" } });
    ({ groups: state } = settleGroups(state, want({ a: "quiet" }), 0, DELAY));
    expect(state.get("a")?.pendingSince).toBe(0);

    // A burst of work: back to active outright, and the pending fall is gone.
    ({ groups: state } = settleGroups(state, want({ a: "active" }), 30_000, DELAY));
    expect(state.get("a")?.pendingSince).toBeUndefined();

    // Quiet again — the delay is measured from here, not from the first dip.
    ({ groups: state } = settleGroups(state, want({ a: "quiet" }), 31_000, DELAY));
    expect(plain(state)).toEqual({ a: "active" });
    ({ groups: state } = settleGroups(state, want({ a: "quiet" }), 31_000 + DELAY, DELAY));
    expect(plain(state)).toEqual({ a: "quiet" });
  });

  it("settles instantly when the delay is off", () => {
    const { groups, wake } = settleGroups(prev({ a: { group: "active" } }), want({ a: "quiet" }), 0, 0);
    expect(plain(groups)).toEqual({ a: "quiet" });
    expect(wake).toBeNull();
  });

  it("drops tabs that have closed", () => {
    const { groups } = settleGroups(
      prev({ a: { group: "quiet" }, b: { group: "active" } }),
      want({ b: "active" }),
      0,
      DELAY,
    );
    expect([...groups.keys()]).toEqual(["b"]);
  });

  it("keeps a tab already in idle there without inventing a fall", () => {
    const { groups, wake } = settleGroups(prev({ a: { group: "quiet" } }), want({ a: "quiet" }), 9, DELAY);
    expect(plain(groups)).toEqual({ a: "quiet" });
    expect(wake).toBeNull();
  });

  describe("holds", () => {
    it("moves nothing while the pointer is in the strip — not even a promotion", () => {
      const { groups, wake } = settleGroups(
        prev({ a: { group: "quiet" }, b: { group: "active" } }),
        want({ a: "attention", b: "quiet" }),
        0,
        DELAY,
        { frozen: true },
      );
      expect(plain(groups)).toEqual({ a: "quiet", b: "active" });
      // And no timer either: nothing can land while the hold is on, and the
      // caller re-runs the moment it lifts.
      expect(wake).toBeNull();
    });

    it("lands everything that came due at once when the pointer leaves", () => {
      // Two tabs mid-fall, frozen well past their due time. Letting go is one
      // event, not two — which is the only way a move reads as explaining
      // something rather than as the strip twitching.
      let state = prev({ a: { group: "active", pendingSince: 0 }, b: { group: "active", pendingSince: 0 } });
      const targets = want({ a: "quiet", b: "quiet" });
      ({ groups: state } = settleGroups(state, targets, DELAY * 3, DELAY, { frozen: true }));
      expect(plain(state)).toEqual({ a: "active", b: "active" });
      ({ groups: state } = settleGroups(state, targets, DELAY * 3, DELAY));
      expect(plain(state)).toEqual({ a: "quiet", b: "quiet" });
    });

    it("never moves the tab you are looking at, and moves the others", () => {
      const { groups } = settleGroups(
        prev({ a: { group: "active" }, b: { group: "active" } }),
        want({ a: "attention", b: "attention" }),
        0,
        DELAY,
        { hold: "a" },
      );
      expect(plain(groups)).toEqual({ a: "active", b: "attention" });
    });

    it("settles the held tab as soon as you go somewhere else", () => {
      let state = prev({ a: { group: "active" } });
      const targets = want({ a: "attention" });
      ({ groups: state } = settleGroups(state, targets, 0, DELAY, { hold: "a" }));
      expect(plain(state)).toEqual({ a: "active" });
      ({ groups: state } = settleGroups(state, targets, 10, DELAY, { hold: "b" }));
      expect(plain(state)).toEqual({ a: "attention" });
    });

    it("still places a tab it has never seen — there is no place to hold", () => {
      const { groups } = settleGroups(new Map(), want({ a: "attention" }), 0, DELAY, {
        frozen: true,
        hold: "a",
      });
      expect(plain(groups)).toEqual({ a: "attention" });
    });

    it("keeps an inferred fall held forever while you look at the tab", () => {
      // The behaviour the proven exception does NOT change: a CPU dip on the
      // tab you are reading never moves it, however long it holds.
      let state = prev({ a: { group: "active" } });
      const targets = want({ a: "quiet" });
      ({ groups: state } = settleGroups(state, targets, DELAY * 10, DELAY, { hold: "a" }));
      expect(plain(state)).toEqual({ a: "active" });
    });
  });

  describe("proven falls", () => {
    const PROVEN = 5_000;
    const opts = { proven: new Set(["a"]), provenDelayMs: PROVEN };

    it("lands through the active-tab hold once the short delay elapses", () => {
      // The CLI said the turn ended. The dot — which is never held — already
      // says idle; the chip saying Working past the proven delay is the chip
      // lying about state to preserve position.
      let state = prev({ a: { group: "active" } });
      const targets = want({ a: "quiet" });
      ({ groups: state } = settleGroups(state, targets, 0, DELAY, { ...opts, hold: "a" }));
      expect(plain(state)).toEqual({ a: "active" });
      expect(state.get("a")?.pendingSince).toBe(0);
      ({ groups: state } = settleGroups(state, targets, PROVEN, DELAY, { ...opts, hold: "a" }));
      expect(plain(state)).toEqual({ a: "quiet" });
    });

    it("schedules the wake on the short clock, not the settling window", () => {
      const { wake } = settleGroups(
        prev({ a: { group: "active" } }),
        want({ a: "quiet" }),
        100,
        DELAY,
        { ...opts, hold: "a" },
      );
      expect(wake).toBe(100 + PROVEN);
    });

    it("never moves under the pointer, proven or not", () => {
      const { groups, wake } = settleGroups(
        prev({ a: { group: "active", pendingSince: 0 } }),
        want({ a: "quiet" }),
        PROVEN * 10,
        DELAY,
        { ...opts, frozen: true },
      );
      expect(plain(groups)).toEqual({ a: "active" });
      expect(wake).toBeNull();
    });

    it("does not shortcut a proven promotion — only falls are dampened at all", () => {
      const { groups } = settleGroups(
        prev({ a: { group: "quiet" } }),
        want({ a: "active" }),
        0,
        DELAY,
        opts,
      );
      expect(plain(groups)).toEqual({ a: "active" });
    });

    it("is capped by the settling window, so instant stays instant", () => {
      // delayMs 0 means the user asked for no dampening; a proven fall must
      // not be slower than an inferred one.
      const { groups } = settleGroups(
        prev({ a: { group: "active" } }),
        want({ a: "quiet" }),
        0,
        0,
        opts,
      );
      expect(plain(groups)).toEqual({ a: "quiet" });
    });

    it("leaves other tabs' inferred falls on the long clock", () => {
      const { groups, wake } = settleGroups(
        prev({ a: { group: "active" }, b: { group: "active" } }),
        want({ a: "quiet", b: "quiet" }),
        0,
        DELAY,
        opts,
      );
      expect(plain(groups)).toEqual({ a: "active", b: "active" });
      // The earliest due is a's proven fall; b is due a full window later.
      expect(wake).toBe(PROVEN);
    });
  });
});

describe("run order", () => {
  it("is the priority order, always — the strip is read by position", () => {
    // A chip that has queued up on the left is down to its colour, its count
    // and where it sits. Two of those three are only worth anything if the
    // order never changes: needs you, then working, then idle, then the
    // document runs in the order they are declared in.
    expect(STATUS_ORDER).toEqual(["attention", "active", "quiet"]);
    expect(DOC_STACKS.map((d) => d.key)).toEqual([
      "workspaces",
      "files",
      "browser",
      "tasks",
      "reviews",
      "history",
      "team",
    ]);
  });
});

describe("docStackFor", () => {
  it("routes each document type to its stack", () => {
    expect(docStackFor("file")).toBe("files");
    expect(docStackFor("preview")).toBe("browser");
    expect(docStackFor("ticket")).toBe("tasks");
    expect(docStackFor("pr")).toBe("reviews");
    expect(docStackFor("review")).toBe("reviews");
    expect(docStackFor("commit")).toBe("history");
    expect(docStackFor("agent")).toBe("workspaces");
  });

  it("never strands a type it has never heard of", () => {
    const keys = DOC_STACKS.map((g) => g.key);
    expect(keys).toContain(docStackFor("something-added-later"));
  });

  it("claims each type exactly once, so a tab can't be in two stacks", () => {
    const all = DOC_STACKS.flatMap((g) => g.types);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("shownInStack", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("shows everything while the stack is open", () => {
    expect(shownInStack(tabs, true)).toEqual(tabs);
  });

  it("shows nothing at all while it is folded", () => {
    // Including the tab you are looking at. A folded stack that kept one tab
    // out beside a count that did not account for it read as a bug; which
    // stack holds the active tab is said by the chip instead.
    expect(shownInStack(tabs, false)).toEqual([]);
  });
});

describe("sameGroups", () => {
  it("is true only for the same ids in the same buckets at the same point", () => {
    expect(sameGroups(prev({ a: { group: "quiet" } }), prev({ a: { group: "quiet" } }))).toBe(true);
    expect(sameGroups(prev({ a: { group: "quiet" } }), prev({ a: { group: "active" } }))).toBe(false);
    expect(sameGroups(prev({ a: { group: "quiet" } }), prev({}))).toBe(false);
    expect(
      sameGroups(prev({ a: { group: "active", pendingSince: 1 } }), prev({ a: { group: "active" } })),
    ).toBe(false);
  });
});

describe("targetsKey", () => {
  it("changes when a tab's status changes and when the set changes", () => {
    const base = targetsKey(want({ a: "quiet", b: "active" }));
    expect(targetsKey(want({ a: "quiet", b: "active" }))).toBe(base);
    expect(targetsKey(want({ a: "active", b: "active" }))).not.toBe(base);
    expect(targetsKey(want({ a: "quiet" }))).not.toBe(base);
  });

  it("changes when a quiet target becomes proven — the fall is due sooner", () => {
    const base = targetsKey(want({ a: "quiet" }));
    expect(targetsKey(want({ a: "quiet" }), new Set(["a"]))).not.toBe(base);
    expect(targetsKey(want({ a: "quiet" }), new Set(["b"]))).toBe(base);
  });
});

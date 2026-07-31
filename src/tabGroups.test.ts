import { describe, expect, it } from "vitest";
import {
  DOC_STACKS,
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
});

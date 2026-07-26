import { beforeEach, describe, expect, it, vi } from "vitest";

// The store's whole job is to hold exactly one subscription and to not talk to
// IPC more than it must, so the mock counts calls: that count *is* the contract.
const prWatchSet = vi.fn(async (_paths: string[], _focused: boolean) => {});
const prWatchNow = vi.fn(async () => {});
const handlers: {
  snapshot?: (s: unknown) => void;
  tick?: (t: unknown) => void;
  next?: (n: number) => void;
} = {};

vi.mock("./ipc", () => ({
  prWatchSet: (paths: string[], focused: boolean) => prWatchSet(paths, focused),
  prWatchNow: () => prWatchNow(),
  onPrSnapshot: (cb: (s: unknown) => void) => {
    handlers.snapshot = cb;
    return Promise.resolve(() => {});
  },
  onPrTick: (cb: (t: unknown) => void) => {
    handlers.tick = cb;
    return Promise.resolve(() => {});
  },
  onPrNext: (cb: (n: number) => void) => {
    handlers.next = cb;
    return Promise.resolve(() => {});
  },
}));

import * as store from "./prWatchStore";
import type * as ipc from "./ipc";

const row = (over: Partial<ipc.PrRow> = {}): ipc.PrRow =>
  ({
    repo: "/a",
    nwo: "o/a",
    number: 1,
    title: "t",
    author: "alice",
    url: "u",
    branch: "b",
    base: "main",
    draft: false,
    created: "",
    updated: "2026-07-01T00:00:00Z",
    additions: 1,
    deletions: 0,
    mergeable: "MERGEABLE",
    review_decision: "",
    checks: "PASS",
    comments: 0,
    threads: 0,
    requested_from_me: false,
    mine: false,
    ...over,
  }) as ipc.PrRow;

describe("prWatchStore", () => {
  beforeEach(() => {
    store.__reset();
    prWatchSet.mockClear();
    prWatchNow.mockClear();
  });

  it("declares a repo set once and ignores an identical redeclaration", () => {
    store.setPaths(["/a", "/b"]);
    store.setPaths(["/a", "/b"]);
    store.setPaths(["/a", "/b"]);
    expect(prWatchSet).toHaveBeenCalledTimes(1);
    expect(prWatchSet).toHaveBeenCalledWith(["/a", "/b"], true);
    // A genuine change goes through.
    store.setPaths(["/a"]);
    expect(prWatchSet).toHaveBeenCalledTimes(2);
  });

  it("fans one snapshot out to every subscriber and keeps repos independent", () => {
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().rows.length));
    store.subscribe(() => seen.push(-1));
    handlers.snapshot?.({
      repo: "/a",
      nwo: "o/a",
      viewer: "me",
      fetched_ms: 10,
      rows: [row({ number: 1 }), row({ number: 2 })],
    });
    handlers.snapshot?.({
      repo: "/b",
      nwo: "o/b",
      viewer: "me",
      fetched_ms: 11,
      rows: [row({ repo: "/b", number: 3 })],
    });
    expect(seen).toEqual([2, -1, 3, -1]);
    expect(store.getSnapshot().viewer).toBe("me");
    expect(store.getSnapshot().fetchedMs).toBe(11);
  });

  it("unsubscribes cleanly", () => {
    let hits = 0;
    const off = store.subscribe(() => hits++);
    handlers.snapshot?.({ repo: "/a", nwo: "o/a", viewer: "me", fetched_ms: 1, rows: [] });
    off();
    handlers.snapshot?.({ repo: "/a", nwo: "o/a", viewer: "me", fetched_ms: 2, rows: [row()] });
    expect(hits).toBe(1);
  });

  it("finds one repo's row without scanning the others", () => {
    handlers.snapshot?.({
      repo: "/a",
      nwo: "o/a",
      viewer: "me",
      fetched_ms: 1,
      rows: [row({ number: 4, updated: "2026-07-05T00:00:00Z" })],
    });
    expect(store.rowFor("/a", 4)?.updated).toBe("2026-07-05T00:00:00Z");
    expect(store.rowFor("/a", 99)).toBeUndefined();
    expect(store.rowFor("/nope", 4)).toBeUndefined();
  });

  it("keeps the rate-limit and error report from a tick", () => {
    handlers.tick?.({
      fetched_ms: 99,
      repos: 2,
      requests: 1,
      cost: 7,
      remaining: 4993,
      reset_at: "2026-07-01T13:00:00Z",
      errors: { "/b": "not readable" },
      next_in: 90,
    });
    const s = store.getSnapshot();
    expect(s.remaining).toBe(4993);
    expect(s.cost).toBe(7);
    expect(s.errors["/b"]).toBe("not readable");
    expect(s.busy).toBe(false);
  });

  it("coalesces refresh into one wake and clears the busy flag on the next tick", () => {
    store.refresh();
    store.refresh();
    expect(prWatchNow).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().busy).toBe(true);
    handlers.tick?.({
      fetched_ms: 1,
      repos: 0,
      requests: 0,
      cost: 0,
      remaining: 0,
      reset_at: "",
      errors: {},
      next_in: 0,
    });
    expect(store.getSnapshot().busy).toBe(false);
  });

  it("empties the list when nothing is being watched", () => {
    handlers.snapshot?.({ repo: "/a", nwo: "o/a", viewer: "me", fetched_ms: 1, rows: [row()] });
    expect(store.getSnapshot().rows).toHaveLength(1);
    store.setPaths([]);
    expect(store.getSnapshot().rows).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// The two things this module is allowed to ask: the watcher's open-PR rows,
// and `gh pr view`. Counting the calls is most of the contract — the whole
// reason a state can be shown live is that asking is rare.
const ghPrState = vi.fn(async (_repo: string, _number: number) => "OPEN");
const watched = new Set<string>();

vi.mock("./ipc", () => ({
  ghPrState: (repo: string, number: number) => ghPrState(repo, number),
}));

vi.mock("./prWatchStore", () => ({
  rowFor: (repo: string, number: number) =>
    watched.has(`${repo}#${number}`) ? { repo, number } : undefined,
}));

import {
  __reset,
  refreshPrLinks,
  resolve,
  stateOf,
  type PrLinkRef,
} from "./prLinkState";

const pr = (over: Partial<PrLinkRef> = {}): PrLinkRef => ({
  repo: "/repo",
  number: 447,
  state: "open",
  ...over,
});

beforeEach(() => {
  __reset();
  watched.clear();
  ghPrState.mockReset();
  ghPrState.mockResolvedValue("OPEN");
});

describe("what state a linked PR is shown as", () => {
  it("shows the recorded state before anything has been asked", () => {
    // First paint has to render something, and the record is the last thing we
    // knew. It is a starting point, not the answer.
    expect(stateOf(pr({ state: "open" }))).toBe("open");
    expect(ghPrState).not.toHaveBeenCalled();
  });

  it("shows what the PR actually is, not what the record says", async () => {
    // The bug this module exists for: an agent links the PR it just raised, so
    // the record says "open" forever, and the entry's chip goes on saying
    // "open" against something that merged weeks ago.
    ghPrState.mockResolvedValue("MERGED");
    const link = pr({ state: "open" });
    await resolve([link]);
    expect(stateOf(link)).toBe("merged");
  });

  it("takes the watcher's word for open, and spends nothing doing it", async () => {
    // The watcher already polls every watched repo and holds open PRs only. A
    // row is proof, and proof we have already paid for.
    watched.add("/repo#447");
    await resolve([pr({ state: "" })]);
    expect(stateOf(pr({ state: "" }))).toBe("open");
    expect(ghPrState).not.toHaveBeenCalled();
  });

  it("keeps the last thing we knew when it cannot reach GitHub", async () => {
    // No gh, no network, a repo that moved. A chip that lags is a chip; a chip
    // that invents a state is a lie about whether work shipped.
    ghPrState.mockRejectedValue(new Error("no gh"));
    const link = pr({ state: "open" });
    await resolve([link]);
    expect(stateOf(link)).toBe("open");
  });

  it("never asks twice about a PR that merged", async () => {
    // Nothing follows a merge, so the answer cannot go stale. This is what
    // makes a sweep over settled work free.
    ghPrState.mockResolvedValue("MERGED");
    await resolve([pr()]);
    await resolve([pr()]);
    await resolve([pr()]);
    expect(ghPrState).toHaveBeenCalledTimes(1);
  });

  it("asks once for the same PR linked from several places", async () => {
    ghPrState.mockResolvedValue("CLOSED");
    await Promise.all([
      resolve([pr(), pr()]),
      resolve([pr()]),
    ]);
    expect(ghPrState).toHaveBeenCalledTimes(1);
    expect(stateOf(pr())).toBe("closed");
  });
});

describe("bringing recorded states up to date", () => {
  const rows = [
    // Deliberately not the mid-flight status: the old reconciler only ever
    // looked at entries it was about to move, which is exactly why every other
    // entry's PR state stopped being maintained.
    { id: "0102-stacked-pr-parity", pr_count: 1, status: "researched" },
    { id: "0007-tier-donations", pr_count: 0, status: "doing" },
  ];

  it("corrects a link on an entry nobody is about to move", async () => {
    ghPrState.mockResolvedValue("MERGED");
    const write = vi.fn(async () => {});
    const merged = await refreshPrLinks(
      rows,
      async (id) => (id === "0102-stacked-pr-parity" ? [pr({ state: "open" })] : null),
      write,
    );
    expect(write).toHaveBeenCalledWith("0102-stacked-pr-parity", {
      ...pr(),
      state: "merged",
    });
    expect([...merged]).toEqual(["0102-stacked-pr-parity"]);
  });

  it("does not read an entry that has nothing linked", async () => {
    const read = vi.fn(async () => null);
    await refreshPrLinks([rows[1]], read, async () => {});
    expect(read).not.toHaveBeenCalled();
  });

  it("writes nothing when the record is already right", async () => {
    ghPrState.mockResolvedValue("MERGED");
    const write = vi.fn(async () => {});
    await refreshPrLinks(
      [rows[0]],
      async () => [pr({ state: "merged" })],
      write,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("reports nothing merged when it could not reach the PR", async () => {
    // The one inference that must never be made: unreachable is not shipped.
    ghPrState.mockRejectedValue(new Error("no gh"));
    const merged = await refreshPrLinks(
      [rows[0]],
      async () => [pr({ state: "open" })],
      async () => {},
    );
    expect(merged.size).toBe(0);
  });

  it("only reports an entry whose every PR merged", async () => {
    ghPrState.mockImplementation(async (_repo, number) =>
      number === 447 ? "MERGED" : "OPEN",
    );
    const merged = await refreshPrLinks(
      [rows[0]],
      async () => [pr({ number: 447 }), pr({ number: 448 })],
      async () => {},
    );
    expect(merged.size).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  provenanceRecord: vi.fn(async () => true),
  provenanceForPr: vi.fn(async () => []),
  provenanceBackfill: vi.fn(async () => ({
    scanned: 0,
    matched: 0,
    recorded: 0,
    unattributable: 0,
  })),
  // provenance.ts registers its change-channel handler at module scope, which
  // reaches stores.ts and this. Never resolving is right: nothing in this file
  // is about the channel.
  onStoreChange: vi.fn(() => new Promise<never>(() => {})),
}));

import * as ipc from "./ipc";
import { __reset, adoptOnce, parsePrUrl, record } from "./provenance";

const recordMock = ipc.provenanceRecord as unknown as ReturnType<typeof vi.fn>;
const backfillMock = ipc.provenanceBackfill as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  __reset();
  vi.clearAllMocks();
});

describe("the PR a job_done url names", () => {
  it("reads a pull request in the forms agents actually pass", () => {
    expect(parsePrUrl("https://github.com/o/n/pull/323")?.number).toBe(323);
    // Trailing path, query and anchor — a review comment link is still the PR.
    expect(parsePrUrl("https://github.com/o/n/pull/323/files")?.number).toBe(323);
    expect(parsePrUrl("https://github.com/o/n/pull/323#issuecomment-1")?.number).toBe(323);
    // The API form, which is what `gh api` prints back.
    expect(parsePrUrl("https://api.github.com/repos/o/n/pulls/12")?.number).toBe(12);
    expect(parsePrUrl("  https://github.com/o/n/pull/7  ")?.number).toBe(7);
    // Enterprise hosts.
    expect(parsePrUrl("https://github.acme.com/o/n/pull/5")?.number).toBe(5);
  });

  it("refuses everything that is not one", () => {
    // The failure this guards: agents pass whatever link they have, and a
    // commit or a CI run recorded as a PR is a row pointing at nothing.
    expect(parsePrUrl("https://github.com/o/n/commit/abc123")).toBeNull();
    expect(parsePrUrl("https://github.com/o/n/issues/12")).toBeNull();
    expect(parsePrUrl("https://github.com/o/n/actions/runs/99")).toBeNull();
    expect(parsePrUrl("https://github.com/o/n/pulls")).toBeNull();
    expect(parsePrUrl("https://github.com/o/n/pull/notanumber")).toBeNull();
    expect(parsePrUrl("https://example.com/o/n/pull/1")).toBeNull();
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
    expect(parsePrUrl(null)).toBeNull();
  });
});

describe("recording an edge", () => {
  const full = {
    repo: "/repo",
    url: "https://github.com/o/n/pull/42",
    branch: "feat/x",
    sessionId: "019fb713-b047",
    agent: "claude",
    profile: "default",
    cwd: "/repo/wt",
    via: "job_done" as const,
  };

  it("passes what it was given straight through", async () => {
    await record(full);
    expect(recordMock).toHaveBeenCalledWith({
      repo: "/repo",
      prNumber: 42,
      prUrl: "https://github.com/o/n/pull/42",
      branch: "feat/x",
      sessionId: "019fb713-b047",
      agent: "claude",
      profile: "default",
      cwd: "/repo/wt",
      via: "job_done",
    });
  });

  // A task that reported a commit link, or one whose hook wrote no digest, has
  // still succeeded at the thing the user asked for. Missing bookkeeping must
  // not become a visible failure — so these are quiet falses, not throws.
  it.each([
    ["no PR in the url", { url: "https://github.com/o/n/commit/abc" }],
    ["no session", { sessionId: null }],
    ["no branch", { branch: null }],
    ["no cwd", { cwd: null }],
    ["no repo", { repo: null }],
  ])("writes nothing and stays quiet when there is %s", async (_label, patch) => {
    await expect(record({ ...full, ...patch })).resolves.toBe(false);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("swallows a store that refuses", async () => {
    recordMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(record(full)).resolves.toBe(false);
  });
});

describe("adopting a repo's history", () => {
  it("runs once per repo, not once per snapshot", async () => {
    adoptOnce("/repo");
    adoptOnce("/repo");
    adoptOnce("/other");
    await Promise.resolve();
    expect(backfillMock).toHaveBeenCalledTimes(2);
    expect(backfillMock).toHaveBeenCalledWith("/repo", []);
    expect(backfillMock).toHaveBeenCalledWith("/other", []);
  });

  it("ignores an empty repo and a gh that is not there", async () => {
    adoptOnce("");
    expect(backfillMock).not.toHaveBeenCalled();
    backfillMock.mockRejectedValueOnce(new Error("gh: not found"));
    adoptOnce("/repo");
    await Promise.resolve();
    // Nothing thrown, nothing surfaced: adopting history is not worth
    // interrupting anyone about.
  });
});

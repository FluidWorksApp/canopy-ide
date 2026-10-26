import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CARD_TTL_MS,
  DEGRADED_TTL_MS,
  __resetCardCache,
  cardLabel,
  cardTargets,
  fetchCard,
  type CardLookups,
} from "./chatLinkCards";
import type * as ipc from "./ipc";

const REPO = "/work/api";
const PR = "https://github.com/acme/api/pull/12";

function pr(over: Partial<ipc.PrInfo> = {}): ipc.PrInfo {
  return {
    number: 12, title: "Fix the cache", author: "ada", branch: "fix", base: "main",
    draft: false, state: "OPEN", url: PR, created: "", updated: "",
    review_decision: "APPROVED", additions: 1, deletions: 1, mine: false,
    mergeable: "MERGEABLE", checks: "PASS", checks_summary: "4/4 checks passed",
    ...over,
  };
}

function lookups(over: Partial<CardLookups> = {}): CardLookups {
  return {
    watchedRows: () => [],
    repos: () => [REPO],
    remoteUrl: vi.fn(async () => "git@github.com:acme/api.git"),
    prs: vi.fn(async () => [pr()]),
    prState: vi.fn(async () => "MERGED"),
    issues: vi.fn(async () => [
      { id: "#7", title: "Crash on start", state: "OPEN", state_type: "", assignee: null, mine: false, url: "", branch: null, body: "", priority: "" },
    ]),
    issueDetail: vi.fn(async () => ({ internal_id: "", author: "grace", created_at: "", updated_at: "", state: "closed", state_id: "", states: [], comments: [] })),
    commit: vi.fn(async (_r: string, hash: string) => ({ hash: `${hash}ffff`, short: hash.slice(0, 7), author: "linus", email: "", date: "", subject: "Tidy up", body: "", refs: "", parents: [] })),
    ...over,
  };
}

const target = (href: string) => cardTargets(href)[0];

beforeEach(() => __resetCardCache());

describe("cardTargets", () => {
  it("keeps PR, issue and commit links in order, de-duplicated, three at most", () => {
    const text = [
      "see https://github.com/acme/api/pull/12 and again https://github.com/acme/api/pull/12/files.",
      "file https://github.com/acme/api/blob/main/src/a.ts#L3 is not a card,",
      "nor is https://example.com/x;",
      "https://github.com/acme/api/issues/7 https://github.com/acme/api/commit/abcdef1",
      "https://github.com/acme/api/pull/13",
    ].join(" ");
    expect(cardTargets(text).map((t) => t.href)).toEqual([
      "https://github.com/acme/api/pull/12",
      "https://github.com/acme/api/issues/7",
      "https://github.com/acme/api/commit/abcdef1",
    ]);
  });
  it("does not invent shorthand: bare #123 and owner/repo#123 are plain text", () => {
    expect(cardTargets("fixed in #123 and acme/api#45")).toEqual([]);
  });
});

describe("fetchCard", () => {
  it("draws an open PR from the PR list: title, author, CI and review", async () => {
    const card = await fetchCard(target(PR), lookups());
    expect(card).toMatchObject({ title: "Fix the cache", author: "ada", state: "open", checks: "PASS", review: "APPROVED" });
    expect(cardLabel(card)).toBe("Pull request #12 in acme/api, Fix the cache, Open, by ada, Checks passing, Approved");
  });
  it("marks a draft PR as draft", async () => {
    const card = await fetchCard(target(PR), lookups({ prs: async () => [pr({ draft: true, checks: "PENDING", review_decision: "REVIEW_REQUIRED" })] }));
    expect(card).toMatchObject({ state: "draft", checks: "PENDING", review: "REVIEW_REQUIRED" });
  });
  it("asks gh for the state of a PR that is no longer open — merged or closed", async () => {
    const merged = await fetchCard(target(PR), lookups({ prs: async () => [] }));
    expect(merged).toMatchObject({ state: "merged" });
    expect(merged.title).toBeUndefined();
    __resetCardCache();
    const closed = await fetchCard(target(PR), lookups({ prs: async () => [], prState: async () => "CLOSED" }));
    expect(closed.state).toBe("closed");
  });
  it("prefers the PR watcher's rows and spends no gh call on them", async () => {
    const look = lookups({
      watchedRows: () => [{ repo: REPO, nwo: "Acme/API", number: 12, title: "From the watcher", author: "ada", draft: false, checks: "FAIL", review_decision: "CHANGES_REQUESTED" } as ipc.PrRow],
    });
    const card = await fetchCard(target(PR), look);
    expect(card).toMatchObject({ title: "From the watcher", state: "open", checks: "FAIL", review: "CHANGES_REQUESTED" });
    expect(look.remoteUrl).not.toHaveBeenCalled();
    expect(look.prs).not.toHaveBeenCalled();
  });
  it("draws an issue from the list and the detail", async () => {
    const card = await fetchCard(target("https://github.com/acme/api/issues/7"), lookups());
    expect(card).toMatchObject({ title: "Crash on start", author: "grace", state: "closed" });
  });
  it("draws a commit from the local checkout", async () => {
    const card = await fetchCard(target("https://github.com/acme/api/commit/abcdef1234"), lookups());
    expect(card).toMatchObject({ title: "Tidy up", author: "linus", short: "abcdef1" });
    expect(cardLabel(card)).toBe("Commit abcdef1 in acme/api, Tidy up, by linus");
  });
  it("falls back to the compact card when no open project has the repo", async () => {
    const look = lookups({ remoteUrl: vi.fn(async () => "git@github.com:other/thing.git") });
    const card = await fetchCard(target(PR), look);
    expect(card).toEqual({ href: PR, link: { kind: "pr", slug: "acme/api", number: 12 } });
    expect(look.prs).not.toHaveBeenCalled();
  });
  it("falls back to the compact card, without throwing, when gh fails", async () => {
    const look = lookups({ prs: vi.fn(async () => { throw new Error("gh: not logged in"); }) });
    const card = await fetchCard(target(PR), look);
    expect(card).toEqual({ href: PR, link: { kind: "pr", slug: "acme/api", number: 12 } });
    const issue = await fetchCard(
      target("https://github.com/acme/api/issues/7"),
      lookups({ issues: async () => { throw new Error("offline"); }, issueDetail: async () => { throw new Error("offline"); } }),
    );
    expect(issue.title).toBeUndefined();
    expect(issue.state).toBeUndefined();
  });
});

describe("caching", () => {
  it("answers from memory for a few minutes, then asks again", async () => {
    const look = lookups();
    const t = target(PR);
    await fetchCard(t, look, 1_000);
    await fetchCard(t, look, 1_000 + CARD_TTL_MS - 1);
    expect(look.prs).toHaveBeenCalledTimes(1);
    await fetchCard(t, look, 1_000 + CARD_TTL_MS + 1);
    expect(look.prs).toHaveBeenCalledTimes(2);
  });
  it("shares one PR list between cards for the same repo, and one call between concurrent askers", async () => {
    const look = lookups({ prs: vi.fn(async () => [pr(), pr({ number: 13, title: "Other" })]) });
    const [a, b, c] = await Promise.all([
      fetchCard(target(PR), look, 5),
      fetchCard(target(PR), look, 5),
      fetchCard(target("https://github.com/acme/api/pull/13"), look, 5),
    ]);
    expect(a.title).toBe("Fix the cache");
    expect(b.title).toBe("Fix the cache");
    expect(c.title).toBe("Other");
    expect(look.prs).toHaveBeenCalledTimes(1);
    expect(look.remoteUrl).toHaveBeenCalledTimes(1);
  });
  it("retries a failed card sooner than a good one", async () => {
    const prs = vi.fn(async (): Promise<ipc.PrInfo[]> => { throw new Error("offline"); });
    const look = lookups({ prs });
    const t = target(PR);
    expect((await fetchCard(t, look, 0)).title).toBeUndefined();
    await fetchCard(t, look, DEGRADED_TTL_MS - 1);
    expect(prs).toHaveBeenCalledTimes(1);
    prs.mockResolvedValueOnce([pr()]);
    expect((await fetchCard(t, look, DEGRADED_TTL_MS + 1)).title).toBe("Fix the cache");
    expect(prs).toHaveBeenCalledTimes(2);
  });
});

// A teammate's share card, resolved against the checkouts here. Wrong answers
// open someone else's repo or a file outside the one named; "web" only costs a
// browser tab.
import { describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import {
  remoteMatchesRepo,
  repoRefFromRemote,
  resolveShareCard,
  type ShareCardLookups,
} from "./gitLinks";
import type { Card } from "./teamMessaging/cardSchema";

const A = "a".repeat(40);
const B = "b".repeat(40);
const repo = { host: "github.com", slug: "acme/agent" };

describe("repoRefFromRemote", () => {
  it("reads ssh, scp-style and https origins", () => {
    for (const url of [
      "git@github.com:acme/agent.git",
      "https://github.com/acme/agent",
      "https://user:tok@github.com/acme/agent.git/",
      "ssh://git@github.com:22/acme/agent.git",
      "git+ssh://git@github.com/acme/agent",
    ])
      expect(repoRefFromRemote(url), url).toEqual(repo);
    expect(repoRefFromRemote("https://ghe.corp.example:8443/g/sub/r.git")).toEqual({
      host: "ghe.corp.example:8443",
      slug: "g/sub/r",
    });
  });
  it("refuses what a card cannot name", () => {
    for (const url of ["", "/home/me/repo", "file:///home/me/repo", "C:\\repo", "https://github.com/solo", "https://github.com/a/../b"])
      expect(repoRefFromRemote(url), url).toBeNull();
  });
  it("matches the whole slug and the host", () => {
    expect(remoteMatchesRepo("git@github.com:ACME/Agent.git", repo)).toBe(true);
    expect(remoteMatchesRepo("git@gitlab.com:acme/agent.git", repo)).toBe(false);
    expect(remoteMatchesRepo("git@github.com:other/acme/agent.git", repo)).toBe(false);
    // An ssh config alias is not a hostname; the slug decides.
    expect(remoteMatchesRepo("work:acme/agent.git", repo)).toBe(true);
  });
});

describe("resolveShareCard", () => {
  const pr = (number: number) => ({ number, title: `#${number}`, head_sha: A }) as ipc.PrInfo;
  const commit = { hash: B, short: "bbbbbbb", subject: "x" } as ipc.CommitDetail;
  const asked: string[] = [];
  const lookups = (over: Partial<ShareCardLookups> = {}): ShareCardLookups => ({
    repos: ["/work/other", "/work/agent"],
    remoteUrl: async (r) => (r === "/work/agent" ? "git@github.com:acme/agent.git" : "git@github.com:acme/other.git"),
    prs: async () => [pr(7)],
    issues: async () => [],
    commit: async () => commit,
    fileExists: async () => true,
    head: async () => A,
    containedPath: async (r, p) => {
      asked.push(p);
      return `${r}/${p}`;
    },
    ...over,
  });

  it("maps each card to its native view in the matching checkout", async () => {
    const look = lookups();
    await expect(resolveShareCard({ type: "pr", v: 1, repo, number: 7, title: "t" }, look)).resolves.toEqual({ do: "pr", repo: "/work/agent", pr: pr(7) });
    await expect(resolveShareCard({ type: "review-request", v: 1, repo, number: 7, title: "t", head: A, reviewers: ["u"] }, look)).resolves.toMatchObject({ do: "pr" });
    await expect(resolveShareCard({ type: "diff", v: 1, repo, base: A, head: B, path: "a.ts", patch: "p", pr: 7 }, look)).resolves.toMatchObject({ do: "pr" });
    await expect(resolveShareCard({ type: "diff", v: 1, repo, base: A, head: B, path: "a.ts", patch: "p" }, look)).resolves.toEqual({ do: "commit", repo: "/work/agent", commit });
    await expect(resolveShareCard({ type: "file", v: 1, repo, path: "src/a.ts", rev: B, lines: { start: 4, end: 9 } }, look)).resolves.toEqual({
      do: "file", repo: "/work/agent", path: "src/a.ts", line: 4, rev: B, head: A, exists: true,
    });
    await expect(resolveShareCard({ type: "terminal", v: 1, title: "t", output: "o" }, look)).resolves.toEqual({ do: "none" });
    await expect(resolveShareCard({ type: "report", v: 1, agent: "a", title: "t", body: "b" }, look)).resolves.toEqual({ do: "none" });
  });

  it("falls back to the host's page when nothing here answers", async () => {
    const card: Card = { type: "pr", v: 1, repo: { host: "github.com", slug: "acme/elsewhere" }, number: 7, title: "t" };
    await expect(resolveShareCard(card, lookups())).resolves.toEqual({ do: "web", url: "https://github.com/acme/elsewhere/pull/7", host: "github.com" });
    // Same slug on another host is another repo.
    await expect(resolveShareCard({ ...card, repo: { host: "gitlab.com", slug: "acme/agent" } }, lookups())).resolves.toMatchObject({ do: "web", host: "gitlab.com" });
    // A closed PR: the checkout is here, the PR is not in the open list.
    await expect(resolveShareCard({ ...card, repo }, lookups({ prs: async () => [] }))).resolves.toEqual({
      do: "web", url: "https://github.com/acme/agent/pull/7", host: "github.com", repo: "/work/agent",
    });
    await expect(
      resolveShareCard({ type: "diff", v: 1, repo, base: A, head: B, path: "a.ts", patch: "p" }, lookups({ commit: async () => Promise.reject(new Error("unknown")) })),
    ).resolves.toMatchObject({ do: "web", url: `https://github.com/acme/agent/compare/${A}...${B}` });
  });

  it("re-checks a file path and asks Rust for containment", async () => {
    asked.length = 0;
    // A hand-built card with a traversal never reaches the disk.
    await expect(resolveShareCard({ type: "file", v: 1, repo, path: "../etc/passwd", rev: B }, lookups())).resolves.toMatchObject({ do: "web" });
    expect(asked).toEqual([]);
    // A symlink escape (Rust refuses): no working copy to open, the commit view stays possible.
    await expect(
      resolveShareCard({ type: "file", v: 1, repo, path: "docs/secret", rev: B }, lookups({ containedPath: async () => Promise.reject(new Error("path leaves the repository")) })),
    ).resolves.toMatchObject({ do: "file", exists: false });
  });
});

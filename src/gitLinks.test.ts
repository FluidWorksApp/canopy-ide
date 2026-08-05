// What a git-host URL is about — and, just as much, what it is not about. A
// wrong answer here opens someone else's PR or the wrong file; "no answer" only
// costs a web page.
import { describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import {
  parseGitLink,
  remoteMatchesSlug,
  resolveGitLink,
  type GitLinkLookups,
} from "./gitLinks";

describe("parseGitLink", () => {
  it("reads a pull request, and its sub-pages and anchors", () => {
    expect(parseGitLink("https://github.com/FluidWorksApp/coraa-agent/pull/1385")).toEqual({
      kind: "pr",
      slug: "FluidWorksApp/coraa-agent",
      number: 1385,
    });
    for (const tail of ["/files", "/commits", "#issuecomment-42", "?w=1"]) {
      expect(
        parseGitLink(`https://github.com/FluidWorksApp/coraa-agent/pull/1385${tail}`),
      ).toMatchObject({ kind: "pr", number: 1385 });
    }
  });

  it("reads a GitLab merge request under a nested group", () => {
    expect(parseGitLink("https://gitlab.com/acme/team/api/-/merge_requests/7")).toEqual({
      kind: "pr",
      slug: "acme/team/api",
      number: 7,
    });
  });

  it("reads an issue and a commit", () => {
    expect(parseGitLink("https://github.com/owner/name/issues/12")).toEqual({
      kind: "issue",
      slug: "owner/name",
      number: 12,
    });
    expect(parseGitLink("https://github.com/owner/name/commit/7cd6dd47")).toEqual({
      kind: "commit",
      slug: "owner/name",
      hash: "7cd6dd47",
    });
  });

  it("reads a file, with the line the anchor asked for", () => {
    expect(
      parseGitLink("https://github.com/owner/name/blob/main/src/app/main.rs#L40"),
    ).toEqual({ kind: "file", slug: "owner/name", path: "src/app/main.rs", line: 40 });
    // A range highlights from its first line; a percent-encoded space is a space.
    expect(
      parseGitLink("https://github.com/owner/name/blob/main/docs/my%20notes.md#L12-L20"),
    ).toMatchObject({ path: "docs/my notes.md", line: 12 });
    expect(
      parseGitLink("https://github.com/owner/name/blob/main/README.md"),
    ).toMatchObject({ path: "README.md", line: undefined });
  });

  it("refuses everything that only looks like one of these", () => {
    for (const href of [
      // A branch listing, not a commit.
      "https://github.com/owner/name/commits/main",
      // Lists, not items.
      "https://github.com/owner/name/issues",
      "https://github.com/owner/name/pulls",
      // Not a number.
      "https://github.com/owner/name/pull/latest",
      // No repo — a user's own issue dashboard.
      "https://github.com/issues/12",
      // Nothing to do with a repository.
      "https://github.com/owner/name",
      "https://github.com/owner/name/releases/tag/v1.2.0",
      "https://example.com/docs",
      // Not a URL, and not a scheme any of this may act on.
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(parseGitLink(href), href).toBeNull();
    }
  });

  it("does not read a repository's own name as the route", () => {
    // A repo actually called `pull` — the marker can never be the second segment.
    expect(parseGitLink("https://github.com/owner/pull/12")).toBeNull();
    expect(parseGitLink("https://github.com/owner/commit/blob/main/a.ts")).toMatchObject({
      kind: "file",
      slug: "owner/commit",
      path: "a.ts",
    });
  });
});

describe("resolveGitLink", () => {
  const pr = (number: number) => ({ number, title: `#${number}` }) as ipc.PrInfo;
  const issue = (n: number) => ({ id: `#${n}`, title: `issue ${n}` }) as ipc.TicketInfo;
  const commit = { hash: "7cd6dd47c0ffee", short: "7cd6dd4", subject: "wire it up" };

  /** One checkout, /work/agent, whose origin is acme/agent. */
  const lookups = (over: Partial<GitLinkLookups> = {}): GitLinkLookups => ({
    repos: ["/work/agent"],
    remoteUrl: async () => "git@github.com:acme/agent.git",
    prs: async () => [pr(1385)],
    issues: async () => [issue(12)],
    commit: async () => commit as ipc.CommitDetail,
    fileExists: async () => true,
    ...over,
  });

  const url = (path: string) => `https://github.com/acme/agent${path}`;

  it("opens an open PR, an issue, a commit and a file in the matching checkout", async () => {
    const look = lookups();
    await expect(resolveGitLink(url("/pull/1385"), look)).resolves.toEqual({
      do: "pr",
      repo: "/work/agent",
      pr: pr(1385),
    });
    await expect(resolveGitLink(url("/issues/12"), look)).resolves.toEqual({
      do: "ticket",
      repo: "/work/agent",
      ticket: issue(12),
    });
    await expect(resolveGitLink(url("/commit/7cd6dd4"), look)).resolves.toEqual({
      do: "commit",
      repo: "/work/agent",
      commit,
    });
    await expect(
      resolveGitLink(url("/blob/main/src/app.ts#L40"), look),
    ).resolves.toEqual({ do: "file", repo: "/work/agent", path: "src/app.ts", line: 40 });
  });

  it("picks the checkout the link names, not the first one open", async () => {
    const action = await resolveGitLink(url("/pull/1385"), {
      ...lookups(),
      repos: ["/work/other", "/work/agent"],
      remoteUrl: async (repo) =>
        repo === "/work/agent"
          ? "git@github.com:acme/agent.git"
          : "git@github.com:acme/other.git",
    });
    expect(action).toMatchObject({ do: "pr", repo: "/work/agent" });
  });

  it("declines a repository this project has not got — that is a web page", async () => {
    await expect(
      resolveGitLink("https://github.com/someone/else/pull/3", lookups()),
    ).resolves.toBeNull();
  });

  it("declines what it cannot show: a closed PR, a commit we never fetched, a path not here", async () => {
    // Merged and closed PRs are not in the list the panel has, and there is no
    // native view to put one in.
    await expect(
      resolveGitLink(url("/pull/9"), lookups({ prs: async () => [] })),
    ).resolves.toBeNull();
    await expect(
      resolveGitLink(
        url("/commit/deadbee"),
        lookups({ commit: async () => Promise.reject(new Error("unknown revision")) }),
      ),
    ).resolves.toBeNull();
    await expect(
      resolveGitLink(url("/blob/main/src/gone.ts"), lookups({ fileExists: async () => false })),
    ).resolves.toBeNull();
  });

  it("follows GitHub's own redirect from /issues/n to a PR with that number", async () => {
    const action = await resolveGitLink(
      url("/issues/1385"),
      lookups({ issues: async () => [] }),
    );
    expect(action).toMatchObject({ do: "pr", pr: pr(1385) });
  });

  it("survives a lookup that throws — gh missing, a repo with no origin", async () => {
    await expect(
      resolveGitLink(
        url("/pull/1385"),
        lookups({ prs: async () => Promise.reject(new Error("gh: not found")) }),
      ),
    ).resolves.toBeNull();
    await expect(
      resolveGitLink(
        url("/pull/1385"),
        lookups({ remoteUrl: async () => Promise.reject(new Error("no remote")) }),
      ),
    ).resolves.toBeNull();
  });

  it("asks nothing of git for a URL that is not one of these things", async () => {
    let asked = 0;
    const action = await resolveGitLink(
      "https://example.com/docs",
      lookups({
        remoteUrl: async () => {
          asked += 1;
          return "git@github.com:acme/agent.git";
        },
      }),
    );
    expect(action).toBeNull();
    expect(asked).toBe(0);
  });
});

describe("remoteMatchesSlug", () => {
  it("matches an origin however it is spelled", () => {
    for (const remote of [
      "git@github.com:FluidWorksApp/coraa-agent.git",
      "https://github.com/FluidWorksApp/coraa-agent.git",
      "https://github.com/fluidworksapp/coraa-agent",
      "ssh://git@github.com:22/FluidWorksApp/coraa-agent",
    ]) {
      expect(remoteMatchesSlug(remote, "FluidWorksApp/coraa-agent"), remote).toBe(true);
    }
  });

  it("does not match a different repo, or a checkout with no origin", () => {
    expect(remoteMatchesSlug("git@github.com:other/coraa-agent.git", "acme/coraa-agent")).toBe(
      false,
    );
    expect(remoteMatchesSlug("", "acme/name")).toBe(false);
  });

  it("compares a nested group on its last two segments, as an origin carries them", () => {
    expect(remoteMatchesSlug("git@gitlab.com:acme/team/api.git", "acme/team/api")).toBe(true);
  });
});

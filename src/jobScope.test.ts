import { describe, expect, it, vi } from "vitest";
import { buildScope, originMatches, parseRepoArg, place, projectCheckouts, scopeBrief, type Checkout } from "./jobScope";
import { validJobRequest, validJobScope } from "./teamMessaging/jobSchema";

const repo = { host: "github.com", slug: "FluidWorksApp/cause-api" };

describe("the scope a sender attaches", () => {
  it("reduces every spelling of an origin to host + owner/name, never a path or a credential", () => {
    for (const origin of [
      "https://github.com/FluidWorksApp/cause-api.git",
      "https://user:token@github.com/FluidWorksApp/cause-api",
      "git@github.com:FluidWorksApp/cause-api.git",
      "ssh://git@github.com:22/FluidWorksApp/cause-api.git",
      "https://GitHub.com/FluidWorksApp/cause-api/",
    ]) {
      expect(buildScope({ origin, path: "", branch: "" }), origin).toEqual({ repos: [repo] });
    }
    expect(JSON.stringify(buildScope({ origin: "https://user:token@github.com/a/b", path: "", branch: "" }))).not.toContain("token");
  });

  it("carries the folder inside the repo and the branch", () => {
    expect(buildScope({ origin: "git@github.com:acme/api.git", path: "services/billing", branch: "feat/x" })).toEqual({
      repos: [{ host: "github.com", slug: "acme/api" }],
      path: "services/billing",
      branch: "feat/x",
    });
  });

  it("attaches nothing for a checkout with no origin, or an origin that is a local path", () => {
    expect(buildScope(null)).toBeUndefined();
    expect(buildScope({ origin: "", path: "x", branch: "main" })).toBeUndefined();
    expect(buildScope({ origin: "/home/me/repos/api", path: "", branch: "" })).toBeUndefined();
    expect(buildScope({ origin: "file:///home/me/repos/api", path: "", branch: "" })).toBeUndefined();
  });

  it("drops a folder or branch it cannot carry rather than the repository", () => {
    expect(buildScope({ origin: "git@github.com:acme/api.git", path: "../etc", branch: "bad\nbranch" })).toEqual({
      repos: [{ host: "github.com", slug: "acme/api" }],
    });
  });

  it("takes named repositories first, the host from the terminal's own checkout when it is one of them", () => {
    const own = { origin: "git@github.com:FluidWorksApp/cause-api.git", path: "src", branch: "main" };
    expect(buildScope(own, ["fluidworksapp/cause-api", "FluidWorksApp/dashboard"])).toEqual({
      repos: [repo, { slug: "FluidWorksApp/dashboard" }],
      path: "src",
      branch: "main",
    });
    // Running elsewhere: the terminal's folder says nothing about that repo.
    expect(buildScope(own, ["https://gitlab.example.com/team/dashboard.git"])).toEqual({
      repos: [{ host: "gitlab.example.com", slug: "team/dashboard" }],
    });
    expect(buildScope(null, ["github.com/acme/api", "acme/api"])).toEqual({ repos: [{ host: "github.com", slug: "acme/api" }] });
  });

  it("refuses a name that is not a repository, and too many of them", () => {
    expect(() => buildScope(null, ["cause-api"])).toThrow(/isn't a repository/);
    expect(() => buildScope(null, ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"])).toThrow(/at most 5/);
  });

  it("parses the ways an agent names a repository", () => {
    expect(parseRepoArg("acme/api")).toEqual({ slug: "acme/api" });
    expect(parseRepoArg("acme/api.git")).toEqual({ slug: "acme/api" });
    expect(parseRepoArg("github.com/acme/api")).toEqual({ host: "github.com", slug: "acme/api" });
    expect(parseRepoArg("git@github.com:acme/api.git")).toEqual({ host: "github.com", slug: "acme/api" });
    expect(parseRepoArg("api")).toBeNull();
    expect(parseRepoArg("")).toBeNull();
  });
});

describe("the job schema", () => {
  const job = { id: "job-12345678", title: "t", brief: "b", workspace: null, created: 1 };

  it("accepts a job with no scope (an older sender) and with a valid one", () => {
    expect(validJobRequest(job)).toBe(true);
    expect(validJobRequest({ ...job, scope: { repos: [repo], path: "a/b", branch: "main" } })).toBe(true);
    expect(validJobRequest({ ...job, scope: { repos: [{ slug: "acme/api" }] } })).toBe(true);
  });

  it("refuses a malformed scope", () => {
    const bad: unknown[] = [
      null,
      {},
      { repos: [] },
      { repos: [repo], root: "/home/me" },
      { repos: [{ host: "github.com", slug: "api" }] },
      { repos: [{ host: "Git Hub", slug: "a/b" }] },
      { repos: [{ slug: "a/b", path: "/abs" }] },
      { repos: [repo], path: "/home/me/api" },
      { repos: [repo], path: "../up" },
      { repos: [repo], branch: "" },
      { repos: [repo], branch: "x".repeat(201) },
      { repos: Array.from({ length: 6 }, (_, i) => ({ slug: `a/${i}` })) },
    ];
    for (const scope of bad) {
      expect(validJobScope(scope), JSON.stringify(scope)).toBe(false);
      expect(validJobRequest({ ...job, scope })).toBe(false);
    }
  });
});

describe("matching a job to this machine's checkouts", () => {
  const at = (project: string, origin: string, over: Partial<Checkout> = {}): Checkout => ({
    project,
    dir: `/work/${project}`,
    rel: "",
    origin,
    main: true,
    ...over,
  });

  it("finds the one checkout whose origin is the repository, however it is spelled", () => {
    const checkouts = [
      at("CauseConnect", "git@github.com:FluidWorksApp/cause-connect.git"),
      at("api-local", "https://github.com/fluidworksapp/CAUSE-API"),
    ];
    expect(place({ repos: [repo] }, checkouts)).toEqual({ kind: "matched", repo, choices: [checkouts[1]] });
  });

  it("never matches by project or folder name", () => {
    // A project called exactly like the repository, with another origin or none.
    const checkouts = [at("cause-api", "git@github.com:someone/else.git"), at("FluidWorksApp/cause-api", "")];
    expect(place({ repos: [repo] }, checkouts)).toEqual({ kind: "missing", repo });
  });

  it("prefers the main checkout over a worktree, and the component holding the sender's folder", () => {
    const worktree = at("api-wt", "git@github.com:FluidWorksApp/cause-api.git", { main: false });
    const main = at("api", "git@github.com:FluidWorksApp/cause-api.git");
    const placed = place({ repos: [repo] }, [worktree, main]);
    expect(placed.kind === "matched" && placed.choices.map((c) => c.project)).toEqual(["api", "api-wt"]);

    const web = at("mono", "git@github.com:FluidWorksApp/cause-api.git", { dir: "/m/web", rel: "web" });
    const server = at("mono", "git@github.com:FluidWorksApp/cause-api.git", { dir: "/m/server", rel: "server" });
    const deep = place({ repos: [repo], path: "server/src" }, [web, server]);
    expect(deep.kind === "matched" && deep.choices[0].dir).toBe("/m/server");
  });

  it("matches an `owner/name` with no host on any host, and an ssh alias host", () => {
    expect(originMatches("git@github.com:acme/api.git", { slug: "acme/api" })).toBe(true);
    expect(originMatches("work:acme/api", { host: "github.com", slug: "acme/api" })).toBe(true);
    expect(originMatches("git@gitlab.com:acme/api.git", { host: "github.com", slug: "acme/api" })).toBe(false);
    expect(originMatches("/home/me/acme/api", { slug: "acme/api" })).toBe(false);
  });

  it("says when there is no repository at all", () => {
    expect(place(undefined, [at("api", "git@github.com:acme/api.git")])).toEqual({ kind: "none" });
  });

  it("tells the agent where its work is", () => {
    const scope = { repos: [repo, { slug: "FluidWorksApp/dashboard" }], path: "src", branch: "main" };
    const text = scopeBrief(scope, { kind: "matched", repo, choices: [] });
    expect(text).toContain("Repository: github.com/FluidWorksApp/cause-api (the sender was on branch main).");
    expect(text).toContain("`src` folder");
    expect(text).toContain("also involves: FluidWorksApp/dashboard");
    expect(scopeBrief(scope, { kind: "none" })).not.toContain("folder");
    expect(scopeBrief(undefined, { kind: "none" })).toBe("");
  });
});

describe("reading this machine's checkouts", () => {
  it("lists components with an origin, marking linked worktrees", async () => {
    const share: Record<string, { root: string; rel: string; origin: string }> = {
      "/a": { root: "/a", rel: "", origin: "git@github.com:acme/api.git" },
      "/a-wt": { root: "/a-wt", rel: "", origin: "git@github.com:acme/api.git" },
      "/m/web": { root: "/m", rel: "web", origin: "https://github.com/acme/mono" },
      "/plain": { root: "/plain", rel: "", origin: "" },
    };
    const rows = await projectCheckouts(
      [
        { name: "api", components: [{ path: "/a" }] },
        { name: "api-wt", components: [{ path: "/a-wt" }] },
        { name: "mono", components: [{ path: "/m/web" }, { path: "/gone" }] },
        { name: "plain", components: [{ path: "/plain" }] },
      ],
      {
        share: async (p) => {
          if (!share[p]) throw new Error("not a checkout");
          return share[p];
        },
        worktrees: async () => [
          { path: "/a", is_main: true },
          { path: "/a-wt", is_main: false },
        ],
      },
    );
    expect(rows).toEqual([
      { project: "api", dir: "/a", rel: "", origin: "git@github.com:acme/api.git", main: true },
      { project: "api-wt", dir: "/a-wt", rel: "", origin: "git@github.com:acme/api.git", main: false },
      { project: "mono", dir: "/m/web", rel: "web", origin: "https://github.com/acme/mono", main: true },
    ]);
  });

  it("uses every saved project's checkout, closed or hibernating, when the desktop can list them", async () => {
    const share = vi.fn(async () => {
      throw new Error("path outside workspace scope");
    });
    const rows = await projectCheckouts(
      [
        { name: "api", components: [{ path: "/a" }] },
        { name: "plain", components: [{ path: "/plain" }] },
      ],
      {
        all: async () => [{ dir: "/a", rel: "", origin: "git@github.com:acme/api.git", main: true }],
        share,
        worktrees: async () => [],
      },
    );
    expect(rows).toEqual([{ project: "api", dir: "/a", rel: "", origin: "git@github.com:acme/api.git", main: true }]);
    expect(share).not.toHaveBeenCalled();
  });

  it("falls back to the open projects where the list isn't served", async () => {
    const rows = await projectCheckouts([{ name: "api", components: [{ path: "/a" }] }], {
      all: async () => {
        throw new Error("unknown command");
      },
      share: async () => ({ root: "/a", rel: "", origin: "https://github.com/acme/api" }),
      worktrees: async () => [{ path: "/a", is_main: true }],
    });
    expect(rows).toEqual([{ project: "api", dir: "/a", rel: "", origin: "https://github.com/acme/api", main: true }]);
  });
});

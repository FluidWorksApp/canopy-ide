import { describe, expect, it, vi } from "vitest";
import { RepoResolver, checkoutFor, repoIdFromOrigin, repoIdLabel, reposOf, sameRepoId, sessionsInRepos, type RepoMachine } from "./repoIdentity";

const canopy = { host: "github.com", slug: "acme/canopy" };

/** A machine whose folders have the given origins. */
function machine(env: string, origins: Record<string, string | null>, extra: Partial<RepoMachine> & { checkouts?: unknown } = {}): RepoMachine & { calls: string[] } {
  const calls: string[] = [];
  return {
    env,
    calls,
    desktop: extra.desktop,
    invoke: (async (command: string, args?: Record<string, unknown>) => {
      calls.push(`${command}:${String(args?.repo ?? "")}`);
      if (command === "git_remote_url") {
        const dir = String(args?.repo);
        if (!(dir in origins)) throw new Error("outside the open projects");
        return origins[dir];
      }
      if (command === "git_project_checkouts") return extra.checkouts ?? [];
      throw new Error(`unexpected ${command}`);
    }) as RepoMachine["invoke"],
  };
}

describe("repoIdFromOrigin", () => {
  it("reads the same repository from every way of writing its origin", () => {
    for (const origin of [
      "git@github.com:acme/canopy.git",
      "https://github.com/acme/canopy",
      "https://github.com/acme/canopy.git",
      "ssh://git@github.com/acme/canopy.git",
    ]) {
      expect(repoIdFromOrigin(origin), origin).toEqual(canopy);
    }
  });

  it("is null for no origin", () => {
    expect(repoIdFromOrigin(null)).toBeNull();
    expect(repoIdFromOrigin("")).toBeNull();
    expect(repoIdFromOrigin("   ")).toBeNull();
  });
});

describe("sameRepoId", () => {
  it("matches by owner and name, whatever the case", () => {
    expect(sameRepoId(canopy, { host: "github.com", slug: "Acme/Canopy" })).toBe(true);
    expect(sameRepoId(canopy, { host: "github.com", slug: "acme/other" })).toBe(false);
  });

  it("tells two hosts apart, but not an ssh alias from the host it stands for", () => {
    expect(sameRepoId(canopy, { host: "gitlab.com", slug: "acme/canopy" })).toBe(false);
    expect(sameRepoId(canopy, { host: "work", slug: "acme/canopy" })).toBe(true);
  });

  it("labels a repository for a message", () => {
    expect(repoIdLabel(canopy)).toBe("github.com/acme/canopy");
    expect(repoIdLabel({ host: "work", slug: "acme/canopy" })).toBe("acme/canopy");
  });
});

describe("checkoutFor", () => {
  const checkouts = [
    { dir: "/Users/sam/code/canopy/app", root: "/Users/sam/code/canopy", origin: "git@github.com:acme/canopy.git" },
    { dir: "/Users/sam/code/site", root: "/Users/sam/code/site", origin: "git@github.com:acme/site.git" },
  ];

  it("finds the checkout a folder is in", () => {
    expect(checkoutFor("/Users/sam/code/canopy/app/src", checkouts)?.origin).toContain("canopy");
    expect(checkoutFor("/Users/sam/code/canopy/docs", checkouts)?.origin).toContain("canopy");
    expect(checkoutFor("/Users/sam/code/site", checkouts)?.origin).toContain("site");
  });

  it("counts a worktree beside the repository as the same checkout", () => {
    expect(checkoutFor("/Users/sam/code/canopy-wt-fix-login/app", checkouts)?.origin).toContain("canopy");
  });

  it("does not match a folder that merely starts with the same letters", () => {
    expect(checkoutFor("/Users/sam/code/canopy-old", checkouts)).toBeUndefined();
    expect(checkoutFor("/Users/sam/code/sitemap", checkouts)).toBeUndefined();
    expect(checkoutFor("/Users/sam", checkouts)).toBeUndefined();
  });

  it("prefers the innermost repository", () => {
    const nested = [...checkouts, { dir: "/Users/sam/code/canopy/vendor/lib", root: "/Users/sam/code/canopy/vendor/lib", origin: "git@github.com:acme/lib.git" }];
    expect(checkoutFor("/Users/sam/code/canopy/vendor/lib/src", nested)?.origin).toContain("lib");
  });
});

describe("RepoResolver", () => {
  it("asks the machine once per folder and remembers the answer", async () => {
    const m = machine("remote:w1", { "/workspace/canopy": "https://github.com/acme/canopy.git" });
    const resolver = new RepoResolver(() => 0);
    expect(await resolver.repoOf(m, "/workspace/canopy")).toEqual(canopy);
    expect(await resolver.repoOf(m, "/workspace/canopy")).toEqual(canopy);
    expect(m.calls).toEqual(["git_remote_url:/workspace/canopy"]);
  });

  it("shares one question between callers that ask at the same moment", async () => {
    const m = machine("remote:w1", { "/workspace/canopy": "https://github.com/acme/canopy.git" });
    const resolver = new RepoResolver(() => 0);
    await Promise.all([resolver.repoOf(m, "/workspace/canopy"), resolver.repoOf(m, "/workspace/canopy")]);
    expect(m.calls).toHaveLength(1);
  });

  it("keeps two machines' answers for the same path apart", async () => {
    const a = machine("remote:w1", { "/workspace/app": "https://github.com/acme/canopy.git" });
    const b = machine("remote:w2", { "/workspace/app": "https://github.com/acme/site.git" });
    const resolver = new RepoResolver(() => 0);
    expect((await resolver.repoOf(a, "/workspace/app"))?.slug).toBe("acme/canopy");
    expect((await resolver.repoOf(b, "/workspace/app"))?.slug).toBe("acme/site");
  });

  it("asks again about a folder that was no repository, after a while", async () => {
    let now = 0;
    const origins: Record<string, string | null> = { "/workspace/new": null };
    const m = machine("remote:w1", origins);
    const resolver = new RepoResolver(() => now);
    expect(await resolver.repoOf(m, "/workspace/new")).toBeNull();
    origins["/workspace/new"] = "https://github.com/acme/canopy.git";
    now = 30_000;
    expect(await resolver.repoOf(m, "/workspace/new")).toBeNull();
    now = 61_000;
    expect(await resolver.repoOf(m, "/workspace/new")).toEqual(canopy);
  });

  it("on a desktop, falls back to the saved checkouts for a folder its scope refuses", async () => {
    const m = machine("local", {}, {
      desktop: true,
      checkouts: [{ dir: "/Users/sam/code/canopy", root: "/Users/sam/code/canopy", origin: "git@github.com:acme/canopy.git" }],
    });
    const resolver = new RepoResolver(() => 0);
    expect(await resolver.repoOf(m, "/Users/sam/code/canopy-wt-fix/src")).toEqual(canopy);
    expect(await resolver.repoOf(m, "/Users/sam/code/canopy/src")).toEqual(canopy);
    // One read of the saved list serves both.
    expect(m.calls.filter((c) => c.startsWith("git_project_checkouts"))).toHaveLength(1);
  });

  it("never asks a workspace host for the saved checkouts", async () => {
    const m = machine("remote:w1", {});
    expect(await new RepoResolver(() => 0).repoOf(m, "/workspace/x")).toBeNull();
    expect(m.calls).toEqual(["git_remote_url:/workspace/x"]);
  });

  it("answers null, not an error, for a machine that fails or a path that is no path", async () => {
    const broken: RepoMachine = { env: "remote:w9", invoke: vi.fn(async () => { throw new Error("offline"); }) as RepoMachine["invoke"] };
    const resolver = new RepoResolver(() => 0);
    expect(await resolver.repoOf(broken, "/workspace/x")).toBeNull();
    expect(await resolver.repoOf(broken, "")).toBeNull();
    expect(await resolver.repoOf(broken, "relative/path")).toBeNull();
  });
});

describe("reposOf", () => {
  it("lists a project's repositories once each", async () => {
    const m = machine("local", {
      "/w/canopy/app": "git@github.com:acme/canopy.git",
      "/w/canopy/host": "https://github.com/acme/canopy",
      "/w/site": "git@github.com:acme/site.git",
      "/w/notes": null,
    });
    const repos = await reposOf(m, ["/w/canopy/app", "/w/canopy/host", "/w/site", "/w/notes"], new RepoResolver(() => 0));
    expect(repos.map((r) => r.slug)).toEqual(["acme/canopy", "acme/site"]);
  });
});

describe("sessionsInRepos", () => {
  const origins: Record<string, string | null> = {
    "/workspace/canopy": "https://github.com/acme/canopy.git",
    "/workspace/canopy/src": "https://github.com/acme/canopy.git",
    "/workspace/site": "https://github.com/acme/site.git",
    "/home/agent": null,
  };
  const sessions = [
    { id: 1, cwd: "/workspace/canopy" },
    { id: 2, cwd: "/workspace/site" },
    { id: 3, cwd: "/home/agent" },
    { id: 4 },
    { id: 5, cwd: "/workspace/canopy/src" },
  ];
  const repoOf = (m: RepoMachine, resolver = new RepoResolver(() => 0)) => (dir: string) => resolver.repoOf(m, dir);

  it("keeps the sessions inside the project's repository, wherever they sit on that machine", async () => {
    const kept = await sessionsInRepos(sessions, [canopy], repoOf(machine("remote:w1", origins)));
    expect(kept.map((s) => s.id)).toEqual([1, 5]);
  });

  it("joins by repository even though the folder and project names differ", async () => {
    // This Mac has it at ~/code/ide under a project called "IDE"; the other
    // machine at /workspace/canopy under "Workspace". Only the origin is shared.
    const mac = machine("local", { "/Users/sam/code/ide": "git@github.com:acme/canopy.git" });
    const resolver = new RepoResolver(() => 0);
    const repos = await reposOf(mac, ["/Users/sam/code/ide"], resolver);
    const kept = await sessionsInRepos(sessions, repos, repoOf(machine("remote:w1", origins), resolver));
    expect(kept.map((s) => s.id)).toEqual([1, 5]);
  });

  it("joins nothing for a project that is no repository", async () => {
    const m = machine("remote:w1", origins);
    expect(await sessionsInRepos(sessions, [], repoOf(m))).toEqual([]);
    expect(m.calls).toEqual([]);
  });

  it("asks about each folder once however many sessions share it", async () => {
    const m = machine("remote:w1", origins);
    await sessionsInRepos([...sessions, { id: 6, cwd: "/workspace/canopy" }], [canopy], repoOf(m));
    expect(m.calls.filter((c) => c === "git_remote_url:/workspace/canopy")).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitLinkLookups } from "./gitLinks";
import {
  ROUTE_GIT_LINK_EVENT,
  ipcGitLinkLookups,
  projectForGitLink,
  routeGitLinkElsewhere,
  type RouteGitLinkDetail,
} from "./gitLinkRouting";
import type * as ipc from "./ipc";

const fsStat = vi.hoisted(() => vi.fn(async (_path: string) => ({ is_dir: false })));
vi.mock("./ipc", () => ({ fsStat }));

describe("ipcGitLinkLookups.fileExists", () => {
  it("stats only contained paths, and never one that leaves the repo", async () => {
    const look = ipcGitLinkLookups(["/work/agent"]);
    expect(await look.fileExists("/work/agent", "../../etc/hosts")).toBe(false);
    expect(await look.fileExists("/work/agent", ".git/config")).toBe(false);
    expect(fsStat).not.toHaveBeenCalled();
    expect(await look.fileExists("/work/agent/", "src/a.ts")).toBe(true);
    expect(fsStat).toHaveBeenCalledWith("/work/agent/src/a.ts");
  });
});

const remotes: Record<string, string> = {
  "/a/web": "git@github.com:acme/web.git",
  "/b/api": "https://github.com/acme/api.git",
};

function lookupsFor(repos: readonly string[]): GitLinkLookups {
  return {
    repos,
    remoteUrl: async (repo) => remotes[repo] ?? "",
    prs: async (repo) => (repo === "/b/api" ? [{ number: 12 } as ipc.PrInfo] : []),
    issues: async () => [],
    commit: async () => {
      throw new Error("unknown revision");
    },
    fileExists: async () => false,
  };
}

const projects = [
  { id: "web", repos: ["/a/web"] },
  { id: "api", repos: ["/b/api"] },
];

describe("projectForGitLink", () => {
  it("finds the open project that can open a PR natively", async () => {
    expect(await projectForGitLink("https://github.com/acme/api/pull/12", projects, lookupsFor)).toBe("api");
  });
  it("is null when the repo is open but the thing is not there (a fork's PR, a merged PR)", async () => {
    expect(await projectForGitLink("https://github.com/acme/api/pull/99", projects, lookupsFor)).toBeNull();
    expect(await projectForGitLink("https://github.com/acme/api/commit/abcdef1", projects, lookupsFor)).toBeNull();
  });
  it("is null for a repo no open project has, and asks nothing for a non-git URL", async () => {
    expect(await projectForGitLink("https://github.com/else/where/pull/12", projects, lookupsFor)).toBeNull();
    const spy = vi.fn(lookupsFor);
    expect(await projectForGitLink("https://example.com/pull/12", projects, spy)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it("treats a failing lookup as 'not here'", async () => {
    const rejecting = (repos: readonly string[]) => ({
      ...lookupsFor(repos),
      remoteUrl: async () => Promise.reject(new Error("no remote")),
    });
    expect(await projectForGitLink("https://github.com/acme/api/pull/12", projects, rejecting)).toBeNull();
  });
});

describe("routeGitLinkElsewhere", () => {
  let off: (() => void) | undefined;
  afterEach(() => off?.());

  it("does not dispatch for a URL that is not a git link — the caller falls back at once", () => {
    const seen = vi.fn();
    window.addEventListener(ROUTE_GIT_LINK_EVENT, seen);
    off = () => window.removeEventListener(ROUTE_GIT_LINK_EVENT, seen);
    expect(routeGitLinkElsewhere("https://example.com/", "web", () => {})).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });
  it("is false when nobody takes the question, so the link is never swallowed", () => {
    expect(routeGitLinkElsewhere("https://github.com/acme/api/pull/12", "web", () => {})).toBe(false);
  });
  it("hands the URL, the asking project and the fallback to whoever claims it", () => {
    const got: RouteGitLinkDetail[] = [];
    const on = (e: Event) => {
      got.push((e as CustomEvent<RouteGitLinkDetail>).detail);
      e.preventDefault();
    };
    window.addEventListener(ROUTE_GIT_LINK_EVENT, on);
    off = () => window.removeEventListener(ROUTE_GIT_LINK_EVENT, on);
    const fallback = vi.fn();
    expect(routeGitLinkElsewhere("https://github.com/acme/api/pull/12", "web", fallback)).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ url: "https://github.com/acme/api/pull/12", from: "web" });
    got[0].fallback();
    expect(fallback).toHaveBeenCalledOnce();
  });
});

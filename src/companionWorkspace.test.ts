import { describe, expect, it } from "vitest";
import { projectOf, repoReport, scopeTo, summarise } from "./companionWorkspace";
import type { RepoReport } from "./companionWorkspace";
import type { WorkspaceProject } from "./agentOps";

const PROJECTS: WorkspaceProject[] = [
  { name: "Canopy", roots: ["/gh/canopy"], open: true, hibernated: false },
  {
    name: "Banana",
    roots: ["/gh/banana", "/gh/banana-android"],
    open: false,
    hibernated: false,
  },
  { name: "Coraa", roots: ["/gh/coraa"], open: false, hibernated: true },
];

const status = (over: Partial<import("./ipc").RepoStatus> = {}) =>
  ({
    path: "/gh/canopy",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...over,
  }) as import("./ipc").RepoStatus;

const file = () => ({}) as never;

describe("a repo's report", () => {
  it("counts every kind of uncommitted change as dirty", () => {
    const r = repoReport("Canopy", status({
      staged: [file()],
      unstaged: [file(), file()],
      untracked: [file()],
    }));
    expect(r.dirty).toBe(4);
    expect(r.clean).toBe(false);
  });

  it("is clean only when there is genuinely nothing to say", () => {
    expect(repoReport("Canopy", status()).clean).toBe(true);
    // Unpushed work is not clean, even with a spotless tree — this is the
    // case "which repos have unpushed work" is actually asking about.
    expect(repoReport("Canopy", status({ ahead: 2 })).clean).toBe(false);
    expect(repoReport("Canopy", status({ behind: 1 })).clean).toBe(false);
    expect(repoReport("Canopy", status({ conflicted: [file()] })).clean).toBe(false);
  });
});

describe("the summary", () => {
  const clean = (project: string): RepoReport => ({
    project,
    path: `/gh/${project}`,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty: 0,
    conflicted: 0,
    clean: true,
  });
  const busy = (project: string): RepoReport => ({ ...clean(project), dirty: 3, clean: false });

  it("returns only the repos worth a row", () => {
    const out = summarise([clean("a"), busy("b"), clean("c")]);
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0].project).toBe("b");
    expect(out.clean).toBe(2);
  });

  it("says everything is clean rather than returning a bare empty list", () => {
    // An agent handed an empty list cannot tell "nothing to report" from
    // "nothing was checked", and will hedge in its answer.
    const out = summarise([clean("a"), clean("b")]);
    expect(out.repos).toHaveLength(0);
    expect(out.note).toContain("All 2 repos are clean");
  });

  it("states the total, so a short list is not read as the whole picture", () => {
    const out = summarise([busy("a"), clean("b"), clean("c")]);
    expect(out.note).toContain("1 of 3");
    expect(out.note).toContain("the other 2 are clean");
  });
});

describe("scoping to a project", () => {
  it("is everything when unscoped", () => {
    expect(scopeTo(PROJECTS)).toHaveLength(3);
    expect(scopeTo(PROJECTS, "  ")).toHaveLength(3);
  });

  it("matches by name, ignoring case", () => {
    expect(scopeTo(PROJECTS, "banana").map((p) => p.name)).toEqual(["Banana"]);
    expect(scopeTo(PROJECTS, "BANANA").map((p) => p.name)).toEqual(["Banana"]);
  });

  it("refuses an unknown name instead of silently answering for everything", () => {
    // The failure this prevents: asking about "Bananna", getting the whole
    // workspace, and reporting another project's dirty files as that one's.
    expect(() => scopeTo(PROJECTS, "Bananna")).toThrow(/no project called/);
    expect(() => scopeTo(PROJECTS, "Bananna")).toThrow(/Canopy, Banana, Coraa/);
  });
});

describe("attributing a session to a project", () => {
  it("matches a root exactly and by prefix", () => {
    expect(projectOf(PROJECTS, "/gh/canopy")).toBe("Canopy");
    expect(projectOf(PROJECTS, "/gh/canopy/src/components")).toBe("Canopy");
  });

  it("gives a worktree to its own project", () => {
    expect(projectOf(PROJECTS, "/gh/canopy/.claude/worktrees/x")).toBe("Canopy");
  });

  it("takes the longest matching root when projects nest", () => {
    const nested: WorkspaceProject[] = [
      { name: "Outer", roots: ["/gh"], open: true, hibernated: false },
      { name: "Inner", roots: ["/gh/canopy"], open: true, hibernated: false },
    ];
    expect(projectOf(nested, "/gh/canopy/src")).toBe("Inner");
    expect(projectOf(nested, "/gh/other")).toBe("Outer");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    // /gh/banana-android must not be swallowed by /gh/banana as a string
    // prefix — they are different checkouts.
    const only: WorkspaceProject[] = [
      { name: "Banana", roots: ["/gh/banana"], open: true, hibernated: false },
    ];
    expect(projectOf(only, "/gh/banana-android")).toBe("unknown");
  });

  it("says unknown rather than guessing", () => {
    expect(projectOf(PROJECTS, "/somewhere/else")).toBe("unknown");
    expect(projectOf(PROJECTS, null)).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import { isVisitingId, planAllWorkspaces, type MachineRead, type StoreProject } from "./allProjects";
import type { RepoId } from "../machines/repoIdentity";

// The window is on a workspace ("box"); the desktop ("laptop") is another
// machine. Names and paths are made up.
const repo = (slug: string): RepoId => ({ host: "github.com", slug });
const REPOS: Record<string, RepoId> = {
  "/w/side/alpha": repo("acme/alpha"),
  "/w/side/beta": repo("acme/Beta"),
  "/w/apps": repo("acme/apps"),
  "/w/main-a": repo("acme/main"),
  "/w/tool": repo("acme/tool"),
  "/u/dev/alpha": repo("acme/alpha"),
  "/u/dev/beta": repo("acme/beta"),
  "/u/dev/apps": repo("acme/apps"),
  "/u/dev/main": repo("acme/main"),
  "/u/dev/tool": repo("acme/tool"),
  "/u/dev/solo": repo("acme/solo"),
};
const reposOf = async (_env: string, p: StoreProject) =>
  p.components.flatMap((c) => (REPOS[c.path] ? [REPOS[c.path]] : []));

const box: StoreProject[] = [
  { id: "b-ws", name: "Scratch", components: [{ id: "c", label: "c", path: "/w/apps" }] },
  { id: "b-main-1", name: "Main", components: [{ id: "c", label: "c", path: "/w/main-a" }] },
  // A copy of the laptop's "Side" with two of its four folders.
  { id: "b-side", name: "Side", components: [{ id: "c", label: "c", path: "/w/side/alpha" }, { id: "c", label: "c", path: "/w/side/beta" }], mirroredFrom: "l-side" },
  // A second "Main" on the same machine, copied from the laptop's.
  { id: "b-main-2", name: "Main", components: [{ id: "c", label: "c", path: "/w/main-b" }], mirroredFrom: "l-main" },
  { id: "b-tool", name: "Tool", components: [{ id: "c", label: "c", path: "/w/tool" }] },
];

const laptop: MachineRead = {
  env: "local",
  name: "This Mac",
  openIds: ["l-side", "l-main", "l-tool", "l-solo"],
  projects: [
    // A plain folder holding checkouts: the folder itself is no repository.
    { id: "l-side", name: "Side", components: [{ id: "c", label: "c", path: "/u/dev/alpha" }, { id: "c", label: "c", path: "/u/dev/beta" }, { id: "c", label: "c", path: "/u/dev/apps" }] },
    { id: "l-main", name: "Main", components: [{ id: "c", label: "c", path: "/u/dev/main" }] },
    { id: "l-tool", name: "Tool", components: [{ id: "c", label: "c", path: "/u/dev/tool" }] },
    { id: "l-solo", name: "Solo", components: [{ id: "c", label: "c", path: "/u/dev/solo" }] },
    { id: "l-closed", name: "Closed", components: [{ id: "c", label: "c", path: "/u/dev/closed" }] },
  ],
  sessions: [
    { id: 1, cwd: "/u/dev/apps", title: "agent in apps" },
    { id: 2, cwd: "/u/dev/main/src", title: "agent in main" },
    { id: 3, cwd: "/u/dev/tool-wt-fix", title: "worktree agent" },
    { id: 4, cwd: "/u/dev/solo", title: "solo agent" },
    { id: 5, cwd: "/tmp", title: "loose shell" },
    { id: 6, cwd: "/u/dev/closed", title: "closed project agent" },
  ],
};

const ids = (list: { session: { id: number } }[] | undefined) => (list ?? []).map((s) => s.session.id).sort();

describe("planAllWorkspaces", () => {
  it("puts a terminal in its own machine's project, then that project's copy", async () => {
    const plan = await planAllWorkspaces(box, [laptop], reposOf);
    // The agent in apps belongs to the laptop's Side (by folder), and so to the
    // box's copy of Side, not to the box's Scratch that also has apps checked out.
    expect(ids(plan.joins.get("b-side"))).toEqual([1]);
    expect(plan.joins.get("b-ws")).toBeUndefined();
  });

  it("matches by identity before name: the copied Main gets the agent, not the other Main", async () => {
    const plan = await planAllWorkspaces(box, [laptop], reposOf);
    expect(ids(plan.joins.get("b-main-2"))).toEqual([2]);
    expect(plan.joins.get("b-main-1")).toBeUndefined();
  });

  it("falls back to shared repositories, and folds a worktree onto its checkout", async () => {
    const plan = await planAllWorkspaces(box, [laptop], reposOf);
    expect(ids(plan.joins.get("b-tool"))).toEqual([3]);
  });

  it("shows a project only the other machine has as its own, live or merely open", async () => {
    const plan = await planAllWorkspaces(box, [laptop], reposOf);
    const solo = plan.visiting.find((v) => v.name === "Solo");
    expect(solo && isVisitingId(solo.id)).toBe(true);
    expect(ids(solo?.sessions)).toEqual([4]);
    expect(solo?.machines).toEqual(["This Mac"]);
    // Closed on the laptop but running something: still shown.
    expect(ids(plan.visiting.find((v) => v.name === "Closed")?.sessions)).toEqual([6]);
  });

  it("places every terminal in at most one project, and drops ones in no project", async () => {
    const plan = await planAllWorkspaces(box, [laptop], reposOf);
    const all = [...[...plan.joins.values()].flat(), ...plan.visiting.flatMap((v) => v.sessions)].map((s) => s.session.id);
    expect(all.sort()).toEqual([1, 2, 3, 4, 6]);
  });

  it("shows the same project from two other machines once", async () => {
    const other: MachineRead = {
      env: "remote:w2",
      name: "w2",
      openIds: ["w2-solo"],
      projects: [{ id: "w2-solo", name: "Solo copy", components: [{ id: "c", label: "c", path: "/x/solo" }], mirroredFrom: "l-solo" }],
      sessions: [{ id: 9, cwd: "/x/solo/a" }],
    };
    const plan = await planAllWorkspaces(box, [laptop, other], reposOf);
    const solos = plan.visiting.filter((v) => v.id === "all:l-solo");
    expect(solos).toHaveLength(1);
    expect(ids(solos[0].sessions)).toEqual([4, 9]);
    expect(solos[0].machines).toEqual(["This Mac", "w2"]);
  });

  it("never asks for repositories when identity already decided", async () => {
    const asked: string[] = [];
    await planAllWorkspaces(
      [{ id: "p", name: "P", components: [{ id: "c", label: "c", path: "/a" }] }],
      [{ env: "remote:x", name: "x", openIds: ["c"], projects: [{ id: "c", name: "P", components: [{ id: "c", label: "c", path: "/b" }], mirroredFrom: "p" }], sessions: [] }],
      async (env, p) => {
        asked.push(`${env}:${p.id}`);
        return [];
      },
    );
    expect(asked).toEqual([]);
  });
});

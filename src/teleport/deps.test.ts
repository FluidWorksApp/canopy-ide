import { describe, expect, it } from "vitest";
import { branchHeldElsewhere, carryRepoState, carrySendFiles, destWorktreeRoot, ensureDestWorktree, isDirty, mirrorSendFiles, readRepoState, sha256Hex, transcriptIo } from "./deps";
import type { MovePlan } from "./sessionMove";

type Calls = [string, Record<string, unknown> | undefined][];
const machine = (answers: Record<string, unknown>, calls: Calls = []) =>
  (async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    const a = answers[command];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? (a as (x?: unknown) => unknown)(args) : a;
  }) as never;

describe("repo facts", () => {
  it("reads origin, branch and head of the repo's own worktree", async () => {
    const m = machine({
      git_remote_url: "git@x:o/r.git",
      git_worktrees: [{ path: "/r", branch: "main", head: "abc" }, { path: "/r-wt", branch: "agent/a", head: "def" }],
    });
    expect(await readRepoState(m, "/r-wt")).toEqual({ origin: "git@x:o/r.git", branch: "agent/a", head: "def" });
  });
  it("a missing origin is null, not a failure", async () => {
    const m = machine({ git_remote_url: new Error("none"), git_worktrees: [{ path: "/r", branch: null, head: "a" }] });
    expect((await readRepoState(m, "/r")).origin).toBeNull();
  });
  it("dirty means any status entry; held means another worktree has the branch", async () => {
    expect(await isDirty(machine({ git_status: { entries: [{}] } }), "/r")).toBe(true);
    expect(await isDirty(machine({ git_status: { entries: [] } }), "/r")).toBe(false);
    const m = machine({ git_worktrees: [{ path: "/r", branch: "x" }, { path: "/o", branch: "agent/a" }] });
    expect(await branchHeldElsewhere(m, "/r", "agent/a")).toBe(true);
    expect(await branchHeldElsewhere(m, "/r", "x")).toBe(false);
    expect(await branchHeldElsewhere(m, "/r", null)).toBe(false);
  });
  it("hashes text", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("transcriptIo", () => {
  it("reads the source by cwd and session, writes the destination at the rebased cwd, and refuses a missing source", async () => {
    const dCalls: Calls = [];
    const io = transcriptIo({
      source: machine({ teleport_transcript_read: "line\n" }),
      dest: machine({ teleport_transcript_write: "/p", teleport_transcript_read: "line\n" }, dCalls),
      agent: { cwd: "/a/x", sessionId: "s1" },
      destCwd: () => "/w/x",
    });
    expect(await io.readTranscript("")).toBe("line\n");
    await io.writeTranscript({} as MovePlan, "", "line\n");
    expect(dCalls[0]).toEqual(["teleport_transcript_write", { cwd: "/w/x", sessionId: "s1", text: "line\n" }]);
    expect(await io.readBackTranscript({} as MovePlan, "")).toBe("line\n");
    const none = transcriptIo({
      source: machine({ teleport_transcript_read: null }),
      dest: machine({}),
      agent: { cwd: "/a", sessionId: "s1" },
      destCwd: () => "/a",
    });
    await expect(none.readTranscript("")).rejects.toThrow(/no saved conversation/);
  });
});

describe("mirrorSendFiles", () => {
  const plan = { destProject: { id: "ws-1" }, destComponent: { path: "/workspace/r" } } as unknown as MovePlan;
  const base = {
    execution_mirror_inspect: [],
    git_remote_url: "o",
  };
  it("stops before anything is stopped when the project is gone from the destination", async () => {
    const send = mirrorSendFiles({
      source: machine(base),
      dest: machine({ store_load: JSON.stringify({ projects: [] }) }),
      projectId: "p",
      componentId: "c",
      files: [],
      sourceRepo: "/r",
    });
    await expect(send(plan, null, () => {})).rejects.toThrow();
  });
});

const wt = (path: string, head: string, branch: string | null = "main") => ({ path, branch, head });

describe("carryRepoState", () => {
  it("does nothing when both are at the same commit and there are no changes", async () => {
    const sCalls: Calls = [];
    const dCalls: Calls = [];
    const r = await carryRepoState({
      source: machine({ git_remote_url: "o", git_worktrees: [wt("/r", "aaa1111")], teleport_patch_create: "" }, sCalls),
      dest: machine({ git_remote_url: "o", git_worktrees: [wt("/d", "aaa1111")] }, dCalls),
      sourcePath: "/r",
      destPath: "/d",
    });
    expect(r).toEqual({ carriedCommits: false });
    expect(sCalls.some(([c]) => c === "teleport_bundle_create")).toBe(false);
    expect(dCalls.some(([c]) => c === "teleport_bundle_apply")).toBe(false);
  });
  it("bundles the commits the destination lacks, then applies the tracked changes", async () => {
    const dCalls: Calls = [];
    const r = await carryRepoState({
      source: machine({
        git_remote_url: "o",
        git_worktrees: [wt("/r", "bbb2222")],
        teleport_git_relation: "behind",
        teleport_bundle_create: "BUNDLE",
        teleport_patch_create: "PATCH",
      }),
      dest: machine({ git_remote_url: "o", git_worktrees: [wt("/d", "aaa1111")], teleport_bundle_apply: "bbb2222", teleport_patch_create: "", teleport_patch_apply: undefined }, dCalls),
      sourcePath: "/r",
      destPath: "/d",
    });
    expect(r).toEqual({ carriedCommits: true });
    expect(dCalls.find(([c]) => c === "teleport_bundle_apply")?.[1]).toEqual({ path: "/d", data: "BUNDLE" });
    expect(dCalls.find(([c]) => c === "teleport_patch_apply")?.[1]).toEqual({ path: "/d", data: "PATCH" });
  });
  it.each([
    ["ahead", /newer commits/],
    ["diverged", /each made commits/],
    ["unknown", /does not have/],
  ])("refuses a %s destination before anything is applied", async (relation, message) => {
    const dCalls: Calls = [];
    await expect(
      carryRepoState({
        source: machine({ git_remote_url: "o", git_worktrees: [wt("/r", "bbb2222")], teleport_git_relation: relation }),
        dest: machine({ git_remote_url: "o", git_worktrees: [wt("/d", "aaa1111")] }, dCalls),
        sourcePath: "/r",
        destPath: "/d",
      }),
    ).rejects.toThrow(message);
    expect(dCalls.some(([c]) => c === "teleport_bundle_apply" || c === "teleport_patch_apply")).toBe(false);
  });
  it("a retry does not re-apply changes the destination already holds", async () => {
    const dCalls: Calls = [];
    await carryRepoState({
      source: machine({ git_remote_url: "o", git_worktrees: [wt("/r", "aaa1111")], teleport_patch_create: "PATCH" }),
      dest: machine({ git_remote_url: "o", git_worktrees: [wt("/d", "aaa1111")], teleport_patch_create: "PATCH" }, dCalls),
      sourcePath: "/r",
      destPath: "/d",
    });
    expect(dCalls.some(([c]) => c === "teleport_patch_apply")).toBe(false);
  });
});

describe("worktrees", () => {
  it("names the destination worktree like the source, as a sibling of the destination repo", () => {
    expect(destWorktreeRoot("/Users/a/canopy", "/Users/a/canopy-wt-lineage", "/workspace/canopy")).toBe("/workspace/canopy-wt-lineage");
    expect(destWorktreeRoot("/Users/a/canopy", "/Users/a/other", "/workspace/canopy")).toBeNull();
    expect(destWorktreeRoot("/Users/a/canopy", "/Users/a/canopy-wt-a/b", "/workspace/canopy")).toBeNull();
  });
  it("reuses a worktree already on the branch, refuses one on another, and creates a missing one", async () => {
    await expect(
      ensureDestWorktree({ dest: machine({ git_worktrees: [wt("/d-wt-x", "a", "agent/x")] }), destRepo: "/d", destRoot: "/d-wt-x", branch: "agent/x" }),
    ).resolves.toBeUndefined();
    await expect(
      ensureDestWorktree({ dest: machine({ git_worktrees: [wt("/d-wt-x", "a", "other")] }), destRepo: "/d", destRoot: "/d-wt-x", branch: "agent/x" }),
    ).rejects.toThrow(/not agent\/x/);
    const calls: Calls = [];
    let n = 0;
    await ensureDestWorktree({
      dest: machine({ git_worktrees: [wt("/d", "a")], git_worktree_add: () => (n++ === 0 ? { kind: "switched_failed", detail: "no such branch" } : { kind: "switched" }) }, calls),
      destRepo: "/d",
      destRoot: "/d-wt-x",
      branch: "agent/x",
    });
    const adds = calls.filter(([c]) => c === "git_worktree_add").map(([, a]) => a?.create);
    expect(adds).toEqual([false, true]);
    await expect(
      ensureDestWorktree({
        dest: machine({ git_worktrees: [wt("/d", "a")], git_worktree_add: { kind: "branch_in_worktree", holder: { path: "/elsewhere" } } }),
        destRepo: "/d",
        destRoot: "/d-wt-x",
        branch: "agent/x",
      }),
    ).rejects.toThrow(/another worktree/);
  });
  it("carrySendFiles for a worktree creates it, then carries between the two worktrees", async () => {
    const dCalls: Calls = [];
    let added = false;
    const send = carrySendFiles({
      source: machine({ git_remote_url: "o", git_worktrees: [wt("/r-wt-x", "aaa1111", "agent/x")], teleport_patch_create: "" }),
      dest: machine(
        {
          git_remote_url: "o",
          git_worktrees: () => (added ? [wt("/d", "aaa1111"), wt("/d-wt-x", "aaa1111", "agent/x")] : [wt("/d", "aaa1111")]),
          git_worktree_add: () => {
            added = true;
            return { kind: "switched" };
          },
        },
        dCalls,
      ),
      sourceRepo: "/r",
      worktree: { root: "/r-wt-x", branch: "agent/x" },
    });
    const plan = { destComponent: { path: "/d" } } as unknown as MovePlan;
    expect(await send(plan, null, () => {})).toEqual({ destRoot: "/d-wt-x", carriedCommits: false });
    expect(dCalls.find(([c]) => c === "git_worktree_add")?.[1]).toMatchObject({ path: "/d-wt-x", branch: "agent/x" });
  });
});

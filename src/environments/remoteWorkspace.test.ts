import { describe, expect, it, vi } from "vitest";
import { prepareRemoteWorkspace, type MachineInvoke } from "./remoteWorkspace";
import { rekeyDigests, fetchMachineDigests } from "./remoteDigests";
import { aliasPty, resetPtyRoutes } from "./ptyRoute";

const base = { cwd: "/w/app", name: "app", cliId: "claude", cliName: "Claude Code", bootstrap: true, now: new Date("2026-11-10T10:00:00Z") };
const host = {} as never;

function fake(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`no ${cmd}`);
    return h(args ?? {});
  }) as MachineInvoke;
  return { invoke, calls };
}

describe("prepareRemoteWorkspace", () => {
  it("does nothing when the agent is not to be isolated", async () => {
    const m = fake({});
    expect(await prepareRemoteWorkspace({ ...base, invoke: m.invoke, isolate: false })).toEqual({ cwd: "/w/app", notes: [], isolated: false });
    expect(m.calls).toHaveLength(0);
  });

  it("makes the worktree through that machine's git and copies config", async () => {
    const m = fake({
      git_repos: () => [{ path: "/w/app" }],
      git_worktree_add: (a) => ({ kind: "switched", message: "", path: a.path }),
      git_worktree_bootstrap: () => ({}),
    });
    const r = await prepareRemoteWorkspace({ ...base, invoke: m.invoke, isolate: true });
    expect(r.isolated).toBe(true);
    expect(r.cwd).toMatch(/^\/w\/app-wt-agent-claude-/);
    expect(m.calls.map((c) => c.cmd)).toEqual(["git_repos", "git_worktree_add", "git_worktree_bootstrap"]);
    expect(m.calls[1].args).toMatchObject({ repo: "/w/app", create: true });
  });

  it("falls back to the folder, with a note, when git there refuses or is absent", async () => {
    const refused = fake({ git_repos: () => [{ path: "/w/app" }], git_worktree_add: () => ({ kind: "branch_in_worktree" }) });
    const r1 = await prepareRemoteWorkspace({ ...base, invoke: refused.invoke, isolate: true });
    expect(r1).toMatchObject({ cwd: "/w/app", isolated: false });
    expect(r1.notes).toHaveLength(1);
    const noRepo = fake({ git_repos: () => [] });
    expect((await prepareRemoteWorkspace({ ...base, invoke: noRepo.invoke, isolate: true })).notes[0]).toMatch(/not inside a Git repository/);
    const thrown = fake({ git_repos: () => [{ path: "/w/app" }] });
    expect((await prepareRemoteWorkspace({ ...base, invoke: thrown.invoke, isolate: true })).isolated).toBe(false);
  });

  it("keeps the worktree and says so when config copy fails", async () => {
    const m = fake({
      git_repos: () => [{ path: "/w/app" }],
      git_worktree_add: (a) => ({ kind: "switched", path: a.path }),
    });
    const r = await prepareRemoteWorkspace({ ...base, invoke: m.invoke, isolate: true });
    expect(r.isolated).toBe(true);
    expect(r.notes[0]).toMatch(/ignored config/);
  });
});

describe("remote digests", () => {
  it("keeps only terminals this window started, re-keyed to their alias", () => {
    resetPtyRoutes();
    const alias = aliasPty("remote:w1", 3, host, false);
    const rows = [
      { session_id: "a", surface: "3", instance: "theirs" },
      { session_id: "b", surface: "9" },
      { session_id: "c" },
    ] as never[];
    const out = rekeyDigests("remote:w1", rows, "mine");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ session_id: "a", surface: String(alias), instance: "mine" });
    // Another machine's terminal 3 is not ours.
    expect(rekeyDigests("remote:w2", rows, "mine")).toHaveLength(0);
  });

  it("a machine that does not answer adds nothing", async () => {
    resetPtyRoutes();
    const alias = aliasPty("remote:w1", 3, host, false);
    const ok = { env: "remote:w1", invoke: vi.fn(async () => [{ session_id: "a", surface: "3" }]) as never };
    const bad = { env: "remote:w2", invoke: vi.fn(async () => { throw new Error("down"); }) as never };
    const out = await fetchMachineDigests([ok, bad], null);
    expect(out.map((d) => d.surface)).toEqual([String(alias)]);
  });

  it("puts a pull request's head in the workspace when asked", async () => {
    const m = fake({
      git_repos: () => [{ path: "/w/app" }],
      git_worktree_add_pr: (a) => ({ kind: "switched", path: a.path }),
      git_worktree_bootstrap: () => ({}),
    });
    const r = await prepareRemoteWorkspace({ ...base, invoke: m.invoke, isolate: false, pr: { number: 7, branch: "feat/x" } });
    expect(r.isolated).toBe(true);
    expect(m.calls[1]).toMatchObject({ cmd: "git_worktree_add_pr", args: { repo: "/w/app", number: 7, branch: "feat/x" } });
  });
});

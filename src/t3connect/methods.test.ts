import { describe, expect, it, vi } from "vitest";
import { listShell } from "./methods";
import type { T3RpcClient } from "./rpc";

function fakeRpc(items: unknown[]) {
  const cancel = vi.fn();
  const rpc = {
    stream: (_m: string, _p: unknown, on: (v: unknown[]) => void) => {
      queueMicrotask(() => on(items));
      return { cancel, done: new Promise<void>(() => {}) };
    },
  } as unknown as T3RpcClient;
  return { rpc, cancel };
}

describe("listShell", () => {
  it("returns unarchived projects and threads from the first snapshot", async () => {
    const { rpc, cancel } = fakeRpc([
      { kind: "synchronized" },
      { kind: "snapshot", snapshot: {
        projects: [{ id: "p", title: "P", workspaceRoot: "/p" }, { id: "q", title: "Q", workspaceRoot: "/q", archivedAt: "x" }],
        threads: [{ id: "t1", projectId: "p", title: "One", status: "running" }, { id: "t2", archivedAt: "x" }, { nope: true }],
      } },
    ]);
    const shell = await listShell(rpc);
    expect(shell.projects.map((p) => p.id)).toEqual(["p"]);
    expect(shell.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(cancel).toHaveBeenCalled();
  });

  it("treats a snapshot without threads as none", async () => {
    const { rpc } = fakeRpc([{ kind: "snapshot", snapshot: { projects: [] } }]);
    await expect(listShell(rpc)).resolves.toEqual({ projects: [], threads: [] });
  });
});

import { describe, expect, it, vi } from "vitest";
import { defaultModel, listShell, threadLaunchInput, threadStatus, usableProviders } from "./methods";
import type { ServerConfig, ServerProvider, ThreadProjection } from "./contracts";
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

const provider = (over: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, installed: true, status: "ready",
  models: [{ slug: "old", name: "Old", isLegacy: true }, { slug: "new", name: "New" }, { slug: "best", name: "Best", isDefault: true }], ...over,
});

describe("usableProviders", () => {
  const config = (providers: unknown) => ({ providers } as unknown as ServerConfig);
  it("offers installed, enabled, signed-in providers that have a model", () => {
    const ok = provider();
    const signedOut = provider({ instanceId: "codex", status: "error", models: [] });
    const disabled = provider({ instanceId: "off", enabled: false });
    const missing = provider({ instanceId: "gone", installed: false });
    const noModels = provider({ instanceId: "bare", models: [] });
    expect(usableProviders(config([ok, signedOut, disabled, missing, noModels, null, { instanceId: 4 }])).map(p => p.instanceId)).toEqual(["claudeAgent"]);
  });
  it("offers none when the machine says nothing usable", () => {
    expect(usableProviders(config(undefined))).toEqual([]);
    expect(usableProviders(config("nonsense"))).toEqual([]);
  });
});

describe("defaultModel", () => {
  it("takes the model the provider marks, else the first current one", () => {
    expect(defaultModel(provider())).toBe("best");
    expect(defaultModel(provider({ models: [{ slug: "old", name: "Old", isLegacy: true }, { slug: "new", name: "New" }] }))).toBe("new");
    expect(defaultModel(provider({ models: [] }))).toBeUndefined();
  });
});

describe("threadStatus", () => {
  const projection = (over: Partial<ThreadProjection>) => ({ thread: {}, runs: [], messages: [], ...over }) as unknown as ThreadProjection;
  it("reads what a thread is doing from its last run, its streaming message and its open questions", () => {
    expect(threadStatus(projection({ runs: [{ id: "r", status: "preparing" }] }))).toBe("working");
    expect(threadStatus(projection({ runs: [{ id: "r", status: "completed" }], messages: [{ id: "m", role: "assistant", text: "x", streaming: true, createdAt: "" }] }))).toBe("working");
    expect(threadStatus(projection({ runs: [{ id: "r", status: "completed" }] }))).toBe("idle");
    expect(threadStatus(projection({ runs: [{ id: "r", status: "failed" }] }))).toBe("failed");
    expect(threadStatus(projection({ runs: [{ id: "r", status: "running" }], runtimeRequests: [{ status: "pending" }] }))).toBe("waiting");
  });
  it("is idle before anything has run", () => {
    expect(threadStatus(projection({}))).toBe("idle");
  });
});

describe("threadLaunchInput", () => {
  it("starts in the project's own folder, titled by the first line, with the prompt as the opening message", () => {
    const input = threadLaunchInput({ projectId: "p1", provider: provider(), model: "best", mode: "approval-required", prompt: "  Fix the build\nthen run tests  " });
    expect(input).toMatchObject({
      projectId: "p1", title: "Fix the build", modelSelection: { instanceId: "claudeAgent", model: "best" },
      runtimeMode: "approval-required", interactionMode: "default", workspaceStrategy: { type: "root" },
      initialMessage: { text: "Fix the build\nthen run tests", attachments: [] },
    });
    expect(input.commandId).toMatch(/[0-9a-f-]{36}/);
  });
  it("never sends an empty or oversized title", () => {
    expect(threadLaunchInput({ projectId: "p", provider: provider(), model: "m", mode: "auto", prompt: "x".repeat(500) }).title).toHaveLength(80);
    expect(threadLaunchInput({ projectId: "p", provider: provider(), model: "m", mode: "auto", prompt: "   " }).title).toBe("Canopy thread");
    expect(threadLaunchInput({ projectId: "p", provider: provider(), model: "m", mode: "auto", prompt: "\n\nstart" }).title).toBe("start");
  });
});

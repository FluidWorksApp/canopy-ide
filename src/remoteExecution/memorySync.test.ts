import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  workspace: true,
  calls: [] as [string, Record<string, unknown>][],
  answers: {} as Record<string, unknown>,
}));
const ledger = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  appended: [] as [string, Record<string, unknown>][],
  listener: null as null | ((e: { kind: string }) => void),
}));

vi.mock("../host", () => ({
  isWorkspaceHost: () => host.workspace,
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    host.calls.push([command, args]);
    return host.answers[command];
  }),
}));
vi.mock("../ledger", () => ({
  queryLedger: vi.fn(async (root: string) => ledger.rows[root] ?? []),
  appendLedger: vi.fn(async (root: string, draft: Record<string, unknown>) => {
    ledger.appended.push([root, draft]);
    return { ...draft, id: "new", ts: 1, root };
  }),
  subscribeLedger: vi.fn((_root: string, cb: (e: { kind: string }) => void) => {
    ledger.listener = cb;
    return () => {
      ledger.listener = null;
    };
  }),
}));
vi.mock("../settings", () => ({ getSettings: () => ({ memoryFactExpiryDays: 90, memoryDecisionExpiryDays: 180 }) }));

import { pullWorkspaceProposals, pushWorkspaceMemory, rootFor, startMemorySync, syncWorkspaceMemory } from "./memorySync";

const NOW = 1_800_000_000_000;
const mem = (memoryId: string, status: string, expiresAt = NOW + 1000) => ({
  id: `e-${memoryId}`,
  kind: "memory",
  ts: NOW - 10,
  root: "/workspace/api",
  author: { kind: "human", name: "Ash" },
  scope: "project",
  data: { memoryId, type: "decision", text: `Memory ${memoryId}`, why: "", confidence: 0.8, createdAt: NOW - 10, source: "human", provenance: { files: [] } },
  expiresAt,
  status,
});

beforeEach(() => {
  host.workspace = true;
  host.calls = [];
  host.answers = {};
  ledger.rows = {};
  ledger.appended = [];
  ledger.listener = null;
});

describe("team memory sync for a cloud workspace", () => {
  it("copies only what agents may be told, once per memory, across projects", async () => {
    ledger.rows["/workspace/api"] = [mem("a", "approved"), mem("q", "quarantined"), mem("p", "proposed"), mem("old", "approved", NOW - 1)];
    ledger.rows["/workspace/web"] = [mem("a", "approved"), mem("b", "approved")];
    expect(await pushWorkspaceMemory(["/workspace/api", "/workspace/web"], NOW)).toBe(2);
    const [command, args] = host.calls[0];
    expect(command).toBe("workspace_memory_sync");
    expect(args.root).toBe("/workspace/api");
    expect((args.entries as { data: { memoryId: string } }[]).map((e) => e.data.memoryId)).toEqual(["a", "b"]);
  });

  it("files proposals under the project they came from as proposed, skips known ones, and acks", async () => {
    ledger.rows["/workspace/web"] = [mem("mem-known", "proposed")];
    const proposal = (memoryId: string, cwd: string | null) => ({
      memoryId,
      ptyId: 7,
      terminal: "api agent",
      cwd,
      by: "Ada",
      scope: "team",
      subject: "Never call billing from a handler",
      data: { memoryId, type: "constraint", text: "Never call billing from a handler", why: "slow", confidence: 0.5, createdAt: NOW, source: "agent", provenance: { files: ["src/billing.ts"] } },
      expiresAt: NOW + 5,
      proposedMs: NOW,
    });
    host.answers.workspace_memory_proposals = [proposal("mem-new", "/workspace/web/src"), proposal("mem-known", "/workspace/web")];
    expect(await pullWorkspaceProposals(["/workspace/api", "/workspace/web"])).toBe(1);
    expect(ledger.appended).toHaveLength(1);
    const [root, draft] = ledger.appended[0];
    expect(root).toBe("/workspace/web");
    expect(draft).toMatchObject({
      kind: "memory",
      status: "proposed",
      author: { kind: "agent", name: "Ada", ptyId: 7 },
      scope: "team",
      ref: { kind: "pty", id: "7" },
      expiresAt: NOW + 5,
      data: { memoryId: "mem-new", source: "agent" },
    });
    expect(host.calls.at(-1)).toEqual(["workspace_memory_ack", { ids: ["mem-new", "mem-known"] }]);
  });

  it("picks the deepest open project holding the agent's directory", () => {
    expect(rootFor("/workspace/a/b/c", ["/workspace/a", "/workspace/a/b"])).toBe("/workspace/a/b");
    expect(rootFor(null, ["/workspace/a"])).toBe("/workspace/a");
    expect(rootFor("/elsewhere", [])).toBeNull();
  });

  it("does nothing outside a cloud workspace", async () => {
    host.workspace = false;
    await syncWorkspaceMemory(["/r"]);
    const stop = startMemorySync(() => ["/r"]);
    stop();
    expect(host.calls).toEqual([]);
    expect(ledger.listener).toBeNull();
  });

  it("re-pushes after a memory changes here and polls for proposals", async () => {
    vi.useFakeTimers();
    try {
      host.answers.workspace_memory_proposals = [];
      const stop = startMemorySync(() => ["/workspace/api"]);
      ledger.listener?.({ kind: "plan" });
      ledger.listener?.({ kind: "memory" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(host.calls.map(([c]) => c)).toEqual(["workspace_memory_sync"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.calls.map(([c]) => c)).toContain("workspace_memory_proposals");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

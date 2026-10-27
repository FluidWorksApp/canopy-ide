import { describe, expect, it, vi } from "vitest";
import { harnessCommand, type HarnessIo } from "./harnessCommands";

function io(answers: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const value: HarnessIo = {
    query: vi.fn(async (store: string, action: string, args?: Record<string, unknown>) => { calls.push(["query", store, action, args]); return answers[`${store}.${action}`] as never; }),
    action: vi.fn(async (kind: string, args: Record<string, unknown>) => { calls.push(["action", kind, args]); return answers[kind] as never; }),
    native: vi.fn(async (command: string, args: Record<string, unknown>) => { calls.push(["native", command, args]); return answers[command] as never; }),
    desktop: vi.fn(async (command: string, args: Record<string, unknown>) => { calls.push(["desktop", command, args]); return answers[`desktop.${command}`] as never; }),
    instance: "remote-alice",
  };
  return { value, calls };
}

describe("workspace research and mesh commands", () => {
  it("reads research and claims from the service, unwrapping its answers", async () => {
    const { value, calls } = io({ "research.list": { items: [{ id: "r1" }] }, "research.search": { research: [{ id: "r2" }] }, "claims.history": { items: [{ path: "a" }] }, "research.read_file": { text: "hi" }, "research.for_file": { id: null } });
    expect(await harnessCommand("research_list", { projectId: "p", status: ["open"], limit: 5 }, value)).toEqual([{ id: "r1" }]);
    expect(await harnessCommand("research_search", { projectId: "p", query: "x" }, value)).toEqual([{ id: "r2" }]);
    expect(await harnessCommand("context_claim_history_for_path", { path: "/workspace/a" }, value)).toEqual([{ path: "a" }]);
    expect(await harnessCommand("research_read_file", { projectId: "p", id: "r1", path: "sources/a.md" }, value)).toBe("hi");
    expect(await harnessCommand("research_for_file", { projectId: "p", path: "/workspace/x.md" }, value)).toBeNull();
    expect(calls.slice(0, 3)).toEqual([
      ["query", "research", "list", { statuses: ["open"], limit: 5 }],
      ["query", "research", "search", { query: "x" }],
      ["query", "claims", "history", { path: "/workspace/a" }],
    ]);
  });
  it("writes research with the service's field names", async () => {
    const { value, calls } = io({ research_write: { id: "r1" } });
    await harnessCommand("research_start", { projectId: "p", title: "T", body: "B", ptyId: 4, tags: ["x"] }, value);
    await harnessCommand("research_update", { projectId: "p", id: "r1", append: "more", openQuestions: ["q"] }, value);
    await harnessCommand("research_set_status", { projectId: "p", id: "r1", status: "researched" }, value);
    expect(calls).toEqual([
      ["action", "research_write", { action: "start", title: "T", pty_id: 4, tags: ["x"], text: "B", instance: "remote-alice" }],
      ["action", "research_write", { action: "append", text: "more", id: "r1", open_questions: ["q"] }],
      ["action", "research_write", { action: "status", id: "r1", status: "researched", by: "" }],
    ]);
    await expect(harnessCommand("research_update", { id: "r1", body: "all new" }, value)).rejects.toThrow(/append/);
  });
  it("imports workspace files by sending their text, and sweeps with the service's plan", async () => {
    const { value, calls } = io({ fs_read_range: { b64: btoa("# Notes"), size: 7 }, fs_list_files: ["/workspace/a.md", "/workspace/b.ts", "/workspace/c.md"], "research.sweep_plan": { candidates: ["/workspace/a.md"], matched: 2 } });
    await harnessCommand("research_import", { projectId: "p", path: "/workspace/a.md" }, value);
    expect(calls.at(-1)).toEqual(["action", "research_write", { action: "import_text", path: "/workspace/a.md", text: "# Notes" }]);
    expect(await harnessCommand("research_sweep", { projectId: "p", roots: ["/workspace"] }, value)).toEqual({ imported: 1, matched: 2, skipped: 0 });
    expect(calls).toContainEqual(["query", "research", "sweep_plan", { paths: ["/workspace/a.md", "/workspace/c.md"] }]);
    expect(await harnessCommand("research_dir", { projectId: "p", id: "r1" }, value)).toBe("");
  });
  it("refuses imports larger than a harness action carries", async () => {
    const { value } = io({ fs_read_range: { b64: "", size: 900 * 1024 } });
    await expect(harnessCommand("research_import", { path: "/workspace/big.md" }, value)).rejects.toThrow(/imports files up to/);
  });
  it("sends mesh changes to the service, and a desktop job's updates to the desktop", async () => {
    const { value, calls } = io({ mesh_sever: { items: [{ a: "1", b: "2" }] }, mesh_job_update: { id: "m1" }, "desktop.context_mesh_job_update": "m2" });
    expect(await harnessCommand("context_mesh_sever", { a: "1", b: "2", severed: true }, value)).toEqual([{ a: "1", b: "2" }]);
    expect(await harnessCommand("context_release_claim", { ownerKey: "k" }, value)).toBeNull();
    expect(await harnessCommand("context_mesh_job_update", { ptyId: 3, instance: "remote-alice", jobId: "j", text: "t" }, value)).toBe("m1");
    expect(await harnessCommand("context_mesh_job_update", { ptyId: 3, instance: "desktop-1", jobId: "j", text: "t" }, value)).toBe("m2");
    expect(calls).toContainEqual(["action", "claim_release", { ownerKey: "k" }]);
  });
});

describe("agent awareness in a workspace", () => {
  it("claims a hotspot and types a note through the service", async () => {
    const { value, calls } = io({ hotspot_claim: { ok: true, message: "Claimed 1 path(s)." }, mesh_job_update: { id: "m4" } });
    expect(await harnessCommand("context_hotspot_claim", { ptyId: 2, paths: ["/workspace/src/routes.ts"], owner: "Ana", note: "hot" }, value)).toBe("Claimed 1 path(s).");
    expect(await harnessCommand("context_mesh_job_update", { ptyId: 3, instance: "remote-alice", jobId: "aw-1", text: "Heads-up", refKind: "awareness" }, value)).toBe("m4");
    expect(calls).toEqual([
      ["action", "hotspot_claim", { ptyId: 2, paths: ["/workspace/src/routes.ts"], owner: "Ana", note: "hot" }],
      ["action", "mesh_job_update", { ptyId: 3, instance: "remote-alice", jobId: "aw-1", text: "Heads-up", refKind: "awareness" }],
    ]);
  });
});

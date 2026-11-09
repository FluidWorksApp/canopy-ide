import { describe, expect, it } from "vitest";
import { buildUnifiedRows, filterRows, groupByProject, type UnifiedInput } from "./unified";

const input: UnifiedInput = {
  local: { projects: [{ id: "p1", name: "Canopy" }, { id: "p2", name: "Docs" }], agents: [{ id: "a1", name: "claude", project: "Canopy", branch: "feat/x" }] },
  remotes: [
    { workspaceId: "w1", name: "Cloud", state: "ready", projects: [{ id: "r1", name: "canopy" }], agents: [{ id: "ra", name: "codex", project: "canopy", status: "busy" }] },
    { workspaceId: "w2", name: "Other", state: "ready" },
    { workspaceId: "w3", name: "Asleep", state: "stopped", projects: [] },
  ],
  t3: [{ machineId: "m1", label: "Studio", projects: [{ id: "tp", title: "Canopy" }], threads: [{ id: "t1", name: "t", project: "tp", status: "running", branch: "main" }] }],
  jobs: [{ jobId: "j1", title: "Fix tests", workspace: "Cloud", target: "w1", workspaceId: "w1" }],
};

describe("buildUnifiedRows", () => {
  const rows = buildUnifiedRows(input);
  it("lists local, remote, t3 and jobs together with target badges", () => {
    expect(rows.map((r) => r.targetLabel)).toEqual(expect.arrayContaining(["This Mac", "Cloud", "Studio"]));
    expect(rows.filter((r) => r.kind === "thread")).toMatchObject([{ name: "Canopy", status: "running", branch: "main", target: { kind: "t3", machineId: "m1" } }]);
    expect(rows.find((r) => r.kind === "job")).toMatchObject({ name: "Fix tests", target: { kind: "remote", workspaceId: "w1" } });
  });
  it("adds a needsSetup placeholder only where a known, online remote lacks a local project", () => {
    const setup = rows.filter((r) => r.needsSetup);
    expect(setup).toHaveLength(1);
    expect(setup[0]).toMatchObject({ name: "Docs", target: { kind: "remote", workspaceId: "w1" }, status: "not set up" });
  });
});

describe("groupByProject and filterRows", () => {
  const rows = buildUnifiedRows(input);
  it("groups the same project across targets case-insensitively", () => {
    const g = groupByProject(rows).find((x) => x.key === "canopy")!;
    expect(new Set(g.rows.map((r) => r.target.kind))).toEqual(new Set(["local", "remote", "t3"]));
  });
  it("filters by target, kind and text", () => {
    expect(filterRows(rows, { target: "t3" }).every((r) => r.target.kind === "t3")).toBe(true);
    expect(filterRows(rows, { kind: "agent" }).every((r) => r.kind === "agent")).toBe(true);
    expect(filterRows(rows, { text: "fix" })).toHaveLength(1);
    expect(filterRows(rows, {})).toHaveLength(rows.length);
  });
});

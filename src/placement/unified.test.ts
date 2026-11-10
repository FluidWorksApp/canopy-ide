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
  it("adds setup placeholders by project identity even when names collide", () => {
    const setup = rows.filter((r) => r.needsSetup);
    expect(setup).toHaveLength(2);
    expect(setup).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: "p1", name: "Canopy", target: { kind: "remote", workspaceId: "w1" }, status: "not set up" }),
      expect.objectContaining({ projectId: "p2", name: "Docs", target: { kind: "remote", workspaceId: "w1" }, status: "not set up" }),
    ]));
  });
});

describe("groupByProject and filterRows", () => {
  const rows = buildUnifiedRows(input);
  it("groups the same project across targets case-insensitively", () => {
    const g = groupByProject(rows).find((x) => x.key === "canopy")!;
    expect(new Set(g.rows.map((r) => r.target.kind))).toEqual(new Set(["local", "remote", "t3"]));
  });
  it("filters by stable named-machine ID, kind and text", () => {
    const t3Rows = filterRows(rows, { target: "t3:m1" });
    expect(t3Rows.length).toBeGreaterThan(0);
    expect(t3Rows.every((r) => r.target.kind === "t3" && r.target.machineId === "m1")).toBe(true);
    const remoteRows = filterRows(rows, { target: "remote:w1" });
    expect(remoteRows.length).toBeGreaterThan(0);
    expect(remoteRows.every((r) => r.target.kind === "remote" && r.target.workspaceId === "w1")).toBe(true);
    expect(filterRows(rows, { kind: "agent" }).every((r) => r.kind === "agent")).toBe(true);
    expect(filterRows(rows, { text: "studio" }).every((r) => r.targetLabel === "Studio")).toBe(true);
    expect(filterRows(rows, { text: "fix" })).toHaveLength(1);
    expect(filterRows(rows, {})).toHaveLength(rows.length);
  });
});

describe("sessions read from outside", () => {
  it("lists a workspace's running sessions as Session rows on that machine", () => {
    const rows = buildUnifiedRows({
      local: { projects: [], agents: [] },
      remotes: [{ workspaceId: "w9", name: "Coraa Workstation", state: "ready", sessions: [{ id: "4", title: "claude · api" }] }],
      t3: [],
      jobs: [],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        id: "remote:w9:session:4",
        name: "claude · api",
        kind: "session",
        targetLabel: "Coraa Workstation",
        status: "running",
        target: { kind: "remote", workspaceId: "w9" },
      }),
    ]);
  });

  it("filters to sessions", () => {
    const rows = buildUnifiedRows({
      local: { projects: [{ id: "p", name: "P" }], agents: [] },
      remotes: [{ workspaceId: "w9", name: "W", state: "ready", sessions: [{ id: "1", title: "x" }] }],
      t3: [],
      jobs: [],
    });
    expect(filterRows(rows, { kind: "session" }).map((r) => r.kind)).toEqual(["session"]);
  });
});

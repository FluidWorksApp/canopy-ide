import { describe, expect, it, vi } from "vitest";
import { createMeshJobs, localRemoteJobs, needsApproval, pickWorkspace, type JobSession, type MeshJobDeps, type RemoteJob } from "./meshJobs";
import type { Device } from "./teamMessaging/client";
import type { JobRequest, JobStatus } from "./teamMessaging/jobSchema";
import type { TeamJobEvent } from "./teamMessaging/session";

const NOW = 1_800_000_000_000;
const seen = (ago: number) => new Date(NOW - ago).toISOString();
const device = (id: string, user: string, ago = 1000): Device => ({ id, user_id: user, public_keys: {} as Device["public_keys"], last_seen_at: seen(ago) });

function session(over: Partial<JobSession> = {}): JobSession & { submitJob: ReturnType<typeof vi.fn>; sendJobStatus: ReturnType<typeof vi.fn> } {
  const devices = [device("me-laptop", "alice"), device("me-desktop", "alice"), device("bob-1", "bob"), device("cara-1", "cara", 600_000)];
  return {
    team: "t1",
    user: "alice",
    members: () => ({ alice: "Alice", bob: "Bob", cara: "Cara" }),
    devices: () => devices,
    deviceId: () => "me-laptop",
    submitJob: vi.fn(async (_job: JobRequest, recipient: string) => devices.find((d) => d.user_id === recipient && d.id !== "me-laptop")!),
    sendJobStatus: vi.fn(async () => {}),
    ...over,
  } as never;
}

function setup(over: Partial<MeshJobDeps> = {}, s = session()) {
  let n = 0;
  const deps = {
    workspaces: () => [{ name: "api" }, { name: "web" }],
    start: vi.fn(async (req: { project: string }) => ({ started: true, project: req.project, note: "ok", runId: `run-${++n}` })),
    sessions: () => [s],
    teamName: () => "Core",
    report: vi.fn(async () => "m1"),
    post: vi.fn(() => "attention-1"),
    resolve: vi.fn(),
    now: () => NOW,
    newId: () => `job-000${++n}`,
    ...over,
  };
  return { jobs: createMeshJobs(deps as MeshJobDeps), deps, s };
}

const origin = { ptyId: 7, instance: "inst" };
const job = (over: Partial<JobRequest> = {}): JobRequest => ({ id: "job-incoming-1", title: "Fix flaky test", brief: "Make test X stable", workspace: null, created: NOW, ...over });
const incoming = (user: string, j = job(), deviceId = `${user}-1`): TeamJobEvent => ({ kind: "job", team: "t1", user: "alice", sender: { user, device: deviceId, name: user === "alice" ? "Alice" : "Bob" }, job: j });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the approval rule", () => {
  it("lets only this same account skip approval", () => {
    expect(needsApproval({ user: "alice", device: "d" }, "alice")).toBe(false);
    expect(needsApproval({ user: "bob", device: "d" }, "alice")).toBe(true);
  });

  it("picks the named workspace, else the only one, else nobody", () => {
    expect(pickWorkspace("API", [{ name: "api" }, { name: "web" }])).toBe("api");
    expect(pickWorkspace("nope", [{ name: "api" }])).toBeNull();
    expect(pickWorkspace(null, [{ name: "api" }])).toBe("api");
    expect(pickWorkspace(null, [{ name: "api" }, { name: "web" }])).toBeNull();
  });
});

describe("submitting a job", () => {
  it("starts a job in another workspace of this window and reports its outcome back", async () => {
    const { jobs, deps } = setup();
    const result = await jobs.submit({ brief: "Add a health endpoint", workspace: "web", ...origin });
    expect(result).toMatchObject({ status: "started", workspace: "web" });
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ project: "web", label: "Add a health endpoint" }));
    jobs.runEnded("run-2", "done", "Endpoint added");
    expect(deps.report).toHaveBeenCalledWith(7, "inst", result.jobId, expect.stringContaining("done: Endpoint added"));
  });

  it("refuses a workspace that doesn't exist and a caller with no terminal", async () => {
    const { jobs } = setup();
    await expect(jobs.submit({ brief: "x", workspace: "mobile", ...origin })).rejects.toThrow('No workspace called "mobile"');
    await expect(jobs.submit({ brief: "x", workspace: "web" })).rejects.toThrow("agent terminal");
  });

  it("sends a teammate's job over the team channel and relays only that device's answers", async () => {
    const { jobs, deps, s } = setup();
    const result = await jobs.submit({ brief: "Review my PR", member: "bob", ...origin });
    expect(result).toMatchObject({ status: "awaiting-approval", to: "Bob", device: "bob-1" });
    expect(s.submitJob).toHaveBeenCalledWith(expect.objectContaining({ brief: "Review my PR" }), "bob", undefined);
    const status = (state: "accepted" | "done", from: string) =>
      jobs.receive({ kind: "job-status", team: "t1", user: "alice", sender: { user: "x", device: from }, status: { jobId: result.jobId, state, detail: "", created: NOW } });
    status("accepted", "cara-1");
    expect(deps.report).not.toHaveBeenCalled();
    status("accepted", "bob-1");
    status("done", "bob-1");
    status("done", "bob-1");
    expect(deps.report).toHaveBeenCalledTimes(2);
    expect(deps.report).toHaveBeenLastCalledWith(7, "inst", result.jobId, 'Job "Review my PR" (Bob) done.');
  });

  it("reaches this account's other machine as \"me\"", async () => {
    const { jobs, s } = setup();
    const result = await jobs.submit({ brief: "Run the e2e suite", member: "me", workspace: "api", ...origin });
    expect(result).toMatchObject({ status: "sent", device: "me-desktop" });
    expect(s.submitJob).toHaveBeenCalledWith(expect.objectContaining({ workspace: "api" }), "alice", undefined);
  });

  it("refuses a name that matches nobody, and asks for an id when it matches several", async () => {
    const { jobs } = setup({}, session({ members: () => ({ alice: "Alice", bob: "Sam", cara: "Sam" }) }));
    await expect(jobs.submit({ brief: "x", member: "dave", ...origin })).rejects.toThrow('No teammate called "dave"');
    await expect(jobs.submit({ brief: "x", member: "sam", ...origin })).rejects.toThrow("names 2 teammates");
  });

  it("passes on why a member can't be reached", async () => {
    const s = session({ submitJob: vi.fn(async () => { throw new Error("Not connected: no device of that member is online in Canopy right now."); }) });
    const { jobs } = setup({}, s);
    await expect(jobs.submit({ brief: "x", member: "cara", ...origin })).rejects.toThrow("Not connected");
  });
});

describe("receiving a job", () => {
  it("holds a teammate's job for approval — nothing runs until the user says so", async () => {
    const { jobs, deps, s } = setup();
    jobs.receive(incoming("bob", job({ workspace: "api" })));
    expect(deps.start).not.toHaveBeenCalled();
    expect(jobs.inbox()).toHaveLength(1);
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ kind: "question", title: "Bob wants your agent to: Fix flaky test" }));

    await jobs.approve("job-incoming-1", "web");
    expect(jobs.inbox()).toHaveLength(0);
    expect(deps.resolve).toHaveBeenCalledWith("attention-1", "answered");
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ project: "web", prompt: expect.stringContaining("Bob (your Canopy teammate)") }));
    expect(s.sendJobStatus.mock.calls.map(([st, to]) => [st.state, to])).toEqual([["accepted", "bob-1"], ["started", "bob-1"]]);

    jobs.runEnded("run-1", "done", "Stabilised");
    await flush();
    expect(s.sendJobStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: "done", detail: "Stabilised" }), "bob-1");
  });

  it("tells the sender when the user declines, and acts on a replayed job once", async () => {
    const { jobs, deps, s } = setup();
    jobs.receive(incoming("bob"));
    jobs.receive(incoming("bob"));
    expect(jobs.inbox()).toHaveLength(1);
    await jobs.decline("job-incoming-1");
    expect(s.sendJobStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "declined" }), "bob-1");
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("starts a job from this account's other machine on its own", async () => {
    const { jobs, deps, s } = setup();
    jobs.receive(incoming("alice", job({ workspace: "api" }), "me-desktop"));
    await flush();
    expect(jobs.inbox()).toHaveLength(0);
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ project: "api" }));
    expect(s.sendJobStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "started" }), "me-desktop");
  });

  it("asks where to run an own-account job that names no workspace here", () => {
    const { jobs, deps } = setup();
    jobs.receive(incoming("alice", job({ workspace: "mobile" }), "me-desktop"));
    expect(deps.start).not.toHaveBeenCalled();
    expect(jobs.inbox()[0]).toMatchObject({ sameAccount: true });
  });

  it("declines on arrival rather than bury a full inbox", () => {
    const { jobs, s } = setup();
    for (let i = 0; i < 21; i++) jobs.receive(incoming("bob", job({ id: `job-incoming-${100 + i}` })));
    expect(jobs.inbox()).toHaveLength(20);
    expect(s.sendJobStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-incoming-120", state: "declined" }), "bob-1");
  });

  it("reports a failed launch back to the sender", async () => {
    const { jobs, s } = setup({ start: vi.fn(async () => ({ started: false, project: "api", note: "No agent CLI installed" })) });
    jobs.receive(incoming("bob"));
    await jobs.approve("job-incoming-1", "api");
    expect(s.sendJobStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", detail: "No agent CLI installed" }), "bob-1");
  });
});

describe("targets", () => {
  it("lists workspaces, this account's other machines and teammates with who is online", () => {
    const { jobs } = setup();
    const t = jobs.targets();
    expect(t.workspaces).toEqual(["api", "web"]);
    expect(t.myMachines).toEqual([{ device: "me-desktop", team: "Core", online: true, lastSeen: seen(1000) }]);
    expect(t.teammates.map((p) => [p.name, p.online])).toEqual([["Bob", true], ["Cara", false]]);
  });
});

describe("jobs for a cloud workspace", () => {
  const WS = "ws-22222222-2222-4222-8222-222222222222";
  const host = { ...device("host-1", "alice"), kind: "host" as const, workspaceIds: [WS] };
  const memory = () => {
    let rows: RemoteJob[] = [];
    return { load: () => rows, put: (r: RemoteJob) => { rows = [...rows.filter((x) => x.jobId !== r.jobId), r]; }, remove: (id: string) => { rows = rows.filter((x) => x.jobId !== id); }, rows: () => rows };
  };
  const cloud = () => [{ id: WS, name: "cloud-api" }];
  const status = (state: JobStatus["state"], jobId: string, over: Partial<TeamJobEvent> = {}): TeamJobEvent =>
    ({ kind: "job-status", team: "t1", user: "alice", workspace: WS, sender: { user: "alice", device: "host-1" }, status: { jobId, state, detail: "d", created: NOW }, ...over }) as TeamJobEvent;

  it("sends to the workspace's host device and survives a restart until the final status", async () => {
    const store = memory();
    const submitWorkspaceJob = vi.fn(async () => host);
    const s = session({ hosts: () => [host], submitWorkspaceJob });
    const { jobs } = setup({ cloudWorkspaces: cloud, remoteJobs: store }, s);
    const result = await jobs.submit({ brief: "Run the suite", workspace: "cloud-api", agent: "reviewer", ...origin });
    expect(result).toMatchObject({ status: "sent", workspace: "cloud-api", device: "host-1" });
    expect(submitWorkspaceJob).toHaveBeenCalledWith(expect.objectContaining({ workspace: WS, target: { name: "reviewer" } }), WS);
    expect(store.rows()).toHaveLength(1);
    expect(jobs.targets().cloudWorkspaces).toEqual([{ id: WS, name: "cloud-api", reachable: true }]);

    const restarted = setup({ cloudWorkspaces: cloud, remoteJobs: store }, s);
    restarted.jobs.receive(status("started", result.jobId, { workspace: "ws-other" }));
    restarted.jobs.receive(status("started", result.jobId, { sender: { user: "alice", device: "bob-1" } }));
    expect(restarted.deps.report).not.toHaveBeenCalled();
    restarted.jobs.receive(status("refused", result.jobId));
    expect(restarted.deps.report).toHaveBeenCalledWith(7, "inst", result.jobId, expect.stringContaining("refused"));
    expect(store.rows()).toHaveLength(0);
  });

  it("messages an agent in a cloud workspace through its service", async () => {
    const sendWorkspaceMessage = vi.fn(async () => host);
    const { jobs } = setup({ cloudWorkspaces: cloud }, session({ hosts: () => [host], sendWorkspaceMessage }));
    await expect(jobs.message({ workspace: "cloud-api", text: "  look at #12 ", agent: "reviewer", replyTo: "m4" }))
      .resolves.toMatchObject({ status: "sent", workspace: "cloud-api" });
    expect(sendWorkspaceMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "look at #12", target: { name: "reviewer" }, replyTo: "m4" }),
      WS,
    );
    await expect(jobs.message({ workspace: "cloud-api", text: "hi" })).rejects.toThrow(/Name the agent/);
    await expect(jobs.message({ workspace: "elsewhere", text: "hi", agent: "a" })).rejects.toThrow(/No cloud workspace/);
  });

  it("ignores jobs that claim to come from a cloud service", () => {
    const { jobs, deps } = setup({ cloudWorkspaces: cloud });
    jobs.receive({ ...incoming("alice"), workspace: WS });
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("persists records in local storage", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage;
    const store = localRemoteJobs("k", () => storage);
    const row: RemoteJob = { jobId: "job-1234", ptyId: 1, instance: "i", title: "t", workspace: WS, target: "c", team: "t1", device: "host-1", expires: Date.now() + 1000 };
    store.put(row);
    expect(localRemoteJobs("k", () => storage).load()).toEqual([row]);
    store.remove("job-1234");
    expect(store.load()).toEqual([]);
  });
});

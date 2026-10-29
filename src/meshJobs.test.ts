import { describe, expect, it, vi } from "vitest";
import { createMeshJobs, localIncomingJobs, localRemoteJobs, localRemoteMessages, needsApproval, pickWorkspace, type JobSession, type MeshJobDeps, type RemoteJob, type RemoteMessage } from "./meshJobs";
import type { Device } from "./teamMessaging/client";
import type { JobRequest, JobStatus, RosterAgent, RosterRequest } from "./teamMessaging/jobSchema";
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
    start: vi.fn(async (req: { project?: string; dir?: string }) => ({ started: true, project: req.project ?? req.dir ?? "", note: "ok", runId: `run-${++n}` })),
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
const CHECKOUTS = [
  { project: "api", dir: "/src/api", rel: "", origin: "https://github.com/acme/api.git", main: true },
  { project: "web", dir: "/src/web", rel: "", origin: "git@github.com:acme/web.git", main: true },
  { project: "scratch", dir: "/src/scratch", rel: "", origin: "", main: true },
];

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

  it("carries the job's repository to another machine, and says so", async () => {
    const { jobs, s } = setup();
    const scope = { repos: [{ host: "github.com", slug: "acme/api" }], path: "server" };
    const result = await jobs.submit({ brief: "Fix it", member: "bob", scope, ...origin });
    expect(s.submitJob).toHaveBeenCalledWith(expect.objectContaining({ scope }), "bob", undefined);
    expect(result.note).toContain("github.com/acme/api");
    const bare = await jobs.submit({ brief: "Fix it", member: "me", ...origin });
    expect(s.submitJob.mock.calls[1][0]).not.toHaveProperty("scope");
    expect(bare.note).toContain("No repository is attached");
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
  it("keeps a waiting job across a reload, notification and all", async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage;
    const first = setup({ inboxStore: localIncomingJobs("k", () => storage) });
    first.jobs.receive(incoming("bob", job({ workspace: "api" })));
    await flush();
    expect(first.jobs.inbox()).toHaveLength(1);

    // The window reloads: a new coordinator over the same storage.
    const second = setup({ inboxStore: localIncomingJobs("k", () => storage) });
    expect(second.jobs.restore()).toEqual(new Set(["job-incoming-1"]));
    expect(second.jobs.inbox().map((i) => i.job.title)).toEqual(["Fix flaky test"]);
    expect(second.deps.post).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "mesh-job:job-incoming-1" }));
    // The same job arriving again is not a second card.
    second.jobs.receive(incoming("bob", job({ workspace: "api" })));
    await flush();
    expect(second.jobs.inbox()).toHaveLength(1);

    await second.jobs.decline("job-incoming-1");
    expect(localIncomingJobs("k", () => storage).load()).toEqual([]);
  });

  it("holds a teammate's job for approval — nothing runs until the user says so", async () => {
    const { jobs, deps, s } = setup();
    jobs.receive(incoming("bob", job({ workspace: "api" })));
    await flush();
    expect(deps.start).not.toHaveBeenCalled();
    expect(jobs.inbox()).toHaveLength(1);
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ kind: "question", title: "Bob wants your agent to: Fix flaky test" }));

    await jobs.approve("job-incoming-1", { project: "web" });
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
    await flush();
    expect(jobs.inbox()).toHaveLength(1);
    await jobs.decline("job-incoming-1");
    expect(s.sendJobStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "declined" }), "bob-1");
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("starts a job from this account's other machine on its own in the checkout of its repository", async () => {
    const { jobs, deps, s } = setup({ checkouts: async () => CHECKOUTS });
    jobs.receive(incoming("alice", job({ workspace: "web", scope: { repos: [{ host: "github.com", slug: "Acme/api" }], path: "server" } }), "me-desktop"));
    await flush();
    expect(jobs.inbox()).toHaveLength(0);
    // The repository decides, not the workspace name the sender passed.
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ dir: "/src/api" }));
    expect(vi.mocked(deps.start).mock.calls[0][0]).not.toHaveProperty("project");
    expect(vi.mocked(deps.start).mock.calls[0][0].prompt).toContain("Repository: github.com/Acme/api");
    expect(vi.mocked(deps.start).mock.calls[0][0].prompt).toContain("`server` folder");
    expect(s.sendJobStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "started" }), "me-desktop");
  });

  it("holds an own-account job with no repository for the user, even when it names a project here", async () => {
    const { jobs, deps } = setup({ checkouts: async () => CHECKOUTS });
    jobs.receive(incoming("alice", job({ workspace: "api" }), "me-desktop"));
    await flush();
    expect(deps.start).not.toHaveBeenCalled();
    expect(jobs.inbox()[0]).toMatchObject({ sameAccount: true, placement: { kind: "none" } });
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ kind: "question", title: expect.stringContaining("Choose a project") }));
  });

  it("never auto-runs an own-account job whose repository isn't checked out here", async () => {
    const { jobs, deps } = setup({ checkouts: async () => CHECKOUTS });
    jobs.receive(incoming("alice", job({ scope: { repos: [{ host: "github.com", slug: "acme/dashboard" }] } }), "me-desktop"));
    await flush();
    expect(deps.start).not.toHaveBeenCalled();
    expect(jobs.inbox()[0].placement).toEqual({ kind: "missing", repo: { host: "github.com", slug: "acme/dashboard" } });
  });

  it("still asks a teammate's approval when the repository matches, and runs where it matched", async () => {
    const { jobs, deps } = setup({ checkouts: async () => CHECKOUTS });
    jobs.receive(incoming("bob", job({ scope: { repos: [{ host: "github.com", slug: "acme/api" }] } })));
    await flush();
    expect(deps.start).not.toHaveBeenCalled();
    const [item] = jobs.inbox();
    expect(item.placement).toMatchObject({ kind: "matched", choices: [{ project: "api", dir: "/src/api" }] });
    await jobs.approve(item.job.id, { dir: "/src/api", label: "api" });
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ dir: "/src/api" }));
  });

  it("re-matches a waiting job once its repository is opened here", async () => {
    let checkouts = CHECKOUTS;
    const { jobs } = setup({ checkouts: async () => checkouts });
    jobs.receive(incoming("bob", job({ scope: { repos: [{ host: "github.com", slug: "acme/dashboard" }] } })));
    await flush();
    expect(jobs.inbox()[0].placement.kind).toBe("missing");
    checkouts = [...CHECKOUTS, { project: "dash", dir: "/src/dash", rel: "", origin: "git@github.com:acme/dashboard.git", main: true }];
    await jobs.relocate();
    expect(jobs.inbox()[0].placement).toMatchObject({ kind: "matched", choices: [{ project: "dash" }] });
  });

  it("declines on arrival rather than bury a full inbox", async () => {
    const { jobs, s } = setup();
    for (let i = 0; i < 21; i++) jobs.receive(incoming("bob", job({ id: `job-incoming-${100 + i}` })));
    await flush();
    expect(jobs.inbox()).toHaveLength(20);
    expect(s.sendJobStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-incoming-120", state: "declined" }), "bob-1");
  });

  it("reports a failed launch back to the sender", async () => {
    const { jobs, s } = setup({ start: vi.fn(async () => ({ started: false, project: "api", note: "No agent CLI installed" })) });
    jobs.receive(incoming("bob"));
    await flush();
    await jobs.approve("job-incoming-1", { project: "api" });
    expect(s.sendJobStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", detail: "No agent CLI installed" }), "bob-1");
  });
});

describe("targets", () => {
  it("lists workspaces, this account's other machines and teammates with who is online", async () => {
    const { jobs } = setup();
    const t = await jobs.targets();
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
    expect((await jobs.targets()).cloudWorkspaces).toMatchObject([{ id: WS, name: "cloud-api", reachable: true, online: true, agents: null }]);

    const restarted = setup({ cloudWorkspaces: cloud, remoteJobs: store }, s);
    restarted.jobs.receive(status("started", result.jobId, { workspace: "ws-other" }));
    restarted.jobs.receive(status("started", result.jobId, { sender: { user: "alice", device: "bob-1" } }));
    expect(restarted.deps.report).not.toHaveBeenCalled();
    restarted.jobs.receive(status("refused", result.jobId));
    expect(restarted.deps.report).toHaveBeenCalledWith(7, "inst", result.jobId, expect.stringContaining("refused"));
    expect(store.rows()).toHaveLength(0);
  });

  it("tells the cloud agent which repository the job is about, and warns when it works in another", async () => {
    const submitWorkspaceJob = vi.fn(async () => host);
    const { jobs } = setup({ cloudWorkspaces: cloud }, session({ hosts: () => [host], submitWorkspaceJob }));
    const scope = { repos: [{ host: "github.com", slug: "acme/api" }, { host: "github.com", slug: "acme/dashboard" }] };
    const result = await jobs.submit({ brief: "Fix #101", workspace: "cloud-api", agent: "reviewer", scope, ...origin });
    const sent = submitWorkspaceJob.mock.calls[0] as unknown as [JobRequest];
    expect(sent[0].scope).toEqual(scope);
    expect(sent[0].brief).toBe("Fix #101\n\nRepository: github.com/acme/api. It also involves: github.com/acme/dashboard — those are other checkouts, not this one.");
    expect(result.note).not.toContain("Note:");
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

  it("answers a retried send from its first attempt instead of delivering it twice", async () => {
    let release!: () => void;
    const sendWorkspaceMessage = vi.fn(() => new Promise<typeof host>((resolve) => { release = () => resolve(host); }));
    const { jobs } = setup({ cloudWorkspaces: cloud }, session({ hosts: () => [host], sendWorkspaceMessage }));
    // The bridge gave up on the first attempt while its relay POST was still out.
    const first = jobs.message({ workspace: "cloud-api", text: "task", agent: "reviewer", requestId: "req-1" });
    const retry = jobs.message({ workspace: "cloud-api", text: "task", agent: "reviewer", requestId: "req-1" });
    release();
    await expect(retry).resolves.toMatchObject({ messageId: "req-1", status: "sent" });
    await expect(first).resolves.toMatchObject({ messageId: "req-1" });
    await jobs.message({ workspace: "cloud-api", text: "task", agent: "reviewer", requestId: "req-1" });
    expect(sendWorkspaceMessage).toHaveBeenCalledTimes(1);
    // A send that failed may be tried again under the same id.
    const failing = vi.fn(async () => { throw new Error("relay down"); });
    const other = setup({ cloudWorkspaces: cloud }, session({ hosts: () => [host], sendWorkspaceMessage: failing }));
    await expect(other.jobs.message({ workspace: "cloud-api", text: "t", agent: "a", requestId: "req-2" })).rejects.toThrow("relay down");
    await expect(other.jobs.message({ workspace: "cloud-api", text: "t", agent: "a", requestId: "req-2" })).rejects.toThrow("relay down");
    expect(failing).toHaveBeenCalledTimes(2);
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

  describe("its agents and their replies", () => {
    const reviewer: RosterAgent = { ptyId: 7, name: "reviewer", agent: "claude", task: "Review #12", status: null, closing: false };
    const rosterEvent = (requestId: string, agents: RosterAgent[], over: Partial<TeamJobEvent> = {}): TeamJobEvent =>
      ({ kind: "roster", team: "t1", user: "alice", workspace: WS, sender: { user: "alice", device: "host-1" }, roster: { requestId, agents, created: NOW }, ...over }) as TeamJobEvent;
    const reply = (replyTo: string, over: Partial<TeamJobEvent> = {}): TeamJobEvent =>
      ({ kind: "mesh", team: "t1", user: "alice", workspace: WS, sender: { user: "alice", device: "host-1" }, message: { id: "reply-0001", text: "Two parser fixes.\nSee src/parse.rs.", target: { ptyId: 0 }, replyTo, created: NOW, from: { name: "reviewer" } }, ...over }) as TeamJobEvent;
    const memoryMessages = () => {
      let rows: RemoteMessage[] = [];
      return { load: () => rows, put: (r: RemoteMessage) => { rows = [...rows.filter((x) => x.messageId !== r.messageId), r]; }, remove: (id: string) => { rows = rows.filter((x) => x.messageId !== id); }, rows: () => rows };
    };

    it("lists a cloud workspace's live agents from its service and reuses a fresh answer", async () => {
      let jobs!: ReturnType<typeof createMeshJobs>;
      const requestWorkspaceRoster = vi.fn(async (req: RosterRequest) => {
        // A forged answer from another device first: ignored.
        setTimeout(() => jobs.receive(rosterEvent(req.id, [{ ...reviewer, name: "impostor" }], { sender: { user: "bob", device: "bob-1" } })), 0);
        setTimeout(() => jobs.receive(rosterEvent(req.id, [reviewer])), 5);
        return host;
      });
      const refreshCloudWorkspaces = vi.fn(async () => {});
      ({ jobs } = setup({ cloudWorkspaces: () => [{ id: WS, name: "cloud-api", state: "ready" }], refreshCloudWorkspaces }, session({ hosts: () => [host], requestWorkspaceRoster })));
      const [cloudApi] = (await jobs.targets()).cloudWorkspaces;
      expect(cloudApi).toEqual({ id: WS, name: "cloud-api", state: "ready", reachable: true, online: true, lastSeen: seen(1000), agents: [reviewer] });
      await jobs.targets();
      expect(requestWorkspaceRoster).toHaveBeenCalledTimes(1);
      expect(refreshCloudWorkspaces).toHaveBeenCalledTimes(2);
    });

    it("says why there is no list: a stale host, or a service that refused", async () => {
      const stale = { ...host, last_seen_at: seen(120_000) };
      const requestWorkspaceRoster = vi.fn(async () => stale);
      const quiet = setup({ cloudWorkspaces: cloud }, session({ hosts: () => [stale], requestWorkspaceRoster }));
      expect((await quiet.jobs.targets()).cloudWorkspaces[0]).toMatchObject({ online: false, agents: null, note: expect.stringContaining("hasn't checked in") });
      expect(requestWorkspaceRoster).not.toHaveBeenCalled();

      let jobs!: ReturnType<typeof createMeshJobs>;
      const refusing = vi.fn(async (req: RosterRequest) => {
        setTimeout(() => jobs.receive({ kind: "mesh-status", team: "t1", user: "alice", workspace: WS, sender: { user: "alice", device: "host-1" }, status: { messageId: req.id, state: "refused", detail: "teammate delivery is off", created: NOW } }), 0);
        return host;
      });
      ({ jobs } = setup({ cloudWorkspaces: cloud }, session({ hosts: () => [host], requestWorkspaceRoster: refusing })));
      expect((await jobs.targets()).cloudWorkspaces[0]).toMatchObject({ online: true, agents: null, note: "teammate delivery is off" });
    });

    it("types an agent's reply into the terminal that messaged it, even after a restart", async () => {
      const store = memoryMessages();
      const sendWorkspaceMessage = vi.fn(async () => host);
      const s = session({ hosts: () => [host], sendWorkspaceMessage });
      const first = setup({ cloudWorkspaces: cloud, remoteMessages: store }, s);
      const sent = await first.jobs.message({ workspace: "cloud-api", text: "what changed?", agent: "reviewer", origin, fromName: "Jarvis" });
      expect(sent.note).toContain(`ref {kind: "relay", id: "${sent.messageId}"}`);
      expect(sendWorkspaceMessage).toHaveBeenCalledWith(expect.objectContaining({ from: { name: "Jarvis" } }), WS);
      expect(store.rows()).toHaveLength(1);

      const reportReply = vi.fn(async () => "m9");
      const { jobs } = setup({ cloudWorkspaces: cloud, remoteMessages: store, reportReply }, s);
      jobs.receive(reply(sent.messageId, { sender: { user: "alice", device: "bob-1" } }));
      jobs.receive(reply(sent.messageId, { workspace: "ws-other" }));
      jobs.receive(reply("not-a-message-we-sent"));
      expect(reportReply).not.toHaveBeenCalled();
      jobs.receive(reply(sent.messageId));
      expect(reportReply).toHaveBeenCalledWith(7, "inst", sent.messageId, `reviewer in cloud-api replied to your message ${sent.messageId}:\n\nTwo parser fixes.\nSee src/parse.rs.`);

      jobs.receive({ kind: "mesh-status", team: "t1", user: "alice", workspace: WS, sender: { user: "alice", device: "host-1" }, status: { messageId: sent.messageId, state: "failed", detail: "No running agent called reviewer.", created: NOW } });
      expect(reportReply).toHaveBeenLastCalledWith(7, "inst", sent.messageId, expect.stringContaining("could not be delivered: No running agent called reviewer."));
      expect(store.rows()).toHaveLength(0);
    });

    it("persists sent messages in local storage", () => {
      const data = new Map<string, string>();
      const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage;
      const row: RemoteMessage = { messageId: "msg-1234", ptyId: 1, instance: "i", workspace: WS, workspaceName: "cloud-api", agent: "reviewer", team: "t1", device: "host-1", expires: Date.now() + 1000 };
      localRemoteMessages("k", () => storage).put(row);
      expect(localRemoteMessages("k", () => storage).load()).toEqual([row]);
    });
  });
});

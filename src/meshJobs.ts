// Mesh jobs: one agent handing a complete brief to an agent somewhere else —
// another workspace in this window, this account's other machine, or a
// teammate's machine — and hearing back as it moves.
//
// The mesh inside one window already lets agents message each other; what it
// could not do is start work where nobody is running, or cross a machine. So a
// job is two things this module joins up:
//
//  - Delivery. In this window it is a task launched in the target workspace
//    (App's startSession, the same launcher canopy_start_session uses). Across
//    machines it is a `job` payload on the account-bound, end-to-end encrypted
//    team channel (teamMessaging), which already proves who sent it.
//  - Authority. The rule is the user's: a job from the same account runs on
//    its own (in the checkout of the repository it carries, jobScope.ts — one
//    with no repository, or one not checked out here, waits for the user to
//    say where); a job from anyone else waits for the receiving user to
//    approve it. "Same account" is the envelope's server-authenticated sender, never a
//    field the sender wrote — the brief is about to be handed to an agent that
//    can edit files, so this check is the whole security story.
//
// Every step (accepted, declined, started, done, blocked, failed) is reported
// back into the submitting agent's terminal as a mesh message tagged
// ref {kind: "job", id}, so the submitter can wait for it or look it up with
// canopy_mesh.
//
// A cloud workspace has its own Canopy service with a host device on the
// relay. A job for one goes there as a v2 envelope addressed to that workspace
// (seven-day lifetime), and the service — not this window — decides whether it
// runs: the owner's own account, or a granted teammate when the owner has
// turned teammate delivery on. Those outgoing jobs are recorded durably, so a
// status the service sends while this window is closed still reaches the
// submitting terminal after a restart, if it is still open.
//
// The same service answers who is running there (a roster request inside a
// `mesh` envelope), so canopy_mesh_targets lists each cloud workspace's live
// agents, and whether its service has checked in lately. A message sent to one
// of those agents is recorded durably under its id; the agent's answer comes
// back as a `mesh` envelope naming it in `replyTo`, from the host device the
// message went to, and is typed into the terminal that sent it.
//
// Person-device jobs keep the in-memory state: a restart forgets their pending
// approvals and in-flight runs, and their 5-minute envelope window means a peer
// offline that long misses a status update. Both are stated in what submit returns.

import type { AttentionInput } from "./attention";
import { originMatches, place, repoFullName, scopeBrief, type Checkout, type Placement } from "./jobScope";
import type { Device } from "./teamMessaging/client";
import { deviceOnline } from "./teamMessaging/client";
import { repoRefFromRemote } from "./gitLinks";
import {
  clipDetail,
  MAX_JOB_BRIEF,
  type JobRequest,
  type JobScope,
  type JobState,
  type JobStatus,
  type MeshMessage,
  type RosterAgent,
  type RosterRequest,
} from "./teamMessaging/jobSchema";
import type { TeamJobEvent, TeamJobSender } from "./teamMessaging/session";

/** The slice of a TeamSession this module uses. */
export interface JobSession {
  readonly team: string;
  readonly user: string;
  members(): Record<string, string>;
  devices(): Device[];
  deviceId(): string | undefined;
  submitJob(job: JobRequest, recipient: string, device?: string): Promise<Device>;
  /** Host devices of cloud workspaces this account can reach. */
  hosts?(): Device[];
  submitWorkspaceJob?(job: JobRequest, workspace: string): Promise<Device>;
  sendWorkspaceMessage?(message: MeshMessage, workspace: string): Promise<Device>;
  requestWorkspaceRoster?(request: RosterRequest, workspace: string): Promise<Device>;
  sendJobStatus(status: JobStatus, device: string): Promise<void>;
}

export interface StartedJob {
  started: boolean;
  project: string;
  note: string;
  runId?: string;
}

export interface MeshJobDeps {
  /** The user's workspaces in this window, by name. */
  workspaces: () => { name: string }[];
  /** Launch an agent on a brief (App's startSession): in a project by name,
   *  or in a component directory. */
  start: (req: { project?: string; dir?: string; prompt: string; label: string }) => Promise<StartedJob>;
  /** Every component of the user's projects with its checkout's origin, for
   *  matching an incoming job's repository. Absent: no job ever matches, so
   *  every one waits for the user to pick. */
  checkouts?: () => Promise<Checkout[]>;
  sessions: () => JobSession[];
  teamName: (team: string) => string | undefined;
  /** Type a job step into the submitting terminal (ipc.meshJobUpdate). */
  report: (ptyId: number, instance: string, jobId: string, text: string) => Promise<unknown>;
  post: (input: AttentionInput) => string;
  resolve: (attentionId: string, how: "answered" | "withdrawn" | "dismissed") => void;
  now: () => number;
  newId: () => string;
  /** Cloud workspaces of this account, by control-plane id and name, with the
   *  control plane's lifecycle state when known. */
  cloudWorkspaces?: () => { id: string; name: string; state?: string }[];
  /** Brings `cloudWorkspaces` up to date when it is missing or stale. */
  refreshCloudWorkspaces?: () => Promise<unknown>;
  /** Durable record of jobs sent to cloud workspaces. */
  remoteJobs?: RemoteJobStore;
  /** Durable record of agent messages sent to cloud workspaces, for their replies. */
  remoteMessages?: RemoteMessageStore;
  /** Durable copy of the approval inbox, so a waiting job outlives a reload. */
  inboxStore?: IncomingJobStore;
  /** Type a cloud agent's reply into the terminal that messaged it, tagged
   *  ref {kind: "relay", id: messageId} (ipc.meshRelayReply). */
  reportReply?: (ptyId: number, instance: string, messageId: string, text: string) => Promise<unknown>;
}

/** An agent message sent to a cloud workspace, kept while a reply may come. */
export interface RemoteMessage {
  messageId: string;
  ptyId: number;
  instance: string;
  workspace: string;
  workspaceName: string;
  agent: string;
  team: string;
  device: string;
  expires: number;
}
export interface RemoteMessageStore {
  load(): RemoteMessage[];
  put(message: RemoteMessage): void;
  remove(messageId: string): void;
}

/** A job sent to a cloud workspace's service, kept until its final status. */
export interface RemoteJob {
  jobId: string;
  ptyId: number;
  instance: string;
  title: string;
  workspace: string;
  target: string;
  team: string;
  device: string;
  expires: number;
}
export interface RemoteJobStore {
  load(): RemoteJob[];
  put(job: RemoteJob): void;
  remove(jobId: string): void;
}
const REMOTE_JOB_LIMIT = 200;
const WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a mesh send's id is remembered, so a retry of a timed-out send is answered once. */
const SEND_RETRY_MS = 10 * 60 * 1000;
/** localStorage is enough: a few hundred small records, read once at startup. */
function localRecords<T extends { ptyId: number; expires: number }>(key: string, id: (row: T) => unknown, storage: () => Storage) {
  const read = (): T[] => {
    try {
      const rows = JSON.parse(storage().getItem(key) ?? "[]");
      return Array.isArray(rows) ? rows.filter((r) => r && typeof id(r) === "string" && Number.isSafeInteger(r.ptyId)) : [];
    } catch {
      return [];
    }
  };
  const write = (rows: T[]) => {
    try {
      storage().setItem(key, JSON.stringify(rows.slice(-REMOTE_JOB_LIMIT)));
    } catch {
      /* quota: the in-memory record still reports */
    }
  };
  return {
    load: () => read().filter((r) => r.expires > Date.now()),
    put: (row: T) => write([...read().filter((r) => id(r) !== id(row) && r.expires > Date.now()), row]),
    remove: (rowId: string) => write(read().filter((r) => id(r) !== rowId)),
  };
}
export function localRemoteJobs(key = "canopy:mesh-remote-jobs:v1", storage: () => Storage = () => localStorage): RemoteJobStore {
  return localRecords<RemoteJob>(key, (r) => r.jobId, storage);
}
export function localRemoteMessages(key = "canopy:mesh-remote-messages:v1", storage: () => Storage = () => localStorage): RemoteMessageStore {
  return localRecords<RemoteMessage>(key, (r) => r.messageId, storage);
}

/** Jobs waiting on the user, kept across reloads and restarts: the
 *  notification that announces one is durable, so the job must be too. */
export interface IncomingJobStore {
  load(): IncomingJob[];
  save(jobs: IncomingJob[]): void;
}
export function localIncomingJobs(key = "canopy:mesh-inbox:v1", storage: () => Storage = () => localStorage): IncomingJobStore {
  return {
    load: () => {
      try {
        const rows = JSON.parse(storage().getItem(key) ?? "[]");
        return Array.isArray(rows)
          ? rows.filter((r) => r && typeof r.job?.id === "string" && typeof r.received === "number" && r.received + WORKSPACE_TTL_MS > Date.now())
          : [];
      } catch {
        return [];
      }
    },
    save: (jobs) => {
      try {
        storage().setItem(key, JSON.stringify(jobs));
      } catch {
        /* quota: the in-memory inbox still shows it */
      }
    },
  };
}

/** A job someone else sent this account, waiting on the user. */
export interface IncomingJob {
  job: JobRequest;
  team: string;
  teamName?: string;
  /** This account (the session that received it). */
  account: string;
  sender: TeamJobSender;
  /** Whether it came from this same account's other machine. Such a job only
   *  lands here when it carries no repository, or one not checked out here. */
  sameAccount: boolean;
  received: number;
  /** Where it runs, by the repository it carries (jobScope.ts). */
  placement: Placement;
  attentionId?: string;
}

/** Where a job is run: a component directory a match found, or a project the
 *  user picked. `label` is what the user and the submitter are told. */
export type JobWhere = { dir: string; label: string } | { project: string; label?: string };
const whereLabel = (where: JobWhere) => where.label ?? ("project" in where ? where.project : where.dir);

/** Where a submitted job's updates go. */
interface Origin {
  ptyId: number;
  instance: string;
}
type Outgoing = Origin & { title: string; team?: string; device?: string; target: string; workspace?: string };
/** A run this window started for a job, keyed by its task run id. */
type RunOrigin =
  | { kind: "local"; jobId: string; origin: Origin }
  | { kind: "remote"; jobId: string; team: string; account: string; device: string };

/** A pending approval's ceiling. Past it, a new job is declined on arrival
 *  rather than burying the ones already waiting. */
const MAX_INBOX = 20;
/** Who "me" is when an agent targets this account's other machine. */
const SELF = new Set(["me", "self", "myself", "my machine", "my other machine"]);

/** How long canopy_mesh_targets waits on a service's roster, and reuses one. */
const ROSTER_WAIT_MS = 8_000;
const ROSTER_FRESH_MS = 15_000;
const CLOUD_LIST_WAIT_MS = 5_000;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
function bounded<T>(work: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(why)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function jobTitle(title: string | null | undefined, brief: string): string {
  return clip(oneLine(title ?? "") || oneLine(brief) || "Mesh job", 80);
}

/** Who may run a job without asking: only this same account. */
export function needsApproval(sender: TeamJobSender, account: string): boolean {
  return sender.user !== account;
}

/** The workspace in this window an agent named for a job it starts here: the
 *  one it names, else the only one there is. Null means it named none of them.
 *  Only for this window's own submits — a job from another machine is placed
 *  by its repository (jobScope.ts), never by a name. */
export function pickWorkspace(
  requested: string | null,
  workspaces: { name: string }[],
): string | null {
  const wanted = requested?.trim().toLowerCase();
  if (wanted) return workspaces.find((w) => w.name.toLowerCase() === wanted)?.name ?? null;
  return workspaces.length === 1 ? workspaces[0].name : null;
}

/** The brief an incoming job's agent is started with: who asked, then the job
 *  itself. The provenance line is ours, so the agent knows where the work came
 *  from and that canopy_job_done is how its answer travels back. */
export function incomingBrief(job: JobRequest, from: string, placement: Placement = { kind: "none" }): string {
  const scope = scopeBrief(job.scope, placement);
  return (
    `Mesh job ${job.id} from ${from}: ${job.title}. ${job.brief}\n\n` +
    (scope ? `${scope}\n\n` : "") +
    "When you finish, or if you are blocked, call canopy_job_done — its summary is sent back to whoever submitted this job."
  );
}

const STEP: Record<JobState, string> = {
  accepted: "approved",
  declined: "declined",
  refused: "refused",
  interrupted: "interrupted",
  started: "started",
  done: "done",
  blocked: "blocked",
  failed: "failed",
};
const FINAL = new Set<JobState>(["declined", "refused", "done", "failed", "interrupted"]);

export function stepText(title: string, where: string, state: JobState, detail: string): string {
  const head = `Job "${title}" (${where}) ${STEP[state]}`;
  return detail ? `${head}: ${detail}` : `${head}.`;
}

export function createMeshJobs(deps: MeshJobDeps) {
  const outgoing = new Map<string, Outgoing>();
  for (const r of deps.remoteJobs?.load() ?? []) {
    outgoing.set(r.jobId, { ptyId: r.ptyId, instance: r.instance, title: r.title, team: r.team, device: r.device, target: r.target, workspace: r.workspace });
  }
  const sentMessages = new Map<string, RemoteMessage>();
  for (const m of deps.remoteMessages?.load() ?? []) sentMessages.set(m.messageId, m);
  type RosterWait = { workspace: string; team: string; device?: string; resolve: (agents: RosterAgent[]) => void; reject: (err: Error) => void };
  const rosterWaits = new Map<string, RosterWait>();
  const rosters = new Map<string, { at: number; agents: RosterAgent[] }>();
  const runs = new Map<string, RunOrigin>();
  const seen = new Set<string>();
  let inbox: IncomingJob[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    deps.inboxStore?.save(inbox);
    listeners.forEach((fn) => fn());
  };

  const sessionFor = (team: string, account: string) =>
    deps.sessions().find((s) => s.team === team && s.user === account);

  const sendStatus = async (
    team: string,
    account: string,
    device: string,
    jobId: string,
    state: JobState,
    detail = "",
  ) => {
    const session = sessionFor(team, account);
    if (!session) return;
    await session
      .sendJobStatus({ jobId, state, detail: clipDetail(detail), created: deps.now() }, device)
      .catch(() => {
        /* best effort: the submitter's device may be offline */
      });
  };

  const report = (origin: Origin, jobId: string, text: string) =>
    deps.report(origin.ptyId, origin.instance, jobId, text).catch(() => {
      /* the submitting terminal has gone; nobody is left to tell */
    });

  // ---- targets -------------------------------------------------------------

  /** The newest host device serving a cloud workspace, and the team it is on. */
  function hostOf(workspace: string) {
    let best: { host: Device; team: string } | undefined;
    for (const s of deps.sessions()) {
      for (const h of s.hosts?.() ?? []) {
        if (!h.workspaceIds?.includes(workspace)) continue;
        if (!best || Date.parse(h.last_seen_at ?? "") > Date.parse(best.host.last_seen_at ?? "")) best = { host: h, team: s.team };
      }
    }
    return best;
  }

  /** Who is running in a cloud workspace, asked of its service over the relay. */
  async function roster(cloud: { id: string; name: string }): Promise<RosterAgent[]> {
    const cached = rosters.get(cloud.id);
    if (cached && deps.now() - cached.at < ROSTER_FRESH_MS) return cached.agents;
    const errors: string[] = [];
    for (const s of deps.sessions()) {
      if (!s.requestWorkspaceRoster) continue;
      const id = deps.newId();
      let wait!: RosterWait;
      const answered = new Promise<RosterAgent[]>((resolve, reject) => {
        wait = { workspace: cloud.id, team: s.team, resolve, reject };
      });
      rosterWaits.set(id, wait);
      try {
        const host = await s.requestWorkspaceRoster({ id, created: deps.now() }, cloud.id);
        wait.device = host.id;
        const agents = await bounded(
          answered,
          ROSTER_WAIT_MS,
          `${cloud.name}'s Canopy service didn't answer within ${ROSTER_WAIT_MS / 1000}s — it may be busy, or older than agent listing.`,
        );
        rosters.set(cloud.id, { at: deps.now(), agents });
        return agents;
      } catch (err) {
        errors.push(errorText(err));
      } finally {
        rosterWaits.delete(id);
      }
    }
    throw new Error(errors[0] ?? `Sign in to a Canopy team to reach cloud workspace ${cloud.name}.`);
  }

  async function cloudTarget(w: { id: string; name: string; state?: string }) {
    const found = hostOf(w.id);
    const online = found ? deviceOnline(found.host, deps.now()) : false;
    const base = { id: w.id, name: w.name, state: w.state ?? null, reachable: !!found, online, lastSeen: found?.host.last_seen_at ?? null };
    if (!found) return { ...base, agents: null, note: "No Canopy service is registered for this workspace yet, or you no longer have access to it." };
    if (!online) return { ...base, agents: null, note: "Its Canopy service hasn't checked in for over a minute: the workspace is stopped or its host is down. Jobs and messages wait for it up to 7 days." };
    try {
      return { ...base, agents: await roster(w) };
    } catch (err) {
      return { ...base, agents: null, note: errorText(err) };
    }
  }

  async function targets() {
    if (deps.refreshCloudWorkspaces) {
      await bounded(deps.refreshCloudWorkspaces(), CLOUD_LIST_WAIT_MS, "workspace list").catch(() => {
        /* the last known list still answers */
      });
    }
    const sessions = deps.sessions();
    const machines: { device: string; team: string; online: boolean; lastSeen: string | null }[] = [];
    const people = new Map<
      string,
      { id: string; name: string; teams: string[]; online: boolean; devices: { id: string; online: boolean }[] }
    >();
    const ownSeen = new Set<string>();
    for (const s of sessions) {
      const self = s.deviceId();
      const members = s.members();
      const teamLabel = deps.teamName(s.team) ?? s.team;
      for (const d of s.devices()) {
        if (d.id === self) continue;
        const online = deviceOnline(d, deps.now());
        if (d.user_id === s.user) {
          if (ownSeen.has(d.id)) continue;
          ownSeen.add(d.id);
          machines.push({ device: d.id, team: teamLabel, online, lastSeen: d.last_seen_at ?? null });
          continue;
        }
        const person =
          people.get(d.user_id) ??
          { id: d.user_id, name: members[d.user_id] ?? d.user_id, teams: [], online: false, devices: [] };
        if (!person.teams.includes(teamLabel)) person.teams.push(teamLabel);
        if (!person.devices.some((x) => x.id === d.id)) person.devices.push({ id: d.id, online });
        person.online ||= online;
        people.set(d.user_id, person);
      }
    }
    return {
      workspaces: deps.workspaces().map((w) => w.name),
      cloudWorkspaces: await Promise.all((deps.cloudWorkspaces?.() ?? []).map(cloudTarget)),
      myMachines: machines,
      teammates: [...people.values()],
      note: sessions.length
        ? "canopy_mesh_submit with workspace (this window, or a cloud workspace by name with `agent`), member \"me\" (your other machine), or a teammate's name or id. Jobs to a teammate wait for their approval; only online members can receive one. A cloud workspace lists its live agents; message one with canopy_mesh_send workspace + agent, and its reply arrives in this terminal."
        : "Not signed in to a Canopy team, so only this window's workspaces are reachable. Sign in under Settings → Account to reach other machines and teammates.",
    };
  }

  // ---- submitting ----------------------------------------------------------

  /** Resolve `member` to an account id. "me" is this account; otherwise an
   *  id, or a name that names exactly one person. */
  function resolveMember(member: string, sessions: JobSession[]): { id: string; name: string; self: boolean } {
    const wanted = member.trim().toLowerCase();
    const account = sessions[0]?.user;
    if (!account) throw new Error("Sign in to a Canopy team to send jobs to other machines or teammates.");
    if (SELF.has(wanted) || wanted === account.toLowerCase()) return { id: account, name: "your other machine", self: true };
    const matches = new Map<string, string>();
    for (const s of sessions) {
      for (const [id, name] of Object.entries(s.members())) {
        if (id === s.user) continue;
        if (id.toLowerCase() === wanted || name.trim().toLowerCase() === wanted) matches.set(id, name);
      }
    }
    if (matches.size === 1) {
      const [[id, name]] = [...matches];
      return { id, name, self: false };
    }
    if (matches.size > 1) {
      throw new Error(
        `"${member}" names ${matches.size} teammates — pass one of their ids: ${[...matches.keys()].join(", ")}`,
      );
    }
    throw new Error(`No teammate called "${member}" — see canopy_mesh_targets.`);
  }

  function cloudWorkspace(wanted: string) {
    const key = wanted.trim().toLowerCase();
    return (deps.cloudWorkspaces?.() ?? []).find((w) => w.id.toLowerCase() === key || w.name.toLowerCase() === key);
  }

  async function submitRemote(req: { id: string; title: string; brief: string; origin: Origin; cloud: { id: string; name: string }; agent?: string | null; scope?: JobScope }) {
    const { id, title, origin, cloud, scope } = req;
    const agent = req.agent?.trim();
    // A cloud workspace hands the job to a named agent already running there,
    // so there is no project to pick: the repository travels in the brief
    // that agent reads (an older service ignores the scope field), and the
    // submitter is warned when that agent is known to be on another one.
    const where = scopeBrief(scope, { kind: "none" });
    const scoped = where ? `${req.brief}\n\n${where}` : req.brief;
    const brief = new TextEncoder().encode(scoped).length <= MAX_JOB_BRIEF ? scoped : req.brief;
    const job: JobRequest = { id, title, brief, workspace: cloud.id, created: deps.now(), ...(agent ? { target: { name: agent } } : {}), ...(scope ? { scope } : {}) };
    const elsewhere = scope && agent ? cloudAgentElsewhere(cloud.id, agent, scope) : null;
    const errors: string[] = [];
    for (const s of deps.sessions()) {
      if (!s.submitWorkspaceJob) continue;
      try {
        const device = await s.submitWorkspaceJob(job, cloud.id);
        const record: RemoteJob = { jobId: id, ...origin, title, workspace: cloud.id, target: cloud.name, team: s.team, device: device.id, expires: deps.now() + WORKSPACE_TTL_MS };
        deps.remoteJobs?.put(record);
        outgoing.set(id, { ...origin, title, team: s.team, device: device.id, target: cloud.name, workspace: cloud.id });
        return {
          jobId: id,
          status: "sent",
          workspace: cloud.name,
          device: device.id,
          note: `Sent to the Canopy service of cloud workspace ${cloud.name}. It waits on the encrypted relay for up to 7 days while that workspace is stopped. The service runs it for the workspace owner's account, or for a granted teammate only when the owner allows teammates' agents; otherwise it is refused and you hear why. Updates arrive here as mesh notices tagged ref {kind: "job", id: "${id}"}.${elsewhere ? ` Note: ${agent} there is working in ${elsewhere}, not ${repoFullName(scope!.repos[0])}.` : ""}`,
        };
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(errors[0] ?? `Sign in to a Canopy team to reach cloud workspace ${cloud.name}.`);
  }

  /** The repository a cloud agent was last seen working in, when that is
   *  known and is not the job's. Only from a roster already fetched. */
  function cloudAgentElsewhere(workspace: string, agent: string, scope: JobScope): string | null {
    const known = rosters.get(workspace)?.agents.find((a) => (a.name ?? "").toLowerCase() === agent.toLowerCase());
    if (!known?.repo) return null;
    const ref = repoRefFromRemote(known.repo);
    if (!ref) return null;
    return originMatches(known.repo, scope.repos[0]) ? null : ref.slug;
  }

  // A send whose answer the bridge stopped waiting for may still be in flight
  // or delivered. A retry with its id gets that first attempt's outcome rather
  // than a second delivery; a send that failed may be tried again.
  const sends = new Map<string, { at: number; result: Promise<unknown> }>();
  function once<T>(requestId: string | null | undefined, run: (id: string) => Promise<T>): Promise<T> {
    if (!requestId) return run(deps.newId());
    for (const [key, entry] of sends) if (deps.now() - entry.at > SEND_RETRY_MS) sends.delete(key);
    const prior = sends.get(requestId);
    if (prior) return prior.result as Promise<T>;
    const result = run(requestId);
    sends.set(requestId, { at: deps.now(), result });
    result.catch(() => sends.delete(requestId));
    return result;
  }

  /** An agent message to an agent in a cloud workspace, through its service. */
  function message(req: Parameters<typeof sendMessage>[0] & { requestId?: string | null }) {
    return once(req.requestId, (id) => sendMessage(req, id));
  }

  async function sendMessage(req: {
    workspace: string;
    text: string;
    agent?: string | null;
    ptyId?: number | null;
    replyTo?: string;
    /** The sending terminal, stamped by the bridge; replies are typed into it. */
    origin?: Origin | null;
    fromName?: string | null;
  }, id: string) {
    const cloud = cloudWorkspace(req.workspace);
    if (!cloud) throw new Error(`No cloud workspace called "${req.workspace}".`);
    const text = (req.text ?? "").trim();
    if (!text) throw new Error("A message needs text.");
    const target = req.ptyId != null ? { ptyId: req.ptyId } : req.agent?.trim() ? { name: req.agent.trim() } : null;
    if (!target) throw new Error("Name the agent to message (its name or ptyId).");
    const fromName = clip(oneLine(req.fromName ?? ""), 60);
    const msg: MeshMessage = {
      id,
      text,
      target,
      created: deps.now(),
      ...(req.replyTo ? { replyTo: req.replyTo } : {}),
      ...(fromName ? { from: { name: fromName } } : {}),
    };
    const errors: string[] = [];
    for (const s of deps.sessions()) {
      if (!s.sendWorkspaceMessage) continue;
      try {
        const host = await s.sendWorkspaceMessage(msg, cloud.id);
        const agent = "ptyId" in target ? `terminal ${target.ptyId}` : target.name;
        if (req.origin) {
          const record: RemoteMessage = { messageId: msg.id, ...req.origin, workspace: cloud.id, workspaceName: cloud.name, agent, team: s.team, device: host.id, expires: deps.now() + WORKSPACE_TTL_MS };
          sentMessages.set(msg.id, record);
          deps.remoteMessages?.put(record);
        }
        return {
          messageId: msg.id,
          status: "sent",
          workspace: cloud.name,
          note: req.origin
            ? `Sent to ${agent} in ${cloud.name} through its Canopy service. Its reply arrives in this terminal as a mesh notice tagged ref {kind: "relay", id: "${msg.id}"} (canopy_mesh history refKind "relay" lists them). A refusal or failed delivery arrives the same way.`
            : `Sent to ${agent} in ${cloud.name} through its Canopy service.`,
        };
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(errors[0] ?? `Sign in to a Canopy team to reach cloud workspace ${cloud.name}.`);
  }

  function submit(req: Parameters<typeof submitJob>[0] & { requestId?: string | null }) {
    return once(req.requestId, (id) => submitJob(req, id));
  }

  async function submitJob(req: {
    brief: string;
    title?: string | null;
    workspace?: string | null;
    member?: string | null;
    device?: string | null;
    ptyId?: number | null;
    instance?: string | null;
    /** The agent in a cloud workspace that takes the job; the service picks when absent. */
    agent?: string | null;
    /** The repositories the job is about (jobScope.buildScope). */
    scope?: JobScope | null;
  }, id: string) {
    const brief = (req.brief ?? "").trim();
    if (!brief) throw new Error("A job needs a brief.");
    if (new TextEncoder().encode(brief).length > MAX_JOB_BRIEF) throw new Error("A job brief is capped at 16 KB.");
    if (req.ptyId == null || !req.instance) throw new Error("Only a Canopy agent terminal can submit a mesh job.");
    const origin: Origin = { ptyId: req.ptyId, instance: req.instance };
    const title = jobTitle(req.title, brief);
    const workspace = (req.workspace ?? "").trim() || null;
    const member = (req.member ?? "").trim();
    const scope = req.scope ?? undefined;

    // This window: the same account by definition, so it simply starts.
    if (!member) {
      if (!workspace) throw new Error("Name the workspace to run the job in (see canopy_mesh_targets).");
      const named = pickWorkspace(workspace, deps.workspaces());
      const cloud = named ? undefined : cloudWorkspace(workspace);
      if (cloud) return submitRemote({ id, title, brief, origin, cloud, agent: req.agent, scope });
      if (!named) {
        throw new Error(
          `No workspace called "${workspace}" — the workspaces are: ${deps.workspaces().map((w) => w.name).join(", ")}`,
        );
      }
      const started = await deps.start({
        project: named,
        prompt: `Mesh job ${id} from another workspace's agent: ${title}. ${brief}\n\nWhen you finish, or if you are blocked, call canopy_job_done — its summary is sent back to the agent that submitted this job.`,
        label: title,
      });
      if (!started.started) return { jobId: id, status: "failed", workspace: named, note: started.note };
      if (started.runId) runs.set(started.runId, { kind: "local", jobId: id, origin });
      return {
        jobId: id,
        status: "started",
        workspace: started.project,
        note: `Started in ${started.project}. Its outcome arrives here as a mesh notice tagged ref {kind: "job", id: "${id}"} when its agent calls canopy_job_done.`,
      };
    }

    const sessions = deps.sessions();
    const who = resolveMember(member, sessions);
    const job: JobRequest = { id, title, brief, workspace, created: deps.now(), ...(scope ? { scope } : {}) };
    const repo = scope ? repoFullName(scope.repos[0]) : null;
    const errors: string[] = [];
    // Any team the two accounts share carries it; the first that reaches an
    // online device wins, so the job is never delivered twice.
    for (const s of sessions) {
      const known = who.self || s.devices().some((d) => d.user_id === who.id);
      if (!known) continue;
      try {
        const device = await s.submitJob(job, who.id, req.device?.trim() || undefined);
        const target = who.self ? "your other machine" : who.name;
        outgoing.set(id, { ...origin, title, team: s.team, device: device.id, target });
        return {
          jobId: id,
          status: who.self ? "sent" : "awaiting-approval",
          to: target,
          device: device.id,
          note: who.self
            ? `Sent to your other machine. ${repo ? `It starts there on its own in the project whose repository is ${repo}; if none is open there, it waits for the user to choose one.` : "No repository is attached (this terminal is not in a checkout with an origin, and no repo was named), so it waits there for the user to choose a project."} Updates arrive here as mesh notices tagged ref {kind: "job", id: "${id}"}.`
            : `Sent to ${who.name}. It waits for them to approve it in Canopy${repo ? `, in their checkout of ${repo}` : ""}; their decision and the job's outcome arrive here as mesh notices tagged ref {kind: "job", id: "${id}"}. An approval that never comes is a "no" — do not resubmit unprompted.`,
        };
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(errors[0] ?? `${who.name} isn't on any team this account belongs to.`);
  }

  // ---- receiving -----------------------------------------------------------

  async function run(incoming: IncomingJob, where: JobWhere) {
    const { job, team, account, sender } = incoming;
    const from = incoming.sameAccount
      ? "this account's other machine"
      : `${sender.name ?? "a teammate"} (your Canopy teammate)`;
    // A component a repository match found starts by its directory; a project
    // the user picked by its name. The placement only shapes the brief when
    // the job really runs in a checkout of its repository.
    const matched = "dir" in where ? incoming.placement : ({ kind: "none" } as const);
    const prompt = incomingBrief(job, from, matched);
    let started: StartedJob;
    try {
      started = await deps.start({ ...("dir" in where ? { dir: where.dir } : { project: where.project }), prompt, label: job.title });
    } catch (err) {
      started = { started: false, project: whereLabel(where), note: String(err instanceof Error ? err.message : err) };
    }
    if (!started.started) {
      await sendStatus(team, account, sender.device, job.id, "failed", started.note);
      return started;
    }
    if (started.runId) runs.set(started.runId, { kind: "remote", jobId: job.id, team, account, device: sender.device });
    await sendStatus(team, account, sender.device, job.id, "started", `Running in ${started.project}.`);
    return started;
  }

  const reply = (sent: RemoteMessage, text: string) =>
    (deps.reportReply ?? deps.report)(sent.ptyId, sent.instance, sent.messageId, text).catch(() => {
      /* the sending terminal has gone; nobody is left to tell */
    });
  /** Only the host device a message went to, on its team and for its workspace, speaks for it. */
  const fromHostOf = (sent: { device?: string; team: string; workspace: string }, event: TeamJobEvent) =>
    (!sent.device || sent.device === event.sender.device) && sent.team === event.team && sent.workspace === event.workspace;

  function receive(event: TeamJobEvent) {
    if (event.kind === "roster") {
      const wait = rosterWaits.get(event.roster.requestId);
      if (wait && fromHostOf(wait, event)) wait.resolve(event.roster.agents);
      return;
    }
    if (event.kind === "mesh") {
      const sent = event.message.replyTo ? sentMessages.get(event.message.replyTo) : undefined;
      // A message no terminal here is waiting on has nowhere to go.
      if (!sent || !fromHostOf(sent, event)) return;
      const name = clip(oneLine(event.message.from?.name ?? ""), 60);
      const who = name && name !== sent.agent ? `${name} (${sent.agent})` : sent.agent;
      void reply(sent, `${who} in ${sent.workspaceName} replied to your message ${sent.messageId}:\n\n${event.message.text}`);
      return;
    }
    if (event.kind === "mesh-status") {
      const wait = rosterWaits.get(event.status.messageId);
      if (wait && fromHostOf(wait, event)) {
        wait.reject(new Error(`${event.status.detail}`));
        return;
      }
      const sent = sentMessages.get(event.status.messageId);
      if (sent && fromHostOf(sent, event)) {
        const how = event.status.state === "failed" ? "could not be delivered" : "was refused";
        void reply(sent, `Your message ${sent.messageId} to ${sent.agent} in ${sent.workspaceName} ${how}: ${event.status.detail}`);
        sentMessages.delete(sent.messageId);
        deps.remoteMessages?.remove(sent.messageId);
        return;
      }
      deps.post({ kind: "fyi", tone: "warn", source: "team", title: `A cloud workspace refused an agent message: ${event.status.detail}`, where: { kind: "panel", panel: "team" } });
      return;
    }
    if (event.kind === "job-status") {
      const sent = outgoing.get(event.status.jobId);
      // Only the device the job went to may speak for it, and a service only for its own workspace.
      if (!sent || sent.device !== event.sender.device || sent.team !== event.team || sent.workspace !== event.workspace) return;
      void report(sent, event.status.jobId, stepText(sent.title, sent.target, event.status.state, event.status.detail));
      if (FINAL.has(event.status.state)) {
        outgoing.delete(event.status.jobId);
        if (sent.workspace) deps.remoteJobs?.remove(event.status.jobId);
      }
      return;
    }
    // A cloud service never sends this window a job; jobs arrive from people's devices.
    if (event.workspace) return;
    const { job } = event;
    if (seen.has(job.id)) return;
    seen.add(job.id);
    const sameAccount = !needsApproval(event.sender, event.user);
    const incoming: IncomingJob = {
      job,
      team: event.team,
      teamName: deps.teamName(event.team),
      account: event.user,
      sender: event.sender,
      sameAccount,
      received: deps.now(),
      placement: { kind: "none" },
    };
    void locate(job.scope).then((placement) => admit({ ...incoming, placement }));
  }

  /** Match a job's repository against this machine's checkouts. A failed
   *  lookup is "not here": the user is asked rather than a guess made. */
  async function locate(scope: JobScope | undefined): Promise<Placement> {
    if (!scope || !deps.checkouts) return scope ? { kind: "missing", repo: scope.repos[0] } : { kind: "none" };
    const checkouts = await deps.checkouts().catch(() => [] as Checkout[]);
    return place(scope, checkouts);
  }

  /** Run a located job, or hold it for the user. Only a job from this same
   *  account whose repository is checked out here runs on its own; one with
   *  no repository, or one this machine does not have, waits for the user to
   *  say where — it never silently runs in some other project. */
  function admit(incoming: IncomingJob) {
    const { job, sameAccount, placement } = incoming;
    const event = { team: incoming.team, user: incoming.account, sender: incoming.sender };
    const best = placement.kind === "matched" ? placement.choices[0] : null;
    if (sameAccount && best) {
      void run(incoming, { dir: best.dir, label: best.project }).then((started) =>
        deps.post({
          kind: "fyi",
          tone: started.started ? "info" : "warn",
          source: "team",
          title: started.started
            ? `Job from your other machine started in ${started.project}: ${job.title}`
            : `A job from your other machine couldn't start: ${started.note}`,
          where: { kind: "panel", panel: "tasks" },
        }),
      );
      return;
    }
    if (inbox.length >= MAX_INBOX) {
      void sendStatus(event.team, event.user, event.sender.device, job.id, "declined", "Their Canopy has too many jobs waiting for approval.");
      return;
    }
    incoming.attentionId = announce(incoming);
    inbox = [...inbox, incoming];
    changed();
  }

  const announce = ({ job, sameAccount, sender }: IncomingJob) =>
    deps.post({
      kind: "question",
      tone: "info",
      source: "team",
      title: sameAccount
        ? `Choose a project for a job from your other machine: ${job.title}`
        : `${sender.name ?? "A teammate"} wants your agent to: ${job.title}`,
      body: "It's waiting in the bottom-right corner. Nothing runs until you approve it.",
      where: { kind: "panel", panel: "team" },
      dedupeKey: `mesh-job:${job.id}`,
    });

  /** Bring back the jobs that were waiting when the window last closed, each
   *  with its notification. Returns the ids now waiting, so the caller can
   *  withdraw notifications for jobs that are gone. Called once, after mount:
   *  posting a notification during render would update other components. */
  function restore(): Set<string> {
    const saved = (deps.inboxStore?.load() ?? []).filter((i) => !seen.has(i.job.id));
    for (const item of saved) {
      seen.add(item.job.id);
      item.attentionId = announce(item);
    }
    if (saved.length) {
      inbox = [...inbox, ...saved];
      changed();
    }
    return new Set(inbox.map((i) => i.job.id));
  }

  function take(jobId: string) {
    const item = inbox.find((i) => i.job.id === jobId);
    if (!item) return undefined;
    inbox = inbox.filter((i) => i !== item);
    changed();
    return item;
  }

  async function approve(jobId: string, where: JobWhere) {
    const item = take(jobId);
    if (!item) throw new Error("That job is no longer waiting.");
    if (item.attentionId) deps.resolve(item.attentionId, "answered");
    if (!item.sameAccount) await sendStatus(item.team, item.account, item.sender.device, jobId, "accepted", `Approved to run in ${whereLabel(where)}.`);
    return run(item, where);
  }

  /** Match the waiting jobs that found no checkout again — after the user
   *  opened or cloned a project. A job that now matches shows where it will
   *  run; it still waits for the user's approval, since they are looking at it. */
  async function relocate() {
    const waiting = inbox.filter((i) => i.placement.kind === "missing");
    if (!waiting.length) return;
    const found = await Promise.all(waiting.map((i) => locate(i.job.scope)));
    let moved = false;
    inbox = inbox.map((i) => {
      const at = waiting.indexOf(i);
      if (at < 0 || found[at].kind !== "matched") return i;
      moved = true;
      return { ...i, placement: found[at] };
    });
    if (moved) changed();
  }

  async function decline(jobId: string, reason = "") {
    const item = take(jobId);
    if (!item) return;
    if (item.attentionId) deps.resolve(item.attentionId, "answered");
    await sendStatus(item.team, item.account, item.sender.device, jobId, "declined", reason || "The user declined this job.");
  }

  /** A task run ended or blocked (canopy_job_done). Reports it to whoever
   *  submitted the job, if the run was one. */
  function runEnded(runId: string | null | undefined, status: "done" | "blocked", summary: string) {
    if (!runId) return;
    const origin = runs.get(runId);
    if (!origin) return;
    if (status === "done") runs.delete(runId);
    if (origin.kind === "local") {
      void report(origin.origin, origin.jobId, `Job ${origin.jobId} ${status === "done" ? "done" : "blocked"}: ${summary}`);
    } else {
      void sendStatus(origin.team, origin.account, origin.device, origin.jobId, status, summary);
    }
  }

  return {
    targets,
    submit,
    message,
    receive,
    approve,
    decline,
    relocate,
    restore,
    runEnded,
    inbox: () => inbox,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export type MeshJobs = ReturnType<typeof createMeshJobs>;

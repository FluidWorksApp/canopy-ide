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
//    its own; a job from anyone else waits for the receiving user to approve
//    it. "Same account" is the envelope's server-authenticated sender, never a
//    field the sender wrote — the brief is about to be handed to an agent that
//    can edit files, so this check is the whole security story.
//
// Every step (accepted, declined, started, done, blocked, failed) is reported
// back into the submitting agent's terminal as a mesh message tagged
// ref {kind: "job", id}, so the submitter can wait for it or look it up with
// canopy_mesh. State is in memory: a restart forgets pending approvals and
// in-flight jobs, and the 5-minute envelope window means a peer that is
// offline that long misses a status update. Both are stated, not hidden, in
// what the submit tool returns.

import type { AttentionInput } from "./attention";
import type { Device } from "./teamMessaging/client";
import { deviceOnline } from "./teamMessaging/client";
import {
  clipDetail,
  MAX_JOB_BRIEF,
  type JobRequest,
  type JobState,
  type JobStatus,
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
  /** Launch an agent on a brief in a workspace (App's startSession). */
  start: (req: { project: string; prompt: string; label: string }) => Promise<StartedJob>;
  sessions: () => JobSession[];
  teamName: (team: string) => string | undefined;
  /** Type a job step into the submitting terminal (ipc.meshJobUpdate). */
  report: (ptyId: number, instance: string, jobId: string, text: string) => Promise<unknown>;
  post: (input: AttentionInput) => string;
  resolve: (attentionId: string, how: "answered" | "withdrawn" | "dismissed") => void;
  now: () => number;
  newId: () => string;
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
   *  lands here when no workspace could be picked for it automatically. */
  sameAccount: boolean;
  received: number;
  attentionId?: string;
}

/** Where a submitted job's updates go. */
interface Origin {
  ptyId: number;
  instance: string;
}
type Outgoing = Origin & { title: string; team?: string; device?: string; target: string };
/** A run this window started for a job, keyed by its task run id. */
type RunOrigin =
  | { kind: "local"; jobId: string; origin: Origin }
  | { kind: "remote"; jobId: string; team: string; account: string; device: string };

/** A pending approval's ceiling. Past it, a new job is declined on arrival
 *  rather than burying the ones already waiting. */
const MAX_INBOX = 20;
/** Who "me" is when an agent targets this account's other machine. */
const SELF = new Set(["me", "self", "myself", "my machine", "my other machine"]);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function jobTitle(title: string | null | undefined, brief: string): string {
  return clip(oneLine(title ?? "") || oneLine(brief) || "Mesh job", 80);
}

/** Who may run a job without asking: only this same account. */
export function needsApproval(sender: TeamJobSender, account: string): boolean {
  return sender.user !== account;
}

/** The workspace a job lands in when nobody picks: the one it names, else the
 *  only one there is. Null means a person has to choose. */
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
export function incomingBrief(job: JobRequest, from: string): string {
  return (
    `Mesh job ${job.id} from ${from}: ${job.title}. ${job.brief}\n\n` +
    "When you finish, or if you are blocked, call canopy_job_done — its summary is sent back to whoever submitted this job."
  );
}

const STEP: Record<JobState, string> = {
  accepted: "approved",
  declined: "declined",
  started: "started",
  done: "done",
  blocked: "blocked",
  failed: "failed",
};
const FINAL = new Set<JobState>(["declined", "done", "failed"]);

export function stepText(title: string, where: string, state: JobState, detail: string): string {
  const head = `Job "${title}" (${where}) ${STEP[state]}`;
  return detail ? `${head}: ${detail}` : `${head}.`;
}

export function createMeshJobs(deps: MeshJobDeps) {
  const outgoing = new Map<string, Outgoing>();
  const runs = new Map<string, RunOrigin>();
  const seen = new Set<string>();
  let inbox: IncomingJob[] = [];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());

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

  function targets() {
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
      myMachines: machines,
      teammates: [...people.values()],
      note: sessions.length
        ? "canopy_mesh_submit with workspace (this window), member \"me\" (your other machine), or a teammate's name or id. Jobs to a teammate wait for their approval; only online members can receive one."
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

  async function submit(req: {
    brief: string;
    title?: string | null;
    workspace?: string | null;
    member?: string | null;
    device?: string | null;
    ptyId?: number | null;
    instance?: string | null;
  }) {
    const brief = (req.brief ?? "").trim();
    if (!brief) throw new Error("A job needs a brief.");
    if (new TextEncoder().encode(brief).length > MAX_JOB_BRIEF) throw new Error("A job brief is capped at 16 KB.");
    if (req.ptyId == null || !req.instance) throw new Error("Only a Canopy agent terminal can submit a mesh job.");
    const origin: Origin = { ptyId: req.ptyId, instance: req.instance };
    const id = deps.newId();
    const title = jobTitle(req.title, brief);
    const workspace = (req.workspace ?? "").trim() || null;
    const member = (req.member ?? "").trim();

    // This window: the same account by definition, so it simply starts.
    if (!member) {
      if (!workspace) throw new Error("Name the workspace to run the job in (see canopy_mesh_targets).");
      const named = pickWorkspace(workspace, deps.workspaces());
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
    const job: JobRequest = { id, title, brief, workspace, created: deps.now() };
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
            ? `Sent to your other machine; it starts there on its own${workspace ? ` in ${workspace}` : ""}. Updates arrive here as mesh notices tagged ref {kind: "job", id: "${id}"}.`
            : `Sent to ${who.name}. It waits for them to approve it in Canopy; their decision and the job's outcome arrive here as mesh notices tagged ref {kind: "job", id: "${id}"}. An approval that never comes is a "no" — do not resubmit unprompted.`,
        };
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(errors[0] ?? `${who.name} isn't on any team this account belongs to.`);
  }

  // ---- receiving -----------------------------------------------------------

  async function run(incoming: IncomingJob, workspace: string) {
    const { job, team, account, sender } = incoming;
    const from = incoming.sameAccount
      ? "this account's other machine"
      : `${sender.name ?? "a teammate"} (your Canopy teammate)`;
    let started: StartedJob;
    try {
      started = await deps.start({ project: workspace, prompt: incomingBrief(job, from), label: job.title });
    } catch (err) {
      started = { started: false, project: workspace, note: String(err instanceof Error ? err.message : err) };
    }
    if (!started.started) {
      await sendStatus(team, account, sender.device, job.id, "failed", started.note);
      return started;
    }
    if (started.runId) runs.set(started.runId, { kind: "remote", jobId: job.id, team, account, device: sender.device });
    await sendStatus(team, account, sender.device, job.id, "started", `Running in ${started.project}.`);
    return started;
  }

  function receive(event: TeamJobEvent) {
    if (event.kind === "job-status") {
      const sent = outgoing.get(event.status.jobId);
      // Only the device the job went to may speak for it.
      if (!sent || sent.device !== event.sender.device || sent.team !== event.team) return;
      void report(sent, event.status.jobId, stepText(sent.title, sent.target, event.status.state, event.status.detail));
      if (FINAL.has(event.status.state)) outgoing.delete(event.status.jobId);
      return;
    }
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
    };
    const workspace = sameAccount ? pickWorkspace(job.workspace, deps.workspaces()) : null;
    if (workspace) {
      void run(incoming, workspace).then((started) =>
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
    const sender = event.sender.name ?? "A teammate";
    incoming.attentionId = deps.post({
      kind: "question",
      tone: "info",
      source: "team",
      title: sameAccount
        ? `Choose a workspace for a job from your other machine: ${job.title}`
        : `${sender} wants your agent to: ${job.title}`,
      body: "Review it in the job inbox before anything runs.",
      where: { kind: "panel", panel: "team" },
      dedupeKey: `mesh-job:${job.id}`,
    });
    inbox = [...inbox, incoming];
    changed();
  }

  function take(jobId: string) {
    const item = inbox.find((i) => i.job.id === jobId);
    if (!item) return undefined;
    inbox = inbox.filter((i) => i !== item);
    changed();
    return item;
  }

  async function approve(jobId: string, workspace: string) {
    const item = take(jobId);
    if (!item) throw new Error("That job is no longer waiting.");
    if (item.attentionId) deps.resolve(item.attentionId, "answered");
    if (!item.sameAccount) await sendStatus(item.team, item.account, item.sender.device, jobId, "accepted", `Approved to run in ${workspace}.`);
    return run(item, workspace);
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
    receive,
    approve,
    decline,
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

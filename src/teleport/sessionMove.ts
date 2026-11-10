import { basename } from "../paths";
/**
 * Teleport phase 2: move a Claude session between this Mac and a workspace.
 * docs/teleport-design.md ("Project identity", "Manifest", "Phases").
 *
 * Everything that touches a machine is injected (`MoveDeps`), so the rules are
 * tested without one: the checks that decide whether a move may start, the
 * order of the steps, what is sealed when, and how a failure is left.
 *
 * The order matters. The source session is stopped and its transcript read only
 * AFTER the files are sent, and the destination resumes only after the stop, so
 * the same conversation is never live on two machines and the transcript copied
 * is the final one. A failure after the stop tries to bring the source back.
 */
import { TELEPORT_CLI_ID } from "../../shared/agentCliIdentity";
import { counterpartOf, canonicalProjectId, type ProjectLike } from "../placement/identity";
import { claudeTranscriptPath, mapClaudeTranscript } from "./claudeTranscript";
import { TELEPORT_MANIFEST_VERSION, validateTeleportManifest, type TeleportManifest } from "./manifest";

export type MoveStep = "prepare" | "send" | "apply" | "resume";
export const MOVE_STEPS: readonly MoveStep[] = ["prepare", "send", "apply", "resume"];

/** CLIs whose store layout and resume syntax are verified (docs: Phases).
 *
 *  Codex is deliberately NOT here. Its rollouts under ~/.codex/sessions are
 *  plain JSONL (session_meta, turn_context, response_items; the cwd appears in
 *  session_meta and every turn_context), so rewriting paths would be easy. But
 *  `codex resume <id>` finds a conversation through its SQLite state database
 *  (~/.codex/state_*.sqlite, a `threads` table), not by scanning the files, and
 *  a rollout copied in without that row is invisible to it. Writing into that
 *  database from outside the CLI cannot be verified here, so a Codex session is
 *  refused with the reason rather than moved half-registered. */
export const TELEPORTABLE_CLIS: readonly string[] = [TELEPORT_CLI_ID];

export interface MoveComponent {
  id: string;
  label: string;
  path: string;
  /** The component's path relative to its repository, when known. */
  relative?: string;
}

export interface MoveProject extends ProjectLike {
  components: readonly MoveComponent[];
}

/** One side of a move. */
export interface MoveEnd {
  /** The machine: "local" or "remote:<workspaceId>" (placement/types targetKey). */
  env: string;
  project: MoveProject;
  /** That machine's home directory, where the CLI keeps its conversations. */
  home: string;
}

export interface MoveAgent {
  cli: string;
  sessionId: string;
  model?: string;
  resumeKeeps?: string[];
  /** The session's working directory on the source machine. */
  cwd: string;
  /** Not mid-turn. A busy agent needs the person's explicit OK (`allowBusy`). */
  idle: boolean;
  /** Set when the agent runs in its own worktree (`<repo>-wt-<name>`): the
   *  worktree's root, the repository it belongs to (a component path) and the
   *  branch it has checked out. The worktree is recreated on the destination. */
  worktree?: { root: string; repo: string; branch: string };
}

export interface RepoState {
  origin: string | null;
  branch: string | null;
  head: string;
}

export interface MovePlan {
  agent: MoveAgent;
  source: MoveEnd;
  dest: MoveEnd;
  sourceComponent: MoveComponent;
  destComponent: MoveComponent;
  /** The destination's own project record for the same project. */
  destProject: MoveProject;
}

export type CheckResult = { ok: true; plan: MovePlan } | { ok: false; reasons: string[] };

/** Directory a path sits under, as a path relative to it; null when not under it. */
export function relativeUnder(root: string, p: string): string | null {
  const r = root.length > 1 ? root.replace(/\/+$/, "") : root;
  if (p === r) return "";
  const prefix = r === "/" ? "/" : `${r}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

/** `cwd` moved from under `fromRoot` to under `toRoot`. Null when not under it. */
export function rebaseCwd(cwd: string, fromRoot: string, toRoot: string): string | null {
  const rel = relativeUnder(fromRoot, cwd);
  if (rel === null) return null;
  const to = toRoot.length > 1 ? toRoot.replace(/\/+$/, "") : toRoot;
  return rel === "" ? to : `${to === "/" ? "" : to}/${rel}`;
}

/** The destination component for a source component: by label first, then by
 *  path relative to its repository. Exactly one match or none, never a guess. */
export function matchComponent(
  source: MoveComponent,
  candidates: readonly MoveComponent[],
): { ok: true; component: MoveComponent } | { ok: false; reason: string } {
  const byLabel = candidates.filter((c) => c.label === source.label);
  if (byLabel.length === 1) return { ok: true, component: byLabel[0] };
  if (byLabel.length > 1) {
    const rel = source.relative;
    const narrowed = rel === undefined ? [] : byLabel.filter((c) => c.relative === rel);
    if (narrowed.length === 1) return { ok: true, component: narrowed[0] };
    return { ok: false, reason: `"${source.label}" matches ${byLabel.length} components there` };
  }
  if (source.relative !== undefined) {
    const byRel = candidates.filter((c) => c.relative === source.relative);
    if (byRel.length === 1) return { ok: true, component: byRel[0] };
    if (byRel.length > 1) return { ok: false, reason: `"${source.label}" matches ${byRel.length} components there by path` };
  }
  return { ok: false, reason: `"${source.label}" has no matching component there` };
}

export interface CheckInput {
  agent: MoveAgent;
  source: MoveEnd;
  /** The destination machine and ITS projects (the one `dest.project` is chosen from `destProjects`). */
  dest: Omit<MoveEnd, "project">;
  destProjects: readonly MoveProject[];
  sourceRepo: RepoState;
  /** Absent when the destination has no copy of the repository yet. */
  destRepo: RepoState | null;
  /** The destination path holds uncommitted changes a move would overwrite. */
  destDirty: boolean;
  /** The branch is already checked out in another worktree on the destination. */
  branchHeldElsewhere: boolean;
  /** The person agreed to move an agent that is mid-turn. */
  allowBusy?: boolean;
}

/**
 * Whether a move may start, and if so exactly what it will do. Every reason a
 * move cannot start is collected, each naming the project and component, so the
 * dialog can show them all rather than one at a time. Changes nothing.
 */
export function checkMove(input: CheckInput): CheckResult {
  const { agent, source, dest } = input;
  const reasons: string[] = [];
  const name = source.project.name;

  if (!TELEPORTABLE_CLIS.includes(agent.cli)) {
    reasons.push(`${agent.cli} sessions cannot be moved yet (only ${TELEPORTABLE_CLIS.join(", ")}); the files can still be sent.`);
  }
  if (!agent.idle && !input.allowBusy) reasons.push("The agent is mid-turn. Wait for it to finish, or agree to move it anyway.");

  const destProject = counterpartOf(source.project, input.destProjects, dest.env);
  const partial = destProject
    ? undefined
    : input.destProjects.find((p) => p.mirrorIncomplete && p.mirroredFrom === canonicalProjectId(source.project));
  if (!destProject) {
    reasons.push(
      partial
        ? `${name} is only partly copied to the destination. Finish setting it up first.`
        : `${name} is not set up on the destination. Send the project there first.`,
    );
  } else if (destProject.mirrorIncomplete) {
    reasons.push(`${name} is only partly copied to the destination. Finish setting it up first.`);
  }

  // An agent in a worktree belongs to the component that is its main checkout;
  // its folder must be inside the worktree.
  const wt = agent.worktree;
  if (wt && relativeUnder(wt.root, agent.cwd) === null) {
    reasons.push(`The agent's folder ${agent.cwd} is not inside its workspace ${wt.root}.`);
  }
  const sourceComponent = wt
    ? source.project.components.find((c) => c.path === wt.repo)
    : source.project.components.find((c) => relativeUnder(c.path, agent.cwd) !== null);
  if (!sourceComponent) reasons.push(`The agent's folder ${agent.cwd} is not inside a component of ${name}.`);

  let destComponent: MoveComponent | undefined;
  if (destProject && sourceComponent) {
    const matched = matchComponent(sourceComponent, destProject.components);
    if (matched.ok) destComponent = matched.component;
    else reasons.push(`In ${name}: ${matched.reason}.`);
  }

  if (input.destRepo) {
    if (input.destRepo.origin !== input.sourceRepo.origin) {
      reasons.push(
        `The repository on the destination points somewhere else (${input.destRepo.origin ?? "no origin"}, not ${input.sourceRepo.origin ?? "no origin"}).`,
      );
    }
  } else if (destProject) {
    reasons.push(`There is no copy of the repository on the destination for ${name}.`);
  }
  // Commits can only be carried onto the same branch; a worktree agent brings
  // its own branch and gets its own worktree, so the main checkout's branch is irrelevant.
  if (!wt && input.destRepo && input.sourceRepo.branch && input.destRepo.branch && input.destRepo.branch !== input.sourceRepo.branch) {
    reasons.push(`The destination is on ${input.destRepo.branch}, not ${input.sourceRepo.branch}. Switch it there first.`);
  }
  if (input.destDirty) reasons.push("The destination has uncommitted changes that the move would overwrite. It never overwrites.");
  if (input.branchHeldElsewhere) reasons.push("The branch is already checked out in another worktree on the destination.");

  if (reasons.length > 0 || !destProject || !sourceComponent || !destComponent) return { ok: false, reasons };
  return {
    ok: true,
    plan: {
      agent,
      source,
      dest: { ...dest, project: destProject },
      sourceComponent,
      destComponent,
      destProject,
    },
  };
}

/** `project` with a link to `other` on `env`, added once; never to itself. */
export function withLink<T extends ProjectLike>(project: T, env: string, id: string): T {
  if (id === project.id) return project;
  const existing = project.linkedTo ?? [];
  if (existing.some((l) => l.env === env && l.id === id)) return project;
  return { ...project, linkedTo: [...existing, { env, id }] };
}

/** Both projects' records after a move, each pointing at the other. */
export function linkBoth<S extends ProjectLike, D extends ProjectLike>(
  source: { env: string; project: S },
  dest: { env: string; project: D },
): { source: S; dest: D } {
  return {
    source: withLink(source.project, dest.env, dest.project.id),
    dest: withLink(dest.project, source.env, source.project.id),
  };
}

export interface SendResult {
  /** The directory on the destination that corresponds to the source root the
   *  files came from (the component path, or the recreated worktree). */
  destRoot: string;
  /** Commits were carried to the destination in this step (recorded in the manifest). */
  carriedCommits?: boolean;
}

export interface MoveDeps {
  /** What the person ticked (changed files, ignored files, secrets unticked); opaque here. */
  selection: unknown;
  /** The root the session's files live under on the source: its component path or worktree. */
  sourceRoot: string;
  /** Branch, commits, changed files and chosen ignored files to the destination
   *  (the mirror's incremental path). Resolves with where they landed. */
  sendFiles(plan: MovePlan, selection: unknown, onProgress: (fraction: number) => void): Promise<SendResult>;
  /** Stop the source session and make its transcript final. */
  stopSource(plan: MovePlan): Promise<void>;
  /** Put a stopped source session back; best effort after a failure. */
  restoreSource?(plan: MovePlan): Promise<void>;
  readTranscript(path: string): Promise<string>;
  sha256(text: string): Promise<string>;
  /** Write the rewritten transcript on the destination at `path`. */
  writeTranscript(plan: MovePlan, path: string, text: string): Promise<void>;
  /** Read it back on the destination: used to verify the hash. */
  readBackTranscript(plan: MovePlan, path: string): Promise<string>;
  /** Start the verified resume command for the session on the destination. */
  resumeTarget(plan: MovePlan, args: { sessionId: string; cwd: string; model?: string; resumeKeeps?: string[] }): Promise<void>;
  /** Persist both project records with their links. */
  saveLinks(next: { source: MoveProject; dest: MoveProject }): Promise<void>;
  onStep?(step: MoveStep, state: "start" | "done" | "failed", detail?: { fraction?: number; error?: string }): void;
  repo: { head: string; origin: string | null; branch: string | null; worktree: string | null };
  /** Whether the destination gets the account copied. Default off. */
  copyAccount?: boolean;
  isCancelled?(): boolean;
}

export type MoveOutcome =
  | { ok: true; manifest: TeleportManifest; destCwd: string }
  | { ok: false; step: MoveStep; error: string; sourceStopped: boolean; sourceRestored: boolean };

class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

/**
 * Run a checked plan. Nothing is changed on either machine before `apply`
 * starts, so cancelling during prepare or send leaves both untouched (the sent
 * files are the mirror's idempotent kind and harmless).
 */
export async function runMove(plan: MovePlan, deps: MoveDeps): Promise<MoveOutcome> {
  const { agent } = plan;
  let step: MoveStep = "prepare";
  let stopped = false;
  const guard = () => {
    if (deps.isCancelled?.()) throw new Cancelled();
  };
  const begin = (s: MoveStep) => {
    step = s;
    guard();
    deps.onStep?.(s, "start");
  };
  const done = (s: MoveStep) => deps.onStep?.(s, "done");

  try {
    begin("prepare");
    const srcHome = plan.source.home;
    const destHome = plan.dest.home;
    // Fails closed: an unsafe session id or path throws before anything moves.
    const sourcePath = claudeTranscriptPath(srcHome, agent.cwd, agent.sessionId);
    done("prepare");

    begin("send");
    const sent = await deps.sendFiles(plan, deps.selection, (fraction) => deps.onStep?.("send", "start", { fraction }));
    guard();
    const destCwd = rebaseCwd(agent.cwd, deps.sourceRoot, sent.destRoot);
    if (!destCwd) throw new Error(`The agent's folder is not under ${deps.sourceRoot}.`);
    const destPath = claudeTranscriptPath(destHome, destCwd, agent.sessionId);
    done("send");

    begin("apply");
    // Seal first: stop the session, then read the final transcript.
    await deps.stopSource(plan);
    stopped = true;
    const original = await deps.readTranscript(sourcePath);
    const mapped = mapClaudeTranscript({
      transcript: original,
      // The whole root moves, not just the starting folder: a session that
      // `cd`-ed elsewhere in the same repository must still point inside it.
      sourceCwd: deps.sourceRoot,
      destCwd: sent.destRoot,
      sessionId: agent.sessionId,
    });
    const hash = await deps.sha256(mapped.text);
    const manifest: TeleportManifest = {
      version: TELEPORT_MANIFEST_VERSION,
      from: plan.source.env === "local" ? { kind: "local" } : { kind: "remote", workspaceId: plan.source.env.replace(/^remote:/, "") },
      agent: {
        cli: agent.cli,
        sessionId: agent.sessionId,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.resumeKeeps?.length ? { resumeKeeps: agent.resumeKeeps } : {}),
      },
      repo: {
        origin: deps.repo.origin,
        branch: deps.repo.branch,
        head: deps.repo.head,
        worktree: agent.worktree ? basename(agent.worktree.root) || null : null,
        gitBundle: sent.carriedCommits ? "commits.bundle" : null,
        filesArchive: "files.tgz",
      },
      transcript: { path: "session.jsonl", sha256: hash, cwdFrom: agent.cwd, cwdTo: destCwd },
      account: { copy: deps.copyAccount === true },
    };
    const valid = validateTeleportManifest(manifest);
    if (!valid.ok) throw new Error(`The move manifest is not valid: ${valid.errors.join("; ")}`);
    guard();
    await deps.writeTranscript(plan, destPath, mapped.text);
    const back = await deps.readBackTranscript(plan, destPath);
    if ((await deps.sha256(back)) !== hash) throw new Error("The transcript on the destination does not match what was sent.");
    done("apply");

    begin("resume");
    await deps.resumeTarget(plan, {
      sessionId: agent.sessionId,
      cwd: destCwd,
      model: agent.model,
      resumeKeeps: agent.resumeKeeps,
    });
    // Linking is bookkeeping: the move already happened, so a failure to save
    // it must not read as a failed move.
    await deps
      .saveLinks({
        source: withLink(plan.source.project, plan.dest.env, plan.destProject.id),
        dest: withLink(plan.destProject, plan.source.env, plan.source.project.id),
      })
      .catch(() => {});
    done("resume");
    return { ok: true, manifest, destCwd };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    deps.onStep?.(step, "failed", { error });
    let restored = false;
    if (stopped && deps.restoreSource) {
      restored = await deps.restoreSource(plan).then(() => true, () => false);
    }
    return { ok: false, step, error, sourceStopped: stopped, sourceRestored: restored };
  }
}

/** For callers that only have the Project records: the canonical id both sides share. */
export const sharedProjectId = (project: ProjectLike): string => canonicalProjectId(project);

// The machine-facing half of a teleport: real implementations of what
// sessionMove.ts injects, built from commands both machines answer (this Mac's
// desktop and a workspace host serve the same names: parity table in
// docs/linux-workspace-parity.md). Each machine is just an `Invoke`, so the
// same code runs against fakes in tests.
//
// What is NOT here: stopping and resuming the agent (those are the app's own
// terminal paths, passed in as callbacks) and saving project records.
import { ensureProjectOnRemote } from "../remoteExecution/mirror";
import type { Invoke } from "../remoteExecution/temporaryWorkspace";
import type { MoveDeps, MovePlan, RepoState, SendResult } from "./sessionMove";

export const teleportHome = (machine: Invoke) => machine<string>("teleport_home");

interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  is_main?: boolean;
}

/** Origin, branch and HEAD of the repository at `repo`, as that machine reports them. */
export async function readRepoState(machine: Invoke, repo: string): Promise<RepoState> {
  const [origin, worktrees] = await Promise.all([
    machine<string | null>("git_remote_url", { repo }).catch(() => null),
    machine<Worktree[]>("git_worktrees", { repo }),
  ]);
  const here = worktrees.find((w) => w.path === repo) ?? worktrees[0];
  return { origin: origin || null, branch: here?.branch ?? null, head: here?.head ?? "" };
}

/** Whether the working tree at `path` has any change (so a move must not write there). */
export async function isDirty(machine: Invoke, path: string): Promise<boolean> {
  const status = await machine<{ entries: unknown[] }>("git_status", { path });
  return status.entries.length > 0;
}

/** Whether `branch` is checked out in a worktree other than the one at `repo`. */
export async function branchHeldElsewhere(machine: Invoke, repo: string, branch: string | null): Promise<boolean> {
  if (!branch) return false;
  const worktrees = await machine<Worktree[]>("git_worktrees", { repo });
  return worktrees.some((w) => w.branch === branch && w.path !== repo);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface RemoteStore {
  projects: { id: string; mirroredFrom?: string; mirrorIncomplete?: boolean; components: { label: string; path: string }[] }[];
}

/** Where an agent's worktree lands on the destination: the same `-wt-<name>`
 *  sibling of the destination repository, so both machines name it alike. Null
 *  when `sourceRoot` is not a `<sourceRepo>-wt-<name>` folder. */
export function destWorktreeRoot(sourceRepo: string, sourceRoot: string, destRepo: string): string | null {
  const prefix = `${sourceRepo.replace(/\/+$/, "")}-wt-`;
  if (!sourceRoot.startsWith(prefix)) return null;
  const name = sourceRoot.slice(prefix.length);
  return name && !name.includes("/") ? `${destRepo.replace(/\/+$/, "")}-wt-${name}` : null;
}

/** Make sure `destRoot` is a worktree of `destRepo` on `branch` on the destination.
 *  An existing one at that path is reused; otherwise the branch is checked out
 *  there, or created from the destination's HEAD when it has no such branch (the
 *  commits are carried onto it afterwards). */
export async function ensureDestWorktree(input: { dest: Invoke; destRepo: string; destRoot: string; branch: string }): Promise<void> {
  const worktrees = await input.dest<Worktree[]>("git_worktrees", { repo: input.destRepo });
  const existing = worktrees.find((w) => w.path === input.destRoot);
  if (existing) {
    if (existing.branch !== input.branch) {
      throw new Error(`${input.destRoot} on the destination is on ${existing.branch ?? "no branch"}, not ${input.branch}.`);
    }
    return;
  }
  type Outcome = { kind: string; message?: string; detail?: string; holder?: { path?: string } };
  const add = (create: boolean) =>
    input.dest<Outcome>("git_worktree_add", { repo: input.destRepo, path: input.destRoot, branch: input.branch, create });
  let outcome = await add(false);
  if (outcome.kind !== "switched" && outcome.kind !== "branch_in_worktree") outcome = await add(true);
  if (outcome.kind === "branch_in_worktree") {
    throw new Error(`${input.branch} is already checked out in another worktree on the destination${outcome.holder?.path ? ` (${outcome.holder.path})` : ""}.`);
  }
  if (outcome.kind !== "switched") throw new Error(outcome.detail || outcome.message || "Could not create the workspace on the destination.");
}

/**
 * Carry commits and tracked changes from the working tree at `sourcePath` to the
 * one at `destPath`. Commits go as a git bundle applied fast-forward only; a
 * destination that is ahead, diverged, or missing commits this machine lacks is
 * refused with what to do, before anything is stopped. Tracked uncommitted
 * changes go as a binary patch onto the (clean) destination. Both steps are safe
 * to repeat after a partial failure. Untracked files are not carried.
 */
export async function carryRepoState(input: {
  source: Invoke;
  dest: Invoke;
  sourcePath: string;
  destPath: string;
}): Promise<{ carriedCommits: boolean }> {
  const { source, dest, sourcePath, destPath } = input;
  const [src, dst] = await Promise.all([readRepoState(source, sourcePath), readRepoState(dest, destPath)]);
  let carriedCommits = false;
  if (src.head && dst.head && src.head !== dst.head) {
    const relation = await source<string>("teleport_git_relation", { path: sourcePath, other: dst.head });
    if (relation === "ahead") {
      throw new Error(`The destination has newer commits (${dst.head.slice(0, 7)}) than this machine (${src.head.slice(0, 7)}). Update here first, then try again.`);
    }
    if (relation === "diverged") {
      throw new Error("This machine and the destination have each made commits the other lacks, so nothing was moved. Merge or rebase on one side first.");
    }
    if (relation === "unknown") {
      throw new Error(`The destination is at ${dst.head.slice(0, 7)}, which this machine does not have. Fetch there or here first, then try again.`);
    }
    const bundle = await source<string>("teleport_bundle_create", { path: sourcePath, since: dst.head });
    await dest<string>("teleport_bundle_apply", { path: destPath, data: bundle });
    carriedCommits = true;
  }
  const patch = await source<string>("teleport_patch_create", { path: sourcePath });
  if (patch) {
    const already = await dest<string>("teleport_patch_create", { path: destPath }).catch(() => "");
    if (already !== patch) await dest("teleport_patch_apply", { path: destPath, data: patch });
  }
  return { carriedCommits };
}

/** Send for a move that carries no ignored files: the reverse direction (the
 *  mirror only writes TO a workspace) and any agent in a worktree. Commits and
 *  tracked changes still go, through the bundle and patch. */
export function carrySendFiles(input: {
  source: Invoke;
  dest: Invoke;
  /** The component (main checkout) on the source the agent belongs to. */
  sourceRepo: string;
  /** Set for an agent in a worktree: its root and branch on the source. */
  worktree?: { root: string; branch: string };
}): MoveDeps["sendFiles"] {
  return async (plan: MovePlan, _selection: unknown, onProgress: (fraction: number) => void): Promise<SendResult> => {
    const destRepo = plan.destComponent.path;
    let sourcePath = input.sourceRepo;
    let destRoot = destRepo;
    if (input.worktree) {
      const root = destWorktreeRoot(input.sourceRepo, input.worktree.root, destRepo);
      if (!root) throw new Error(`${input.worktree.root} is not a workspace of ${input.sourceRepo}, so it cannot be recreated there.`);
      onProgress(0.1);
      await ensureDestWorktree({ dest: input.dest, destRepo, destRoot: root, branch: input.worktree.branch });
      sourcePath = input.worktree.root;
      destRoot = root;
    }
    onProgress(0.3);
    const carried = await carryRepoState({ source: input.source, dest: input.dest, sourcePath, destPath: destRoot });
    onProgress(1);
    return { destRoot, carriedCommits: carried.carriedCommits };
  };
}

/**
 * Bring the project's chosen git-ignored files to the destination and confirm
 * carry commits and tracked changes to the repository there (a destination
 * that is ahead or has diverged stops the move HERE, before anything is
 * stopped). The project itself must already be set up (checkMove requires it).
 */
export function mirrorSendFiles(input: {
  source: Invoke;
  dest: Invoke;
  /** The source project's id and the component the agent runs in. */
  projectId: string;
  componentId: string;
  /** Repo-relative ignored files to carry. */
  files: string[];
  sourceRepo: string;
}): MoveDeps["sendFiles"] {
  return async (plan: MovePlan, _selection: unknown, onProgress: (fraction: number) => void): Promise<SendResult> => {
    const final = await ensureProjectOnRemote(
      { local: input.source, remote: input.dest },
      {
        projectId: input.projectId,
        componentIds: [input.componentId],
        selectedFiles: { [input.componentId]: input.files },
        install: false,
      },
      (progress) => {
        const total = progress.steps.length || 1;
        onProgress(progress.steps.filter((s) => s.state === "done" || s.state === "skipped").length / total);
      },
    );
    const failed = final.projects.find((p) => p.state === "failed");
    if (failed) throw new Error(failed.detail || `Could not send ${failed.name}.`);
    const store = JSON.parse(await input.dest<string>("store_load")) as RemoteStore;
    const project = store.projects.find((p) => p.id === plan.destProject.id);
    const component = project?.components.find((c) => c.path === plan.destComponent.path);
    if (!component) throw new Error("The project is no longer set up on the destination.");
    const [src, dst] = await Promise.all([
      readRepoState(input.source, input.sourceRepo),
      readRepoState(input.dest, component.path),
    ]);
    void src;
    void dst;
    // The mirror's incremental path never touches commits or changes on an
    // existing project, so they are carried here (bundle + patch).
    const carried = await carryRepoState({ source: input.source, dest: input.dest, sourcePath: input.sourceRepo, destPath: component.path });
    onProgress(1);
    return { destRoot: component.path, carriedCommits: carried.carriedCommits };
  };
}

/** Transcript read/write for one session on each machine, through the
 *  dedicated commands (the file commands are scoped to project folders). */
export function transcriptIo(input: {
  source: Invoke;
  dest: Invoke;
  agent: { cwd: string; sessionId: string };
  /** Where the session's folder lands on the destination; known once files are sent. */
  destCwd: () => string;
}): Pick<MoveDeps, "readTranscript" | "writeTranscript" | "readBackTranscript"> {
  return {
    async readTranscript() {
      const text = await input.source<string | null>("teleport_transcript_read", {
        cwd: input.agent.cwd,
        sessionId: input.agent.sessionId,
      });
      if (text === null) throw new Error("This machine has no saved conversation for the session.");
      return text;
    },
    async writeTranscript(_plan, _path, text) {
      await input.dest("teleport_transcript_write", { cwd: input.destCwd(), sessionId: input.agent.sessionId, text });
    },
    async readBackTranscript() {
      const text = await input.dest<string | null>("teleport_transcript_read", {
        cwd: input.destCwd(),
        sessionId: input.agent.sessionId,
      });
      return text ?? "";
    },
  };
}

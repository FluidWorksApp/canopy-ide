// An agent's own git worktree on another machine, made through that machine's
// git commands (the same ones the local flow uses), never this Mac's.
//
// Mirrors the local launch in ProjectView: find the repository the component is
// in, create `<repo>-wt-<branch>` on a fresh `agent/<cli>-<stamp>` branch, copy
// the small ignored config files the agent needs. Every failure falls back to the
// component folder itself, with a note: an agent in the right project beats no
// agent.
import { agentWorkspaceBranch } from "../agentSpawn";
import { workspacePath } from "../useBranchSwitch";

export type MachineInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface RemoteWorkspace {
  /** Where the agent runs on that machine. */
  cwd: string;
  /** Said to the person when something fell back or did not copy. */
  notes: string[];
  /** True when a worktree of its own was made. */
  isolated: boolean;
}

interface RepoRow {
  path: string;
}
interface Outcome {
  kind: string;
  path?: string | null;
}

const inside = (cwd: string, repo: string) => cwd === repo || cwd.startsWith(`${repo}/`);

export async function prepareRemoteWorkspace(opts: {
  invoke: MachineInvoke;
  /** The component folder on that machine. */
  cwd: string;
  name: string;
  cliId: string;
  cliName: string;
  /** The agentWorkspaceByDefault setting, or an explicit gesture. */
  isolate: boolean;
  /** Copy the ignored config files (the workspaceBootstrap setting). */
  bootstrap: boolean;
  now?: Date;
}): Promise<RemoteWorkspace> {
  const { invoke, cwd } = opts;
  if (!opts.isolate) return { cwd, notes: [], isolated: false };
  const notes: string[] = [];
  let repo: string | undefined;
  try {
    const rows = await invoke<RepoRow[]>("git_repos", { components: [[opts.name, cwd]] });
    repo = rows.map((r) => r.path).find((p) => inside(cwd, p)) ?? rows[0]?.path;
  } catch {
    /* No answer: treated as not a repository. */
  }
  if (!repo) {
    notes.push(`${opts.cliName} opened in the project folder because it is not inside a Git repository there.`);
    return { cwd, notes, isolated: false };
  }
  const branch = agentWorkspaceBranch(opts.cliId, opts.now);
  let outcome: Outcome;
  try {
    outcome = await invoke<Outcome>("git_worktree_add", {
      repo,
      path: workspacePath(repo, branch),
      branch,
      create: true,
    });
  } catch (error) {
    notes.push(`Could not make a workspace for ${opts.cliName} there, so it opened in the project folder: ${String((error as Error)?.message ?? error)}`);
    return { cwd, notes, isolated: false };
  }
  if (outcome.kind !== "switched" || !outcome.path) {
    notes.push(`Could not make a workspace for ${opts.cliName} there, so it opened in the project folder.`);
    return { cwd, notes, isolated: false };
  }
  const created = outcome.path;
  if (opts.bootstrap) {
    // Config half only, awaited: the CLI must not start before `.env` lands.
    await invoke("git_worktree_bootstrap", { repo, path: created, phase: "config" }).catch((error) =>
      notes.push(`${opts.cliName}'s workspace is ready, but its ignored config could not be copied: ${String(error)}`),
    );
  }
  return { cwd: created, notes, isolated: true };
}

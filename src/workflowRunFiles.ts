// The folder a workflow run keeps its artifacts in — reports, verdicts, the
// spec path an EGM draft step chose — and keeping that folder out of git.
//
// Made by the launcher before the first agent step, not left to the agent:
// a read-only step is only allowed to write inside it, and a gate that pointed
// at a folder nobody created would read as a step that cannot do its job.
import { WORKFLOW_RUNS_DIR, workflowRunDir } from "./workflowPrompt";

export interface WorkflowRunFilesIo {
  exists(path: string): Promise<boolean>;
  /** Create an empty file, making its parent directories. */
  create(path: string): Promise<unknown>;
  write(path: string, content: string): Promise<void>;
  read(path: string, maxBytes: number): Promise<string>;
}

const readme = (runId: string) =>
  `# Workflow run ${runId}\n\n` +
  `Reports, verdicts and notes written by this run's agent steps. Canopy keeps ` +
  `this folder out of git through .git/info/exclude; delete it whenever the run ` +
  `is no longer useful.\n`;

/** The line that keeps every run folder out of `git status`. Anchored, so a
 *  directory of the same name deeper in the tree is not swept up with it. */
export const RUNS_EXCLUDE_LINE = `/${WORKFLOW_RUNS_DIR}/`;

/** Append the exclude line when it is missing. Best-effort by design: a
 *  checkout whose `.git` is a file (a linked worktree) or lives elsewhere just
 *  shows the run folder as untracked, which is untidy but harmless. Returns
 *  whether it wrote. */
export async function excludeRunsFromGit(
  worktreePath: string,
  io: WorkflowRunFilesIo,
): Promise<boolean> {
  const root = worktreePath.replace(/[\\/]+$/, "");
  if (!(await io.exists(`${root}/.git/HEAD`))) return false;
  const exclude = `${root}/.git/info/exclude`;
  let current = "";
  if (await io.exists(exclude)) {
    current = await io.read(exclude, 256 * 1024);
  } else {
    await io.create(exclude);
  }
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(RUNS_EXCLUDE_LINE) || lines.includes(`${WORKFLOW_RUNS_DIR}/`)) return false;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await io.write(exclude, `${current}${separator}${RUNS_EXCLUDE_LINE}\n`);
  return true;
}

/** Make sure the run folder exists and is excluded; returns its path. */
export async function prepareWorkflowRunDir(
  worktreePath: string,
  runId: string,
  io: WorkflowRunFilesIo,
): Promise<string> {
  const dir = workflowRunDir(worktreePath, runId);
  const marker = `${dir}/README.md`;
  if (!(await io.exists(marker))) {
    await io.create(marker);
    await io.write(marker, readme(runId));
  }
  await excludeRunsFromGit(worktreePath, io).catch(() => false);
  return dir;
}

/** A verdict file's text, or null when it is absent or unreadable — which the
 *  executor treats as "no verdict", never as an error that stops the run. */
export async function readVerdictFile(
  path: string,
  io: Pick<WorkflowRunFilesIo, "read">,
): Promise<string | null> {
  try {
    return await io.read(path, 4 * 1024);
  } catch {
    return null;
  }
}

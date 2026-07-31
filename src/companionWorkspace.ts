// The cross-project answers — the ones no coding agent can give.
//
// A coding agent's `canopy_project` answers about the project it is in because
// there is no other project it could mean. These answer about all of them, and
// that difference is the whole reason the companion exists: "which repos have
// unpushed work" is not a question you can ask a session that lives in one
// checkout.
//
// The shaping functions are pure and exported for their tests; only the thin
// wrappers at the bottom talk to ipc. What matters here is not the fetching —
// it is deciding what an agent should be handed, which is a different job from
// deciding what a panel should draw. A panel can afford a hundred rows and a
// scrollbar; an agent pays for every one of them in context, and a wall of
// clean repos is the least useful thing this could return.

import * as ipc from "./ipc";
import type { WorkspaceProject } from "./agentOps";

/** One repo's standing, as the companion reports it. */
export interface RepoReport {
  project: string;
  path: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Files changed but not committed, staged or not. */
  dirty: number;
  conflicted: number;
  /** True when there is genuinely nothing to say about this repo. */
  clean: boolean;
}

/** Turn a repo status into the report, and decide whether it is worth a row.
 *
 *  `clean` is computed rather than left to the reader because the agent's next
 *  move depends on it: a repo with nothing going on should not be described at
 *  all in an answer to "what needs me", and making that a field means the
 *  filtering happens here rather than in prose the model has to get right. */
export function repoReport(
  project: string,
  status: ipc.RepoStatus,
): RepoReport {
  const dirty =
    status.staged.length + status.unstaged.length + status.untracked.length;
  return {
    project,
    path: status.path,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    dirty,
    conflicted: status.conflicted.length,
    clean:
      dirty === 0 &&
      status.ahead === 0 &&
      status.behind === 0 &&
      status.conflicted.length === 0,
  };
}

/** One line per repo that has something to say, plus a count of the ones that
 *  do not. The summary line exists so "everything else is clean" is stated
 *  rather than inferred from an absence — an agent reading a short list has no
 *  way to tell "nothing to report" from "nothing was checked". */
export function summarise(reports: RepoReport[]): {
  repos: RepoReport[];
  clean: number;
  note: string;
} {
  const busy = reports.filter((r) => !r.clean);
  const clean = reports.length - busy.length;
  return {
    repos: busy,
    clean,
    note: busy.length
      ? `${busy.length} of ${reports.length} repos have uncommitted or unpushed work; the other ${clean} are clean.`
      : `All ${reports.length} repos are clean — nothing uncommitted, nothing unpushed.`,
  };
}

/** Which projects a request is about. An unrecognised name is an error rather
 *  than a silent fallback to everything: the companion asking about "Banana"
 *  and getting the whole workspace back would report another project's dirty
 *  files as that one's. */
export function scopeTo(
  projects: WorkspaceProject[],
  name?: string | null,
): WorkspaceProject[] {
  const wanted = (name ?? "").trim().toLowerCase();
  if (!wanted) return projects;
  const found = projects.filter((p) => p.name.toLowerCase() === wanted);
  if (found.length === 0) {
    throw new Error(
      `no project called "${name}" — the projects are: ${projects.map((p) => p.name).join(", ")}`,
    );
  }
  return found;
}

/** A digest as the companion reports it. Deliberately not the whole record:
 *  the transcript is the expensive half and is fetched per-session by
 *  `canopy_agents` when the companion actually wants one. */
export interface AgentReport {
  project: string;
  agent: string | null;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  state: string | null;
  updated: number | null;
}

/** Attribute a session to a project by the directory it is working in.
 *
 *  Longest matching root wins: a worktree under a project root would otherwise
 *  match both the project and, if two projects nest, the wrong one. */
export function projectOf(
  projects: WorkspaceProject[],
  cwd: string | null | undefined,
): string {
  if (!cwd) return "unknown";
  let best: { name: string; len: number } | null = null;
  for (const p of projects) {
    for (const root of p.roots) {
      if ((cwd === root || cwd.startsWith(`${root}/`)) && (!best || root.length > best.len)) {
        best = { name: p.name, len: root.length };
      }
    }
  }
  return best?.name ?? "unknown";
}

// ------------------------------------------------------------- the wrappers

export async function workspaceGit(
  projects: WorkspaceProject[],
  project?: string | null,
): Promise<ReturnType<typeof summarise>> {
  const scope = scopeTo(projects, project);
  const reports: RepoReport[] = [];
  await Promise.all(
    scope.flatMap((p) =>
      p.roots.map(async (root) => {
        // A root that is not a repo, or a checkout that has gone missing, is
        // skipped rather than reported as an error — one bad root must not
        // cost the user the status of everything else.
        const status = await ipc.gitRepoStatus(root).catch(() => null);
        if (status) reports.push(repoReport(p.name, status));
      }),
    ),
  );
  reports.sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path));
  return summarise(reports);
}

export async function workspaceAgents(
  projects: WorkspaceProject[],
  project?: string | null,
): Promise<{ agents: AgentReport[]; note?: string }> {
  const scope = scopeTo(projects, project);
  const roots = scope.flatMap((p) => p.roots);
  const digests = await ipc.sessionDigests(roots).catch(() => []);
  const agents = digests
    .filter((d) => d.agent)
    .map((d) => ({
      project: projectOf(scope, d.cwd),
      agent: d.agent ?? null,
      cwd: d.cwd ?? null,
      branch: d.branch ?? null,
      // The last thing the user asked it, which is what actually says what a
      // session is for — a title would be the launcher's guess.
      title: d.prompts?.[d.prompts.length - 1]?.slice(0, 200) ?? null,
      state: d.state ?? null,
      updated: d.updated ?? null,
    }))
    // Sessions in a directory belonging to none of the scoped projects are
    // somebody else's; reporting them would answer a question that was not
    // asked.
    .filter((a) => a.project !== "unknown")
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return {
    agents,
    note: agents.length
      ? "Your own session is deliberately absent from this list."
      : "No coding sessions are running in these projects.",
  };
}

export async function workspaceSearch(
  query: string,
  limit: number,
): Promise<{ hits: unknown[]; note?: string }> {
  // `allProjects` is the whole point — the palette defaults to the project in
  // front, and the companion is asking precisely because it does not know
  // which project the answer is in.
  const hits = await ipc
    .spotSearch(query, limit, undefined, true)
    .catch(() => []);
  return {
    hits,
    note: hits.length
      ? undefined
      : "Nothing indexed matches. The index covers agent conversations and terminal scrollback — it is not a code search; use grep for that.",
  };
}

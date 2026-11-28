// "All workspaces": every running machine's projects in one strip.
//
// The window has one machine of its own (the primary): its projects are the
// strip's own. Every other running machine is read (its project store and its
// live terminals) and each of its projects lands in exactly one place:
//
//   1. A terminal belongs to the project whose folder holds its cwd ON ITS OWN
//      MACHINE. That needs no repository at all, so a project that is a plain
//      folder of several checkouts still owns its terminals.
//   2. That project is then matched to a primary project: first by identity
//      (a workspace copy names the project it was copied from, placement/
//      identity.ts), and only when identity says nothing, by the repositories
//      the two share. Never by name: one machine can hold two "Coraa"s.
//   3. A project with no match on the primary becomes a project of its own in
//      the strip, shown from its machine; the same project on two other
//      machines is shown once.
//
// Nothing here is saved: the plan is rebuilt from the machines every pass.
import { canonicalProjectId, counterpartOf } from "../placement/identity";
import { projectForTerminalCwd } from "../terminalAttachmentQueue";
import { sameRepoId, type RepoId } from "../machines/repoIdentity";
import type { MachineSession } from "./allWorkspaceTabs";

export interface StoreProject {
  id: string;
  name: string;
  components: { id: string; label: string; path: string }[];
  mirroredFrom?: string;
  mirrorIncomplete?: boolean;
  linkedTo?: { env: string; id: string }[];
}

/** One other machine as read this pass. */
export interface MachineRead {
  /** "local" (this Mac, while the window is on a workspace) or "remote:<id>". */
  env: string;
  /** Short label for its tabs. */
  name: string;
  projects: StoreProject[];
  /** The projects open on that machine. */
  openIds: string[];
  sessions: MachineSession[];
}

/** A live terminal on another machine, and where it comes from. */
export interface ForeignSession {
  env: string;
  machineName: string;
  session: MachineSession;
}

/** A project only other machines have. */
export interface VisitingProject {
  /** Stable across passes: "all:" + the project's identity. */
  id: string;
  name: string;
  /** The machines it is on, by label, in the order read. */
  machines: string[];
  sessions: ForeignSession[];
}

export interface AllPlan {
  /** Primary project id → the other machines' terminals that belong to it. */
  joins: Map<string, ForeignSession[]>;
  visiting: VisitingProject[];
}

export const VISITING_PREFIX = "all:";
export const isVisitingId = (id: string | null | undefined): boolean => !!id && id.startsWith(VISITING_PREFIX);

/** The repositories of one project on one machine (any order, no duplicates needed). */
export type ReposOf = (env: string, project: StoreProject) => Promise<RepoId[]>;

const usable = (p: StoreProject) => !p.mirrorIncomplete && Array.isArray(p.components);

function overlap(a: readonly RepoId[], b: readonly RepoId[]): number {
  let n = 0;
  for (const repo of a) if (b.some((other) => sameRepoId(repo, other))) n++;
  return n;
}

/** Build the plan. `primary` is the window's own project list; `reposOf`
 *  answers repositories and is only asked when identity found nothing. */
export async function planAllWorkspaces(
  primary: readonly StoreProject[],
  others: readonly MachineRead[],
  reposOf: ReposOf,
  primaryEnv = "primary",
): Promise<AllPlan> {
  const joins = new Map<string, ForeignSession[]>();
  const visiting: (VisitingProject & { sources: StoreProject[] })[] = [];
  const primaryProjects = primary.filter(usable);
  let primaryRepos: Map<string, RepoId[]> | null = null;
  const reposOfPrimary = async () => {
    if (primaryRepos) return primaryRepos;
    const entries = await Promise.all(
      primaryProjects.map(async (p) => [p.id, await reposOf(primaryEnv, p).catch(() => [])] as const),
    );
    primaryRepos = new Map(entries);
    return primaryRepos;
  };

  for (const machine of others) {
    const projects = machine.projects.filter(usable);
    // 1. Each terminal to its project on its own machine.
    const byProject = new Map<string, ForeignSession[]>();
    for (const session of machine.sessions) {
      if (!session.cwd) continue;
      const id = projectForTerminalCwd(projects, session.cwd);
      if (!id) continue;
      const list = byProject.get(id) ?? [];
      list.push({ env: machine.env, machineName: machine.name, session });
      byProject.set(id, list);
    }
    // Open projects show even with nothing running; live ones show even when closed.
    const open = new Set(machine.openIds);
    const shown = projects.filter((p) => open.has(p.id) || byProject.has(p.id));
    for (const project of shown) {
      const sessions = byProject.get(project.id) ?? [];
      // 2. The primary's project, by identity, then by shared repositories.
      let target = counterpartOf(project, primaryProjects);
      if (!target) {
        const mine = await reposOf(machine.env, project).catch(() => []);
        if (mine.length) {
          const repos = await reposOfPrimary();
          let best = 0;
          for (const candidate of primaryProjects) {
            const n = overlap(mine, repos.get(candidate.id) ?? []);
            if (n > best) {
              best = n;
              target = candidate;
            }
          }
        }
      }
      if (target) {
        if (sessions.length) joins.set(target.id, [...(joins.get(target.id) ?? []), ...sessions]);
        continue;
      }
      // 3. A project of its own, once however many machines have it.
      const existing = visiting.find((v) => v.sources.some((s) => s === project || counterpartOf(project, [s]) === s));
      if (existing) {
        if (!existing.machines.includes(machine.name)) existing.machines.push(machine.name);
        existing.sessions.push(...sessions);
        existing.sources.push(project);
      } else {
        visiting.push({
          id: `${VISITING_PREFIX}${canonicalProjectId(project)}`,
          name: project.name,
          machines: [machine.name],
          sessions: [...sessions],
          sources: [project],
        });
      }
    }
  }
  return { joins, visiting: visiting.map(({ sources: _sources, ...rest }) => rest) };
}

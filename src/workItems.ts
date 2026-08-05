// Work items: the cluster of tabs that belong to one piece of work, joined on
// edges the app already records — a session's pty, a preview's initiator, a
// PR's provenance edge, a file's place under a workspace cwd. Pure: callers
// resolve the provenance lookup, so everything here is testable synchronously.

import type { SubTab } from "./components/ProjectView/helpers";
import { agentIdForCommand } from "./agentIdentity";

/** What a PR tab needs from its provenance edge to find its cluster. */
export interface PrJoin {
  sessionId: string;
  cwd: string;
}

/** Lookups the caller resolves (from the provenance cache). */
export interface WorkItemJoins {
  prEdge(repo: string, prNumber: number): PrJoin | undefined;
}

interface Cluster {
  ids: string[];
  cwds: Set<string>;
  ptys: Set<number>;
  sessionIds: Set<string>;
}

const normDir = (p: string) => p.replace(/[\\/]+$/, "");

/** Whether `path` sits under `dir` (either separator, never equal). */
const under = (path: string, dir: string) =>
  path.startsWith(dir + "/") || path.startsWith(dir + "\\");

/**
 * Partition tabs into work items. Every tab appears exactly once: as a member
 * of the cluster it joins, or as a singleton group. Ambiguity goes loose — a
 * tab two clusters could claim (a shared checkout's file, a PR whose cwd two
 * sessions share) is never assigned arbitrarily.
 */
export function clusterWorkItems(
  tabs: readonly SubTab[],
  joins: WorkItemJoins,
): string[][] {
  const clusters: Cluster[] = [];
  const claimed = new Set<string>();

  const found = (tab: SubTab, cwd: string | null, pty: number | null | undefined, sessionId?: string) => {
    const c: Cluster = {
      ids: [tab.id],
      cwds: new Set(cwd ? [normDir(cwd)] : []),
      ptys: new Set(pty != null ? [pty] : []),
      sessionIds: new Set(sessionId ? [sessionId] : []),
    };
    clusters.push(c);
    claimed.add(tab.id);
    return c;
  };
  const join = (c: Cluster, tab: SubTab) => {
    c.ids.push(tab.id);
    claimed.add(tab.id);
  };
  const byPty = (pty: number | null | undefined) =>
    pty == null ? undefined : clusters.find((c) => c.ptys.has(pty));
  const bySession = (sessionId: string | undefined) =>
    sessionId ? clusters.find((c) => c.sessionIds.has(sessionId)) : undefined;
  /** The single cluster owning a cwd, or undefined when none or several do. */
  const soleByCwd = (cwd: string) => {
    const owners = clusters.filter((c) => c.cwds.has(normDir(cwd)));
    return owners.length === 1 ? owners[0] : undefined;
  };

  // Founders first: live agent sessions, then workspace tabs (which join their
  // session by pty when it is open, and found their own cluster when not).
  for (const tab of tabs) {
    if (tab.type !== "terminal" || tab.run) continue;
    if (!agentIdForCommand(tab.command)) continue;
    const c = found(tab, tab.cwd, tab.ptyId);
    if (tab.attachId != null) c.ptys.add(tab.attachId);
  }
  for (const tab of tabs) {
    if (tab.type !== "agent") continue;
    const c = byPty(tab.ptyId) ?? bySession(tab.sessionId);
    if (c) {
      join(c, tab);
      c.cwds.add(normDir(tab.cwd));
      if (tab.sessionId) c.sessionIds.add(tab.sessionId);
    } else {
      found(tab, tab.cwd, tab.ptyId, tab.sessionId);
    }
  }

  // Members: each joins by its strongest edge, or stays loose.
  for (const tab of tabs) {
    if (claimed.has(tab.id)) continue;
    switch (tab.type) {
      case "preview": {
        const c = byPty(tab.initiatorPtyId) ?? byPty(tab.recipientPtyId);
        if (c) join(c, tab);
        break;
      }
      case "pr": {
        const edge = joins.prEdge(tab.repo, tab.pr.number);
        if (!edge) break;
        const c = bySession(edge.sessionId) ?? soleByCwd(edge.cwd);
        if (c) join(c, tab);
        break;
      }
      case "file": {
        // Deepest owning cwd wins; a cwd shared by two clusters claims nothing.
        let best: { c: Cluster; depth: number } | undefined;
        let tied = false;
        for (const c of clusters) {
          for (const cwd of c.cwds) {
            if (!under(tab.file.path, cwd)) continue;
            if (!best || cwd.length > best.depth) {
              best = { c, depth: cwd.length };
              tied = false;
            } else if (cwd.length === best.depth && c !== best.c) {
              tied = true;
            }
          }
        }
        if (best && !tied) join(best.c, tab);
        break;
      }
      default:
        break;
    }
  }

  const groups = clusters.map((c) => c.ids);
  for (const tab of tabs) {
    if (!claimed.has(tab.id)) groups.push([tab.id]);
  }
  return groups;
}

/**
 * Freeze the grouped order a held switch gesture walks in Work items mode.
 * Groups are ordered by their best-ranked member (active tab first, then the
 * recency list, then strip order — the same ranking recent mode uses), and
 * members inside a group by the same rank, so index 0 is where picking the
 * group lands. Closed tabs are dropped; empty groups vanish.
 */
export function workItemSnapshot(
  groups: readonly (readonly string[])[],
  openIds: readonly string[],
  activeId: string | null,
  recent: readonly string[],
): string[][] {
  const open = new Set(openIds);
  const rank = new Map<string, number>();
  let n = 0;
  const note = (id: string | null) => {
    if (id && open.has(id) && !rank.has(id)) rank.set(id, n++);
  };
  note(activeId);
  recent.forEach(note);
  openIds.forEach(note);

  const seen = new Set<string>();
  const out: { ids: string[]; best: number }[] = [];
  for (const group of groups) {
    const ids = group
      .filter((id) => open.has(id) && !seen.has(id))
      .sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
    if (!ids.length) continue;
    ids.forEach((id) => seen.add(id));
    out.push({ ids, best: rank.get(ids[0]) ?? Infinity });
  }
  out.sort((a, b) => a.best - b.best);
  return out.map((g) => g.ids);
}

// The agent hierarchy over terminal tabs. A child an agent delegated is an
// ordinary terminal tab whose spawnedTask.parentPtyId names the parent's PTY.
// This links them into a forest; the CLI itself is untouched.
import { agentIdForCommand } from "./agentIdentity";
import { tabName } from "./tabName";
import type { TermSubTab } from "./components/ProjectView/helpers";

export interface AgentNode {
  tabId: string;
  ptyId: number | null;
  title: string;
  depth: number;
  parentTabId: string | null;
  children: AgentNode[];
  exited: boolean;
}

export const isAgentTab = (t: TermSubTab): boolean =>
  !t.run && !t.micro && (!!t.spawnedTask || !!agentIdForCommand(t.command));

/** Tabs linked by parentPtyId. Orphans (parent closed) become roots; a cycle
 *  is cut where it closes. `depth` is the nesting level in the forest. */
export function buildAgentHierarchy(tabs: readonly TermSubTab[]): AgentNode[] {
  const agents = tabs.filter(isAgentTab);
  const byPty = new Map<number, TermSubTab>();
  for (const t of agents) if (t.ptyId != null) byPty.set(t.ptyId, t);
  const parentOf = (t: TermSubTab): TermSubTab | null => {
    const p = t.spawnedTask ? byPty.get(t.spawnedTask.parentPtyId) : undefined;
    return p && p.id !== t.id ? p : null;
  };
  // Cut cycles: a tab whose ancestor chain returns to itself becomes a root.
  const parent = new Map<string, TermSubTab | null>();
  for (const t of agents) {
    const seen = new Set([t.id]);
    let p = parentOf(t);
    let cyclic = false;
    while (p) {
      if (seen.has(p.id)) {
        cyclic = true;
        break;
      }
      seen.add(p.id);
      p = parentOf(p);
    }
    parent.set(t.id, cyclic ? null : parentOf(t));
  }
  const nodes = new Map<string, AgentNode>();
  for (const t of agents) {
    nodes.set(t.id, {
      tabId: t.id,
      ptyId: t.ptyId,
      title: tabName(t, { agent: true }),
      depth: 0,
      parentTabId: parent.get(t.id)?.id ?? null,
      children: [],
      exited: !!t.exited,
    });
  }
  const roots: AgentNode[] = [];
  for (const t of agents) {
    const n = nodes.get(t.id)!;
    const p = n.parentTabId ? nodes.get(n.parentTabId) : undefined;
    if (p) p.children.push(n);
    else roots.push(n);
  }
  const setDepth = (n: AgentNode, d: number) => {
    n.depth = d;
    for (const c of n.children) setDepth(c, d + 1);
  };
  for (const r of roots) setDepth(r, 0);
  return roots;
}

export function flattenAgents(roots: readonly AgentNode[]): AgentNode[] {
  return roots.flatMap((r) => [r, ...flattenAgents(r.children)]);
}

/** The tree containing `tabId`, or null when it is not an agent tab. */
export function treeForTab(roots: readonly AgentNode[], tabId: string): AgentNode | null {
  return roots.find((r) => flattenAgents([r]).some((n) => n.tabId === tabId)) ?? null;
}

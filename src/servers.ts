// The execution surface: every component that has something to run, and the
// live state of each of those runs. The files panel already lists run commands,
// but buried under the tree of whichever component you happened to expand —
// which is the wrong shape for "what is running, and where". This module does
// the join once, so the Servers panel only renders.
//
// Two sources are merged: the commands configured on a component (the project
// record) and the run tabs that actually exist. A run tab with no configured
// command is not dropped — an agent's canopy_start_server, or a command since
// renamed in project settings, is still a process you need to be able to stop.
import { basename } from "./paths";
import type { TermSubTab } from "./components/ProjectView/helpers";
import type { Component, RunCommand } from "./projects";
import type { AgentRef } from "./workspaces";

export type ServerState = "running" | "stopped" | "done" | "failed";

export interface ServerEntry {
  /** Stable within its group — the key React rows and the caller's start path. */
  key: string;
  name: string;
  command: string;
  state: ServerState;
  /** The run tab backing this entry; null when it has never been started. */
  tabId: string | null;
  componentId: string | null;
  runCommandId: string | null;
  ptyId: number | null;
  exitCode: number | null;
  /** TCP ports this run is listening on, from the stats poller. */
  ports: number[];
  /** Running without a matching configured command — started by an agent, or
   *  left over from a command that has since been renamed. Not startable from
   *  the panel once it stops, so the row goes away with it. */
  adhoc: boolean;
}

export interface ServerGroup {
  label: string;
  path: string;
  entries: ServerEntry[];
  /** The same component, checked out in a workspace of its own. Nested rather
   *  than listed alongside: a component and a component-on-a-branch are one
   *  thing seen twice, and giving each its own top-level group turned four
   *  components with four workspaces into sixteen headings you had to read
   *  past to find the one server that was actually up. */
  workspaces: WorkspaceRuns[];
  /** Entries in the `running` state, here and in every workspace below — the
   *  group header's live count. */
  running: number;
}

/** One workspace's copy of a component: what can run there, what is running,
 *  and who is in it. */
export interface WorkspaceRuns {
  /** The branch. This is the name — never the path, never the component again. */
  label: string;
  /** The component's directory inside that workspace, which is where its runs
   *  are started and what their cwd will be. */
  path: string;
  /** The port its runs are given, so you can tell two of them apart. */
  port: number | null;
  /** Agent sessions working in here — the answer to "who is on what", and who
   *  a request for this workspace's server would be sent to. */
  agents: AgentRef[];
  entries: ServerEntry[];
  running: number;
}

/** A workspace's copy of one component, as the caller knows it. */
export interface ComponentWorkspace {
  /** Branch name, for the row. */
  label: string;
  /** The component directory inside the workspace. */
  path: string;
  port: number | null;
  agents: AgentRef[];
}

export interface ServerComponent extends Component {
  /** This component as it exists in each workspace. Empty for a project with
   *  no workspaces, which is the shape this panel had before them. */
  workspaces?: ComponentWorkspace[];
}

const stateOf = (tab: TermSubTab | undefined): ServerState => {
  if (!tab) return "stopped";
  // A tab that outlived its process reports how it ended; one still spawning
  // (ptyId not yet assigned) counts as running, or every start would flash
  // "stopped" for a frame.
  if (!tab.exited) return "running";
  return tab.exitCode === 0 ? "done" : "failed";
};

const under = (cwd: string, root: string) =>
  cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);

/** The component a terminal belongs to: the longest path that contains its cwd.
 *  Longest wins so a component nested inside another claims its own runs. */
function componentFor(cwd: string, components: ServerComponent[]): ServerComponent | null {
  let best: ServerComponent | null = null;
  for (const c of components) {
    if (cwd !== c.path && !cwd.startsWith(`${c.path}/`)) continue;
    if (!best || c.path.length > best.path.length) best = c;
  }
  return best;
}



/**
 * Components that have servers, with each server's live state. Components with
 * nothing to run are left out entirely — that omission is the panel's whole
 * point, and the files tree is still there for everything else.
 *
 * Declaration order is preserved (components as configured, then their commands
 * as configured, then ad-hoc runs). Nothing sorts by run state: rows that
 * reorder themselves when a server goes up or down are rows you cannot aim at.
 * The one ordering that isn't declaration order is workspaces, which lead with
 * the ones an agent is in — see below for why that doesn't have the same
 * problem.
 */
export function groupServers(
  components: ServerComponent[],
  runTabs: TermSubTab[],
  portsOf: (ptyId: number | null) => number[],
): ServerGroup[] {
  // Tabs claimed by a configured command, so the ad-hoc pass doesn't list them
  // a second time.
  const claimed = new Set<string>();
  const groups = new Map<string, ServerGroup>();

  const group = (label: string, path: string): ServerGroup => {
    let g = groups.get(path);
    if (!g) {
      g = { label, path, entries: [], workspaces: [], running: 0 };
      groups.set(path, g);
    }
    return g;
  };

  /** One command as it stands in one directory. The same join for the main
   *  checkout and for a workspace — the only thing that differs is where. */
  const entryFor = (
    componentId: string,
    cmd: RunCommand,
    dir: string,
  ): ServerEntry => {
    const tab = runTabs.find(
      (t) =>
        !claimed.has(t.id) &&
        t.cwd === dir &&
        (t.runCommandId
          ? t.componentId === componentId && t.runCommandId === cmd.id
          : t.command === cmd.command),
    );
    if (tab) claimed.add(tab.id);
    return {
      key: cmd.id,
      name: cmd.name || cmd.command,
      command: cmd.command,
      state: stateOf(tab),
      tabId: tab?.id ?? null,
      componentId,
      runCommandId: cmd.id,
      ptyId: tab?.ptyId ?? null,
      exitCode: tab?.exitCode ?? null,
      ports: portsOf(tab?.ptyId ?? null),
      adhoc: false,
    };
  };

  for (const c of components) {
    const commands = (c.commands ?? []).filter((cmd) => cmd.command.trim());
    if (!commands.length) continue;
    const g = group(c.label, c.path);
    for (const cmd of commands) g.entries.push(entryFor(c.id, cmd, c.path));

    // Workspaces are matched before the ad-hoc pass runs, so a dev server
    // started on a branch lands under that branch rather than becoming an
    // orphan group named after a directory.
    for (const w of c.workspaces ?? []) {
      const entries = commands.map((cmd) => entryFor(c.id, cmd, w.path));
      g.workspaces.push({
        label: w.label,
        path: w.path,
        port: w.port,
        agents: w.agents,
        entries,
        running: entries.filter((e) => e.state === "running").length,
      });
    }
  }

  for (const t of runTabs) {
    if (claimed.has(t.id)) continue;
    // A finished ad-hoc run has nothing left to manage and no way to be
    // restarted from here — its tab is still in the RUNS rail if you want it.
    if (t.exited) continue;
    const adhoc: ServerEntry = {
      key: `adhoc ${t.id}`,
      name: t.customTitle ?? t.title,
      command: t.command ?? "",
      state: stateOf(t),
      tabId: t.id,
      componentId: null,
      runCommandId: null,
      ptyId: t.ptyId,
      exitCode: t.exitCode ?? null,
      ports: portsOf(t.ptyId),
      adhoc: true,
    };
    // An unconfigured run inside a workspace belongs to that workspace's row.
    // Longest match wins, so a component nested in another claims its own.
    let bestGroup: ServerGroup | null = null;
    let bestWs: WorkspaceRuns | null = null;
    let bestLen = -1;
    for (const g of groups.values()) {
      for (const w of g.workspaces) {
        if (!under(t.cwd, w.path) || w.path.length <= bestLen) continue;
        bestGroup = g;
        bestWs = w;
        bestLen = w.path.length;
      }
    }
    if (bestWs && bestGroup) {
      bestWs.entries.push(adhoc);
      continue;
    }
    const c = componentFor(t.cwd, components);
    group(c?.label ?? basename(t.cwd), c?.path ?? t.cwd).entries.push(adhoc);
  }

  const out = [...groups.values()];
  for (const g of out) {
    for (const w of g.workspaces)
      w.running = w.entries.filter((e) => e.state === "running").length;
    // Workspaces somebody is actually working in come first. Twenty branches
    // with a checkout is the normal shape of this list, and the four with a
    // CLI in them are the only ones you are ever looking for — the rest are
    // folders that happen to exist.
    //
    // Binary on purpose, and not by what the agent is doing: an occupied
    // workspace stays put for as long as the session lasts, where ranking
    // working above idle would shuffle the list on every turn. Sort is stable,
    // so within each half the order is still git's, not a state's.
    g.workspaces.sort((a, b) => (b.agents.length ? 1 : 0) - (a.agents.length ? 1 : 0));
    // The header counts everything under it, workspaces included: a collapsed
    // group whose only live server is on a branch must not read as idle.
    g.running =
      g.entries.filter((e) => e.state === "running").length +
      g.workspaces.reduce((n, w) => n + w.running, 0);
  }
  return out;
}

export const runningCount = (groups: ServerGroup[]) =>
  groups.reduce((n, g) => n + g.running, 0);

export const serverUrl = (port: number) => `http://localhost:${port}`;

/** Start of the OS's dynamic/ephemeral range. A listener up here was assigned,
 *  not chosen: Tauri's dev IPC socket, a bundler's inspector, an HMR helper. */
const EPHEMERAL_PORT = 49152;

/** Room for a dev server and its API, and no more — the panel goes down to
 *  200px wide. */
const PORTS_ON_ROW = 2;

/**
 * Split a run's ports into the ones worth putting on its row and the rest.
 *
 * `pnpm tauri dev` listens on three: the Vite port you asked for and two the OS
 * handed out. All three on a row of a narrow panel left no space for the run's
 * own name, and two of them are not pages anyone would open — so the assigned
 * ones are demoted behind a `+N`, not dropped. "Which port is my dev server on"
 * and "what else did this process open" are different questions, and only the
 * first belongs on the row.
 *
 * A run whose *only* ports are ephemeral still shows them: demoting every port
 * would hide the answer rather than rank it.
 */
export function splitPorts(ports: number[]): { shown: number[]; rest: number[] } {
  const all = [...new Set(ports)].sort((a, b) => a - b);
  const chosen = all.filter((p) => p < EPHEMERAL_PORT);
  const shown = (chosen.length ? chosen : all).slice(0, PORTS_ON_ROW);
  return { shown, rest: all.filter((p) => !shown.includes(p)) };
}

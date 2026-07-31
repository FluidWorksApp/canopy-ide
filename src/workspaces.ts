import { agentLife, type LifeState } from "../shared/agentLife";
// One list of the things you can be working on.
//
// Git has two lists — branches and worktrees — and the Git panel used to show
// both, which meant a branch that had a workspace appeared twice and neither
// row told you the whole story. But they are not two lists to a person: a
// branch either lives in your own checkout or it has a folder of its own, and
// the interesting question is never "which" but "what is going on in it" — is
// it dirty, is a server up, is an agent in there.
//
// So this module does the join once and hands back rows. The Git panel renders
// them; nothing else needs to know that "workspace" is spelled `git worktree`.
import type * as ipc from "./ipc";
import { getSettings, updateSettings } from "./settings";

/** One thing you can be working on. A branch, wherever it currently lives. */
export interface WorkspaceRow {
  branch: string;
  /** The folder backing it, or null for a branch with no checkout anywhere
   *  (on the remote, or local but not checked out). */
  path: string | null;
  /** Its folder is the repo's own checkout rather than one of its own. */
  main: boolean;
  /** The branch HEAD is on in the repo's own checkout. */
  current: boolean;
  /** Files, search and new terminals are coming from here right now. */
  active: boolean;
  /** On the remote, with no copy here yet. */
  remoteOnly: boolean;
  /** Local, never pushed. */
  unpushed: boolean;
  /** Uncommitted files in its folder. */
  dirty: number;
  /** The port this workspace's servers are leased, once it has a folder. */
  port: number | null;
  /** Servers running in its folder, and how many. */
  running: number;
  /** Agent sessions with their cwd inside it. */
  agents: number;
  /** Who those agents are, when the caller can say. Identities rather than the
   *  count above: "claude, waiting on you" is the thing worth putting on a
   *  branch, and it is clickable through to that terminal. Empty when no
   *  resolver was given, and then the count is all the row has. */
  agentList: AgentRef[];
  subject: string;
  /** Its folder is gone but git still claims it — the one broken state left
   *  visible, because it blocks the branch until it's cleared. */
  missing: boolean;
  locked: boolean;
  detached: boolean;
}

/** Everything the join needs that isn't git's. Passed in rather than fetched so
 *  this stays a pure function the tests can drive — in particular the leases,
 *  which are allocated once when the list loads and never during a render. */
export interface WorkspaceContext {
  repo: string;
  activePath: string | null;
  /** cwd of every live server run, in any workspace. */
  serverCwds: string[];
  /** cwd of every live agent session. */
  agentCwds: string[];
  /** The agents in a folder, by name and state — `agentsIn` over the digest
   *  store, which the caller owns because it is the thing that polls it. */
  agentsAt?: (dir: string) => AgentRef[];
  /** Workspace folder -> the port its runs are given. */
  ports: Record<string, number>;
}

const under = (cwd: string, root: string) =>
  cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);

const countUnder = (cwds: string[], root: string | null) =>
  root ? cwds.filter((c) => under(c, root)).length : 0;

/**
 * Branches and worktrees, joined into the one list.
 *
 * Ordering is deliberate and does not react to state: what's in front of you
 * first (active, then current), then everything with a folder of its own, then
 * plain local branches, then what's only on GitHub. Nothing sorts by dirty
 * count or by whether a server is up — rows that rearrange themselves while a
 * build finishes are rows you cannot aim at.
 */
export function workspaceRows(
  branches: ipc.BranchInfo[],
  worktrees: ipc.WorktreeInfo[],
  ctx: WorkspaceContext,
): WorkspaceRow[] {
  const byBranch = new Map<string, ipc.WorktreeInfo>();
  for (const w of worktrees) {
    if (w.branch && !byBranch.has(w.branch)) byBranch.set(w.branch, w);
  }
  const main = worktrees.find((w) => w.is_main) ?? null;

  const rows: WorkspaceRow[] = branches.map((b) => {
    const wt = byBranch.get(b.name) ?? null;
    // A branch checked out in the repo's own checkout has no *separate*
    // folder — its folder is the repo. Both cases resolve to a path, which is
    // what the port lease and the counts below key on.
    const path = wt?.path ?? (b.current ? (main?.path ?? ctx.repo) : null);
    const isMain = wt ? wt.is_main : b.current;
    return {
      branch: b.name,
      path,
      main: isMain,
      current: b.current,
      active: path != null && path === ctx.activePath,
      remoteOnly: b.remote_only,
      unpushed: !b.synced && !b.remote_only,
      dirty: wt?.dirty ?? 0,
      port: path ? (ctx.ports[path] ?? null) : null,
      running: countUnder(ctx.serverCwds, path),
      agents: countUnder(ctx.agentCwds, path),
      agentList: path ? (ctx.agentsAt?.(path) ?? []) : [],
      subject: b.subject,
      missing: wt?.prunable != null,
      locked: wt?.locked != null,
      detached: wt?.detached ?? false,
    };
  });

  // Worktrees git knows about that no branch row covers: a detached workspace
  // (a PR checked out at its head), or one whose folder is gone. They are the
  // rows most in need of being visible — a missing workspace silently holds a
  // branch name hostage — so they are never dropped for not being a branch.
  for (const w of worktrees) {
    if (w.bare) continue;
    if (w.branch && branches.some((b) => b.name === w.branch)) continue;
    rows.push({
      branch: w.branch ?? (w.detached ? `snapshot @ ${w.head.slice(0, 7)}` : w.name),
      path: w.path,
      main: w.is_main,
      current: false,
      active: w.path === ctx.activePath,
      remoteOnly: false,
      unpushed: false,
      dirty: w.dirty,
      port: ctx.ports[w.path] ?? null,
      running: countUnder(ctx.serverCwds, w.path),
      agents: countUnder(ctx.agentCwds, w.path),
      agentList: ctx.agentsAt?.(w.path) ?? [],
      subject: "",
      missing: w.prunable != null,
      locked: w.locked != null,
      detached: w.detached,
    });
  }

  const rank = (r: WorkspaceRow) =>
    r.active ? 0 : r.current ? 1 : r.missing ? 2 : r.path ? 3 : r.remoteOnly ? 5 : 4;
  return rows.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// Port leases.
//
// Two checkouts of the same repo both run `npm run dev`, both read the same
// hard-coded port out of the same vite config, and the second one either dies
// or silently picks another number that nothing else in Canopy knows about.
// That is the whole reason parallel workspaces didn't work in practice.
//
// A lease fixes the number *per workspace folder* instead: stable across
// restarts (so a bookmark keeps working), allocated lowest-free (so the numbers
// stay small and memorable), and handed to the run as env — never written into
// the project's files, which are shared with everyone else on the repo.

/** Offsets are added to this. The main checkout keeps it, so nothing about the
 *  way you already work changes. */
export const basePort = () => getSettings().workspaceBasePort ?? 5173;

/** How many workspaces can hold a lease at once. Past this the run just starts
 *  without one and takes the project's own port, which is the old behaviour. */
const MAX_LEASES = 32;

type Leases = Record<string, Record<string, number>>;

const allLeases = (): Leases => getSettings().workspacePorts ?? {};

/**
 * This workspace's port, allocating one the first time it is asked for.
 *
 * Offset 0 belongs to the repo's own checkout and is never handed out, so a
 * workspace can't take the port the main checkout has always used.
 */
export function leasedPort(repo: string, path: string): number | null {
  const leases = allLeases();
  const mine = leases[repo] ?? {};
  const held = mine[path];
  if (held != null) return basePort() + held;

  const taken = new Set(Object.values(mine));
  let offset = 1;
  while (taken.has(offset) && offset <= MAX_LEASES) offset++;
  if (offset > MAX_LEASES) return null;

  updateSettings({ workspacePorts: { ...leases, [repo]: { ...mine, [path]: offset } } });
  return basePort() + offset;
}

/**
 * Every workspace's port in one map, allocating leases for any that don't have
 * one yet. This is the write; `workspaceRows` and `portForCwd` only read.
 *
 * Called when the worktree list loads, never from a render — allocating a
 * lease writes localStorage, and doing that while rendering would give you a
 * different map on every pass.
 */
export function ensureLeases(
  repo: string,
  worktrees: { path: string; is_main: boolean }[],
): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const w of worktrees) {
    const port = w.is_main ? basePort() : leasedPort(repo, w.path);
    if (port != null) ports[w.path] = port;
  }
  return ports;
}

/** Give a removed workspace's number back, so a repo worked on for a year
 *  doesn't drift into the 5200s. */
export function releaseLease(repo: string, path: string): void {
  const leases = allLeases();
  const mine = leases[repo];
  if (!mine || mine[path] == null) return;
  const next = { ...mine };
  delete next[path];
  updateSettings({ workspacePorts: { ...leases, [repo]: next } });
}

/**
 * The lease as environment for a run started in this workspace.
 *
 * Spelled every way the common dev servers read it, because there is no shared
 * convention and asking the user which one their framework wants is asking them
 * to know the thing this feature exists to hide. They are all just a number;
 * a server that ignores all of them is no worse off than before.
 */
export function portEnv(port: number | null): [string, string][] {
  if (port == null) return [];
  const p = String(port);
  return [
    ["PORT", p],
    ["VITE_PORT", p],
    ["NEXT_PUBLIC_PORT", p],
    ["CANOPY_WORKSPACE_PORT", p],
  ];
}

/** The port a run in `cwd` should get: the lease of the workspace containing
 *  it, or none when it's the repo's own checkout. Longest match wins so a
 *  workspace nested under another claims its own runs. */
export function portForCwd(
  repo: string,
  cwd: string,
  worktrees: { path: string; is_main: boolean }[],
): number | null {
  let best: { path: string; is_main: boolean } | null = null;
  for (const w of worktrees) {
    if (!under(cwd, w.path)) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  if (!best || best.is_main) return null;
  return leasedPort(repo, best.path);
}

/**
 * The same answer, from a bare path and nothing else.
 *
 * Every place that spawns a terminal needs this and almost none of them know
 * which repo they are in, let alone hold a worktree listing — and making them
 * fetch one would put a `git worktree list` in front of opening a shell. The
 * lease store already records every workspace folder we have leased a port to,
 * so it can answer this on its own, with no IPC and no git.
 *
 * A stale entry (a workspace since removed) can't produce a wrong answer here:
 * the path it names no longer contains anything.
 */
export function portForPath(cwd: string): number | null {
  const leases = allLeases();
  const base = basePort();
  let best: { path: string; offset: number } | null = null;
  for (const mine of Object.values(leases)) {
    for (const [path, offset] of Object.entries(mine)) {
      if (!under(cwd, path)) continue;
      if (!best || path.length > best.path.length) best = { path, offset };
    }
  }
  return best ? base + best.offset : null;
}

// ---------------------------------------------------------------------------
// Who is working where.
//
// A run, a workspace and an agent were three facts Canopy held separately: the
// Servers panel knew a dev server was up in a directory, the Git panel knew a
// branch had a folder, and the Agents panel knew a session existed — and
// nothing joined them. So "which agent is running this server, and on what
// branch" had no answer, which is the question you have to be able to ask
// before one agent can hand a server to another.
//
// The join is deterministic, not a guess: a digest carries `surface` (the PTY
// id it was spawned under) and `instance` (the app launch), which is the same
// pairing the Agents panel uses. Matching on titles or newest-file-by-mtime
// would attach a run to someone else's conversation.

/** An agent session, as the surfaces that aren't the Agents panel need it. */
export interface AgentRef {
  sessionId: string;
  /** The terminal it runs in — how it is messaged, and how its liveness is
   *  answered. Null for a session with no Canopy terminal behind it. */
  ptyId: number | null;
  /** The CLI, e.g. "claude". Not the branch and not the tab title. */
  name: string;
  state: LifeState;
}

/** Live agent sessions whose working directory is inside `dir`.
 *
 *  Ended sessions are dropped: they are still in the digest store (it doubles
 *  as the crash-restore record) but they are not someone you can hand a server
 *  to. Sessions from another app launch are dropped too — a PTY id is only
 *  unique within one launch, and a stale one names a terminal that now belongs
 *  to something else. */
export function agentsIn(
  dir: string,
  digests: {
    session_id: string;
    cwd?: string;
    launch_cwd?: string;
    agent?: string;
    surface?: string;
    instance?: string;
    state?: string;
    state_via?: string;
    updated?: number;
  }[],
  thisInstance: string | null,
  now: number = Date.now() / 1000,
): AgentRef[] {
  const seen = new Set<string>();
  const out: AgentRef[] = [];
  for (const d of digests) {
    if (thisInstance && d.instance && d.instance !== thisInstance) continue;
    // `launch_cwd` as well as `cwd`: an agent that cd'd deeper is still working
    // in the workspace it was started in, and an agent that cd'd *out* is not
    // something we want to lose track of either.
    const where = d.cwd ?? d.launch_cwd;
    if (!where || !(under(where, dir) || (d.launch_cwd && under(d.launch_cwd, dir))))
      continue;
    if (seen.has(d.session_id)) continue;
    // The one ladder. Ended sessions are dropped here rather than by matching
    // the recorded string: five of seven CLIs cannot write `ended` at all, so
    // the string test only ever caught two of them.
    const life = agentLife({ digest: d as never, now });
    if (life.state === "ended") continue;
    seen.add(d.session_id);
    const pty = d.surface ? Number(d.surface) : NaN;
    out.push({
      sessionId: d.session_id,
      ptyId: Number.isFinite(pty) ? pty : null,
      name: d.agent ?? "agent",
      // The one ladder. This used to whitelist three strings and map everything
      // else to "unknown", which quietly made a stale `working` indistinguishable
      // from a fresh one.
      state: life.state,
    });
  }
  return out;
}

/** The one that matters on a one-line row: whoever needs you, else whoever is
 *  mid-turn, else any of them.
 *
 *  Blocked before working, which is the other way round from how this used to
 *  read — and the old order was how a crashed agent still claiming "working"
 *  hid a genuinely blocked one behind it on the same row. It also disagreed
 *  with every other list in the app, all of which sort what needs you first. */
export function principalAgent(agents: AgentRef[]): AgentRef | null {
  return (
    agents.find((a) => a.state === "waiting") ??
    agents.find((a) => a.state === "working") ??
    agents[0] ??
    null
  );
}

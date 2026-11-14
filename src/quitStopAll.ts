// "Quit and Stop All": with the terminal host on, Quit leaves terminals and
// agents running for the next launch to adopt. This is the quit that stops
// them. On every platform, host on or off, it asks first whenever an agent
// would be stopped (one in a tab, or one left in the host that no tab holds,
// or a session whose details cannot be read, which may be one); otherwise it
// stops everything and quits at once. With the host off,
// Quit already stops everything, so the dialog has no "Quit only".

// The dialog is components/QuitStopAllDialog.tsx.

import { agentIdForCommand, identifyAgent } from "./agentIdentity";
import { invokeDesktop } from "./host";
import type { SessionStats } from "./ipc";

export interface TerminalCounts {
  agents: number;
  shells: number;
  /** Sessions Stop All would stop whose details are unreadable, so they
   *  cannot be called agents or shells. */
  unknown?: number;
}

/** A host session Stop All would stop that no tab of this launch holds
 *  (`pty_stop_all_preview`). */
export interface StopTarget {
  command: string | null;
  unreadable: boolean;
}

/** `pty_host_notice`: what the user should know about the terminal host. */
export interface HostNotice {
  /** The host is on but this launch's terminals run in-process. */
  fell_back: boolean;
  left_behind: { terminal: number | null; reason: string }[];
  /** How long a hosted terminal outlives a plain Quit. 0: not hosted. */
  linger_secs: number;
}

/** What the dialog is opened with. `error` is set when stopping already
 *  failed (no agents running, so no dialog had been shown yet). */
export interface QuitStopAllAsk {
  counts: TerminalCounts;
  /** Terminals are hosted, so a plain Quit would leave them running. */
  hostOn: boolean;
  /** Of `counts`, how many are left in the host by an earlier launch (no tab
   *  holds them); the dialog says so. */
  background?: number;
  /** How long a plain Quit leaves terminals running. */
  lingerSecs?: number;
  error?: string;
}

/** Terminals with an agent in the foreground, and the rest. The same split as
 *  `agentSessions` / `termSessions` in agentSessions.ts. */
export function countTerminals(stats: Pick<SessionStats, "agent_hint">[]): TerminalCounts {
  const agents = stats.filter((s) => identifyAgent(s.agent_hint) !== null).length;
  return { agents, shells: stats.length - agents };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Stop 3 running agents?"; with none (the dialog only shows then to report
 *  a failed stop) "Stop all terminals?". */
export const stopAllTitle = (agents: number) =>
  agents > 0 ? `Stop ${plural(agents, "running agent")}?` : "Stop all terminals?";

/** What Stop All stops beyond this launch's tabs, counted the same way. */
export function countStopTargets(targets: StopTarget[]): TerminalCounts {
  const unknown = targets.filter((t) => t.unreadable).length;
  const agents = targets.filter((t) => !t.unreadable && agentIdForCommand(t.command) !== null).length;
  return { agents, shells: targets.length - agents - unknown, unknown };
}

/** "3 agents · 2 shells · 1 unidentified". */
export const stopAllMeta = ({ agents, shells, unknown = 0 }: TerminalCounts) =>
  [
    ...(agents > 0 || shells + unknown === 0 ? [plural(agents, "agent")] : []),
    ...(shells > 0 ? [plural(shells, "shell")] : []),
    ...(unknown > 0 ? [`${unknown} unidentified`] : []),
  ].join(" · ");

/** "2 hours", "90 minutes". */
export function lingerText(secs: number): string {
  if (secs >= 3600 && secs % 3600 === 0) return plural(secs / 3600, "hour");
  return plural(Math.max(1, Math.round(secs / 60)), "minute");
}

/** The one-line notices for the host, as [title, body, dedupe key]. */
export function hostNoticeMessages(notice: HostNotice): [string, string, string][] {
  const out: [string, string, string][] = [];
  if (notice.fell_back) {
    out.push([
      "Terminals run inside Canopy this time",
      "The terminal host could not be used, so these terminals end when you quit.",
      "pty-host-fell-back",
    ]);
  }
  const n = notice.left_behind.length;
  if (n > 0) {
    out.push([
      `${plural(n, "earlier terminal")} could not be restored`,
      "Still running in the background. Quit and Stop All stops them.",
      "pty-host-left-behind",
    ]);
  }
  return out;
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Quit the app; `stopAll` stops hosted terminals too, and rejects (without
 *  quitting) when the terminal host could not be asked to. Always the
 *  desktop's own command: quitting is about this computer, never a workspace. */
export const quitApp = (stopAll: boolean) => invokeDesktop<void>("app_quit", { stopAll });

const readHostOn = () => invokeDesktop<boolean>("pty_host_enabled");
const readForeign = () => invokeDesktop<StopTarget[]>("pty_stop_all_preview");
export const readHostNotice = () => invokeDesktop<HostNotice>("pty_host_notice");
const readLinger = () => readHostNotice().then((n) => n.linger_secs);

/** The menu item. Reads this computer's terminals (not ipc.ptyStats, which
 *  adds terminals on other machines that quitting never stops) and what else
 *  Stop All would stop in the host. An agent among them, or a session that
 *  cannot be identified: hand the counts to `ask`. None: stop all and quit
 *  now, and if that fails, open the dialog with the error. A failed read of
 *  the terminals does nothing rather than stop blind; a failed read of the
 *  host's sessions goes on to the stop, which reports that same failure. */
export async function startQuitStopAll(deps: {
  stats?: () => Promise<Pick<SessionStats, "agent_hint">[]>;
  foreign?: () => Promise<StopTarget[]>;
  lingerSecs?: () => Promise<number>;
  hostOn?: () => Promise<boolean>;
  quit?: (stopAll: boolean) => Promise<unknown>;
  ask: (ask: QuitStopAllAsk) => void;
}): Promise<void> {
  const read = deps.stats ?? (() => invokeDesktop<SessionStats[]>("pty_stats"));
  const quit = deps.quit ?? quitApp;
  let local: TerminalCounts;
  try {
    local = countTerminals(await read());
  } catch (error) {
    console.warn("Quit and Stop All: could not read terminals", error);
    return;
  }
  const other = countStopTargets(
    await (deps.foreign ?? readForeign)().catch((error) => {
      console.warn("Quit and Stop All: could not read the host's sessions", error);
      return [] as StopTarget[];
    }),
  );
  const counts: TerminalCounts = {
    agents: local.agents + other.agents,
    shells: local.shells + other.shells,
    ...(other.unknown ? { unknown: other.unknown } : {}),
  };
  const background = other.agents + other.shells + (other.unknown ?? 0);
  const lingerSecs = await (deps.lingerSecs ?? readLinger)().catch(() => 0);
  // Unknown counts as on: then "Quit only" is offered, and with the host
  // really off it still stops everything, which is all it would cost.
  const hostOn = await (deps.hostOn ?? readHostOn)().catch(() => true);
  const detail = { counts, hostOn, background, lingerSecs };
  if (counts.agents > 0 || (counts.unknown ?? 0) > 0) {
    deps.ask(detail);
    return;
  }
  try {
    await quit(true);
  } catch (error) {
    console.warn("Quit and Stop All failed", error);
    deps.ask({ ...detail, error: errorText(error) });
  }
}

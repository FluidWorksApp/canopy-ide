// "Quit and Stop All": with the terminal host on, Quit leaves terminals and
// agents running for the next launch to adopt. This is the quit that stops
// them. On every platform, host on or off, it asks first whenever an agent is
// running; otherwise it stops everything and quits at once. With the host off,
// Quit already stops everything, so the dialog has no "Quit only".

// The dialog is components/QuitStopAllDialog.tsx.

import { identifyAgent } from "./agentIdentity";
import { invokeDesktop } from "./host";
import type { SessionStats } from "./ipc";

export interface TerminalCounts {
  agents: number;
  shells: number;
}

/** What the dialog is opened with. `error` is set when stopping already
 *  failed (no agents running, so no dialog had been shown yet). */
export interface QuitStopAllAsk {
  counts: TerminalCounts;
  /** Terminals are hosted, so a plain Quit would leave them running. */
  hostOn: boolean;
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

/** "3 agents · 2 shells". */
export const stopAllMeta = ({ agents, shells }: TerminalCounts) =>
  shells > 0 ? `${plural(agents, "agent")} · ${plural(shells, "shell")}` : plural(agents, "agent");

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Quit the app; `stopAll` stops hosted terminals too, and rejects (without
 *  quitting) when the terminal host could not be asked to. Always the
 *  desktop's own command: quitting is about this computer, never a workspace. */
export const quitApp = (stopAll: boolean) => invokeDesktop<void>("app_quit", { stopAll });

const readHostOn = () => invokeDesktop<boolean>("pty_host_enabled");

/** The menu item. Reads this computer's terminals (not ipc.ptyStats, which
 *  adds terminals on other machines that quitting never stops). Agents
 *  running: hand the counts to `ask`. None: stop all and quit now, and if
 *  that fails, open the dialog with the error. A failed read of the terminals
 *  does nothing rather than stop blind. */
export async function startQuitStopAll(deps: {
  stats?: () => Promise<Pick<SessionStats, "agent_hint">[]>;
  hostOn?: () => Promise<boolean>;
  quit?: (stopAll: boolean) => Promise<unknown>;
  ask: (ask: QuitStopAllAsk) => void;
}): Promise<void> {
  const read = deps.stats ?? (() => invokeDesktop<SessionStats[]>("pty_stats"));
  const quit = deps.quit ?? quitApp;
  let counts: TerminalCounts;
  try {
    counts = countTerminals(await read());
  } catch (error) {
    console.warn("Quit and Stop All: could not read terminals", error);
    return;
  }
  // Unknown counts as on: then "Quit only" is offered, and with the host
  // really off it still stops everything, which is all it would cost.
  const hostOn = await (deps.hostOn ?? readHostOn)().catch(() => true);
  if (counts.agents > 0) {
    deps.ask({ counts, hostOn });
    return;
  }
  try {
    await quit(true);
  } catch (error) {
    console.warn("Quit and Stop All failed", error);
    deps.ask({ counts, hostOn, error: errorText(error) });
  }
}

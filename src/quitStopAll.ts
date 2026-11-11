// "Quit and Stop All": with the terminal host on, Quit leaves terminals and
// agents running for the next launch to adopt. This is the quit that stops
// them. It asks first only when an agent is running; otherwise it stops
// everything and quits at once. (With the host off the native menu just quits,
// since Quit already stops everything; see on_menu_event in lib.rs.)

// The dialog is components/QuitStopAllDialog.tsx.

import { identifyAgent } from "./agentIdentity";
import { invokeDesktop } from "./host";
import type { SessionStats } from "./ipc";

export interface TerminalCounts {
  agents: number;
  shells: number;
}

/** Terminals with an agent in the foreground, and the rest. The same split as
 *  `agentSessions` / `termSessions` in agentSessions.ts. */
export function countTerminals(stats: Pick<SessionStats, "agent_hint">[]): TerminalCounts {
  const agents = stats.filter((s) => identifyAgent(s.agent_hint) !== null).length;
  return { agents, shells: stats.length - agents };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export const stopAllTitle = (agents: number) => `Stop ${plural(agents, "running agent")}?`;

/** "3 agents · 2 shells". */
export const stopAllMeta = ({ agents, shells }: TerminalCounts) =>
  shells > 0 ? `${plural(agents, "agent")} · ${plural(shells, "shell")}` : plural(agents, "agent");

/** Quit the app; `stopAll` stops hosted terminals too. Always the desktop's
 *  own command: quitting is about this computer, never a workspace. */
export const quitApp = (stopAll: boolean) => invokeDesktop<void>("app_quit", { stopAll });

/** The menu item. Reads this computer's terminals (not ipc.ptyStats, which
 *  adds terminals on other machines that quitting never stops). No agent
 *  running: stop all and quit now. Otherwise hand the counts to `ask`. A
 *  failed read does nothing rather than stop blind. */
export async function startQuitStopAll(deps: {
  stats?: () => Promise<Pick<SessionStats, "agent_hint">[]>;
  quit?: (stopAll: boolean) => unknown;
  ask: (counts: TerminalCounts) => void;
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
  if (counts.agents === 0) await quit(true);
  else deps.ask(counts);
}

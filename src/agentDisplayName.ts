// What a running session is called on the surfaces that see sessions rather
// than tabs — the Agents page, the control panel, the memory flyout.
//
// The precedence itself is not here: it lives in tabName.ts, which is the one
// place any name is decided. This module only adapts a session (which carries a
// native name and an OSC title, and may have no tab open at all) into the slots
// that module reads. Two orderings for one question is how the strip and the
// Agents page came to disagree about what a tab was called.

import { tabName, type TabNames } from "./tabName";

/** The tab showing a session, as far as naming is concerned. */
export interface TabName extends TabNames {
  /** Agent-published current focus, transiently available before the digest
   *  store-change round trip lands. */
  description?: string;
}

const clean = (s?: string) => (s ?? "").trim() || undefined;

/**
 * A session's display name. The tab's slots when there is a tab, with the
 * session's own name and title standing in for the two slots a tab would have
 * filled from the same source.
 *
 * `agentLabel` exists only as a compatibility fallback for an older native core
 * that supplies no name of its own.
 */
export function agentDisplayName({
  tab,
  sessionTitle,
  sessionName,
  cwd,
  agentLabel,
}: {
  tab?: TabName;
  sessionTitle?: string;
  sessionName?: string;
  cwd?: string;
  /** Retained only as the last compatibility fallback for old native cores. */
  agentLabel?: string;
}): string {
  return tabName(
    {
      ...tab,
      nativeName: tab?.nativeName ?? clean(sessionName),
      oscTitle: tab?.oscTitle ?? clean(sessionTitle),
      cwd,
    },
    // These surfaces list agent sessions, so the generated session label is the
    // identity the rest of Canopy addresses them by, not noise.
    { agent: true, agentLabel },
  );
}

export interface TerminalNameSource {
  id: number;
  name?: string;
  agent: boolean;
}

/** One terminal label for system-owned surfaces. Agent sessions use the live
 *  naming substrate; ordinary shells deliberately keep the neutral numbered
 *  fallback instead of borrowing an OSC title that may name a cwd or process. */
export function terminalDisplayName({
  id,
  name,
  agent,
}: TerminalNameSource): string {
  if (!agent) return `Terminal ${id}`;
  return clean(name) || `Terminal ${id}`;
}

/** ptyId -> the tab showing it, for every terminal tab that has spawned. The
 *  Agents panel keys rows by pty, so that is what the map is keyed by. */
export function tabNamesByPty(
  tabs: readonly (TabNames & {
    type: string;
    ptyId?: number | null;
    description?: string;
  })[],
): Map<number, TabName> {
  const out = new Map<number, TabName>();
  for (const t of tabs) {
    if (t.type !== "terminal" || t.ptyId == null) continue;
    out.set(t.ptyId, {
      userName: t.userName,
      agentName: t.agentName,
      promptName: t.promptName,
      nativeName: t.nativeName,
      oscTitle: t.oscTitle,
      launchTitle: t.launchTitle,
      description: t.description,
    });
  }
  return out;
}

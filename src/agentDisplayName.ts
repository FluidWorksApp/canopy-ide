// What a running session is called in the Agents panel.
//
// The panel used to print the CLI's own name, so six Claude sessions read as
// six rows all saying "claude" — the one word they have in common, and the one
// that tells them apart least. The tab strip already names them: the CLI
// repaints its title with what it is working on, and the user can rename a tab
// outright. That name is the one already learned, so the row borrows it.

/** The tab showing a session, as far as naming is concerned. */
export interface TabName {
  /** Auto title, tracked from the shell/OSC — what the CLI calls itself. */
  title?: string;
  /** The user's rename. Wins over everything: it was typed on purpose. */
  customTitle?: string;
}

/** Auto titles that name a terminal rather than the work in it. A shell that
 *  has not been titled by anything reports its own name (or the login shell's,
 *  or nothing at all), and "zsh" is a worse row heading than "claude". Only
 *  consulted for the auto title — a user who renames a tab to "shell" means it.
 */
const GENERIC = new Set([
  "",
  "shell",
  "terminal",
  "term",
  "console",
  "agent",
  "sh",
  "bash",
  "zsh",
  "-zsh",
  "-bash",
  "fish",
  "login",
  "node",
]);

const clean = (s?: string) => (s ?? "").trim();

/** True when an auto title says nothing the CLI's name doesn't already say. */
const uninformative = (title: string, agentLabel?: string) =>
  GENERIC.has(title.toLowerCase()) ||
  // A path is where it runs, not what it is doing; the row already carries a
  // directory chip.
  title.startsWith("/") ||
  title.startsWith("~/") ||
  // The bin under its own name adds nothing over the identified label, and the
  // label is the tidier spelling of the two.
  (!!agentLabel && title.toLowerCase() === agentLabel.toLowerCase());

/**
 * The name for one row: the tab's name when the tab has one worth showing,
 * otherwise the identified CLI, otherwise whatever the backend called the
 * session.
 *
 * Precedence is deliberate. A rename is an instruction and always wins. The
 * auto title wins next, because a CLI that titles its tab "Fix the login
 * redirect" has said something no other source can. Only when the tab says
 * nothing useful — a fresh shell, a bare bin name — does the row fall back to
 * naming the program.
 */
export function agentDisplayName({
  tab,
  agentLabel,
  sessionTitle,
}: {
  tab?: TabName;
  agentLabel?: string;
  sessionTitle?: string;
}): string {
  const renamed = clean(tab?.customTitle);
  if (renamed) return renamed;
  const auto = clean(tab?.title);
  if (auto && !uninformative(auto, agentLabel)) return auto;
  return agentLabel || clean(sessionTitle) || "shell";
}

/** ptyId -> the tab showing it, for every terminal tab that has spawned. The
 *  Agents panel keys rows by pty, so that is what the map is keyed by. */
export function tabNamesByPty(
  tabs: readonly { type: string; ptyId?: number | null; title?: string; customTitle?: string }[],
): Map<number, TabName> {
  const out = new Map<number, TabName>();
  for (const t of tabs) {
    if (t.type !== "terminal" || t.ptyId == null) continue;
    out.set(t.ptyId, { title: t.title, customTitle: t.customTitle });
  }
  return out;
}

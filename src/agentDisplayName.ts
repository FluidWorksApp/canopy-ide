// What a running session is called everywhere Canopy surfaces it. The assigned
// name is stable even when a CLI repeatedly repaints its terminal title.

/** The tab showing a session, as far as naming is concerned. */
export interface TabName {
  /** Canopy's stable per-session name. */
  name?: string;
  /** Auto title, tracked from the shell/OSC — what the CLI calls itself. */
  title?: string;
  /** Legacy/prespawn rename, promoted into `name` once the PTY exists. */
  customTitle?: string;
  /** Agent-published current focus, transiently available before the digest
   *  store-change round trip lands. */
  description?: string;
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

/**
 * A terminal's own title, shortened to something a chip can hold.
 *
 * On Unix a shell reports "/bin/zsh" or the directory it is in — short either
 * way. cmd.exe reports its own full path, so a Windows terminal was titled
 * `C:\Windows\system32\cmd.exe`, which every surface that shows it then
 * truncated to `C:\Windows\syste…`: forty characters spent saying nothing,
 * and two shells side by side reading identically. The tail is the part that
 * identifies it, so keep that.
 *
 * Only for path-shaped titles. Anything a CLI paints ("✳ Fix the redirect")
 * is left exactly as it is — those are already the good case, and a path
 * separator in prose must not truncate the prose.
 */
export function shellTitle(title: string): string {
  const t = title.trim();
  // A drive letter or a UNC root. Unix paths are left alone: "/bin/zsh" is
  // already short, it is what macOS has always shown, and shortening it to
  // "zsh" would land in the GENERIC list above and rename every shell row.
  if (!/^[a-zA-Z]:[\\/]|^\\\\/.test(t)) return t;
  const tail = t.split(/[\\/]/).filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : t;
}

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
 * Precedence is deliberate: assigned name, then the CLI's useful title, then
 * cwd basename. `agentLabel` exists only for compatibility with an older
 * native core that supplies none of those.
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
  const assigned = clean(tab?.name) || clean(sessionName) || clean(tab?.customTitle);
  if (assigned) return assigned;
  const auto = clean(tab?.title) || clean(sessionTitle);
  if (auto && !uninformative(auto, agentLabel)) return auto;
  const dir = clean(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop();
  return dir || agentLabel || "shell";
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
  tabs: readonly {
    type: string;
    ptyId?: number | null;
    name?: string;
    title?: string;
    customTitle?: string;
    description?: string;
  }[],
): Map<number, TabName> {
  const out = new Map<number, TabName>();
  for (const t of tabs) {
    if (t.type !== "terminal" || t.ptyId == null) continue;
    out.set(t.ptyId, {
      name: t.name,
      title: t.title,
      customTitle: t.customTitle,
      description: t.description,
    });
  }
  return out;
}

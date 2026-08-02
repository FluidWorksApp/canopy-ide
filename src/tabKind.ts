// What a tab IS, in the two words a switcher card has room for.
//
// The switcher shows a picture and a title, and a title alone is ambiguous in
// the exact moment the panel is up: "canopy" is a terminal, a project and a
// repo; `agentSessions.ts` is a file, but the agent that has it open is a
// different tab entirely. Holding Ctrl+Tab is a half-second decision made on
// peripheral vision, so each card says its kind out loud and carries a colour
// that means the same thing.
//
// The hue is a token, never a literal — a skin has eighteen of them and this
// picks from that set, so Lattice's teal and Daylight's blue both come out
// right without this file knowing either exists.

import type { SubTab } from "./components/ProjectView/helpers";

/** The palette token a kind is drawn in. Deliberately few: six hues over
 *  fifteen tab types, grouped by what the tab is FOR rather than by what
 *  renders it, because the point is telling apart at a glance and eleven
 *  colours tell apart nothing. */
export type TabTone =
  /** Something an agent is doing — the tabs that change while you look away. */
  | "agent"
  /** Your own text: files, notes, research, instructions. */
  | "doc"
  /** A shell you drive. */
  | "shell"
  /** Code review and history: PRs, commits, branches, diffs. */
  | "review"
  /** A window onto something outside Canopy: a browser, a device. */
  | "external"
  /** People: chat, live share. */
  | "people";

export interface TabKind {
  /** Uppercased on screen; kept lowercase here so tests read as prose. */
  label: string;
  tone: TabTone;
  /** The second half of the line — which agent, which repo, which directory.
   *  Empty when the title already says it. */
  detail: string;
}

/**
 * The kind line for one tab.
 *
 * `detail` answers the question the title leaves open, and that question
 * differs per kind: for an agent it is *which CLI* (six Claude cards are six
 * identical words otherwise), for a file it is the directory (three `index.ts`
 * are not the same file), for a terminal it is where it is running.
 */
export function tabKind(tab: SubTab): TabKind {
  switch (tab.type) {
    case "terminal":
      // A run is a command someone started, not a shell they type in — the two
      // live in different rails and mean different things when you land on one.
      return {
        label: tab.run ? "run" : "terminal",
        tone: "shell",
        detail: basename(tab.cwd),
      };
    case "agent":
      return { label: "agent", tone: "agent", detail: tab.agent };
    case "agents":
      return { label: "agents", tone: "agent", detail: "" };
    case "file":
      return { label: "file", tone: "doc", detail: basename(dirOf(tab.file.path)) };
    case "note":
      return { label: "note", tone: "doc", detail: "" };
    case "research":
      return { label: "research", tone: "doc", detail: "" };
    case "instructions":
      return { label: "instructions", tone: "doc", detail: "" };
    case "pr":
      return { label: "pull request", tone: "review", detail: basename(tab.repo) };
    case "review":
      return { label: "review", tone: "review", detail: tab.review.from };
    case "commit":
      return { label: "commit", tone: "review", detail: basename(tab.repo) };
    case "branch":
      return { label: "branch", tone: "review", detail: basename(tab.repo) };
    case "claim":
      return { label: "claim", tone: "agent", detail: "" };
    case "ticket":
      return { label: "issue", tone: "review", detail: tab.source };
    case "task-history":
      return { label: "tasks", tone: "agent", detail: "" };
    case "mcp":
      return { label: "mcp server", tone: "external", detail: "" };
    case "preview":
      return { label: "browser", tone: "external", detail: hostOf(tab.url) };
    case "device":
      return { label: "device", tone: "external", detail: "" };
    case "chat":
      return { label: "chat", tone: "people", detail: tab.peer === null ? "everyone" : "" };
    case "collab":
    case "shared-project":
      return { label: "shared", tone: "people", detail: tab.ownerName };
  }
}

/** The last segment of a path. Both separators, because a Windows tab is a
 *  Windows path — see src/paths.ts on the branch that makes this the app's one
 *  implementation; this collapses into it when that lands. */
function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** The directory a file sits in — everything before the last separator. */
function dirOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at <= 0 ? "" : path.slice(0, at);
}

/** A preview's host, which is what distinguishes two browser tabs. Falls back
 *  to nothing rather than showing a parse error's worth of URL. */
function hostOf(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

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
import { agentIdForCommand } from "./agentIdentity";
import { AGENT_BRAND_COLOR } from "../shared/agentGlyphs";
import { docStackFor } from "./tabGroups";

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
  /** The CLI behind this card, when there is one — a session or its workspace.
   *  Drives the brand mark and the brand colour. */
  agent?: string;
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
    case "terminal": {
      // Most agents ARE terminal tabs. The "agent" type below is the workspace
      // view of a session — its files, diffs and PR — while the session itself
      // is a CLI running in a pty, and calling that "terminal · canopy" is the
      // switcher describing the container instead of the contents. The command
      // is what the tab was launched with, so it names the CLI when there is
      // one; the same resolver the tab strip and hibernation use.
      const cli = agentIdForCommand(tab.command);
      if (cli) return { label: "agent", tone: "agent", detail: cli, agent: cli };
      // A run is a command someone started, not a shell they type in — the two
      // live in different rails and mean different things when you land on one.
      return {
        label: tab.run ? "run" : "terminal",
        tone: "shell",
        detail: basename(tab.cwd),
      };
    }
    case "agent":
      // The workspace, not the session: what that agent changed, where it is
      // committed, which PR came out of it. Named apart from the live session
      // above so two cards for one agent do not read identically.
      return { label: "workspace", tone: "agent", detail: tab.agent, agent: tab.agent };
    case "agents":
      return { label: "agents", tone: "agent", detail: "" };
    case "file":
      return { label: "file", tone: "doc", detail: basename(dirOf(tab.file.path)) };
    case "note":
      return { label: "note", tone: "doc", detail: "" };
    case "research":
      return { label: "research", tone: "doc", detail: "" };
    case "research-list":
      return { label: "research", tone: "doc", detail: "all" };
    case "notes-list":
      return { label: "scratchpad", tone: "doc", detail: "all" };
    case "instructions":
      return { label: "instructions", tone: "doc", detail: "" };
    case "pr":
      return { label: "pull request", tone: "review", detail: basename(tab.repo) };
    case "prs-list":
      return { label: "pull requests", tone: "review", detail: "all" };
    case "issues-list":
      return { label: "issues", tone: "review", detail: "all" };
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

/** Which grouped-switcher row a tab belongs to. The doc stacks, except that a
 *  terminal is split by its contents — an agent session and the shell beside it
 *  are different rows, for the same reason tabKind names them apart. */
export function switchRowKey(tab: SubTab): string {
  if (tab.type === "terminal") return tabKind(tab).agent ? "agents" : "shells";
  return docStackFor(tab.type);
}

/** What colour to draw an agent card in: the CLI's own, where it has one.
 *
 *  A brand colour is the one value in this app that is not a skin token,
 *  because it is not ours to choose — Claude's terracotta is Claude's on every
 *  skin, and that is exactly what makes six agent cards tell themselves apart
 *  at a glance. Anything without a published mark falls back to the skin's
 *  accent rather than to a colour we invented for it. */
export function tabToneColor(kind: TabKind): string | undefined {
  return kind.agent ? AGENT_BRAND_COLOR[kind.agent] : undefined;
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

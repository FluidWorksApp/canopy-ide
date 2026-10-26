// Canopy as Claude Code's IDE: the frontend half of claude_ide.rs.
//
// A Claude agent tab gets its own IDE server (Rust), and `claude` in it then
// treats Canopy the way it treats VS Code: proposed edits arrive here as diffs
// to accept or reject, the editor selection goes to the CLI, and "Add to
// Claude" puts an @-mention in its prompt. This module is the policy and the
// state — who gets a server, what is pending, how a Monaco selection reads on
// the wire — kept free of Monaco and IPC so every rule here is unit-tested.
// claudeIdeBridge.ts does the wiring.
//
// Only Claude Code, and only where the harness ledger says the protocol is
// verified (harness.ts `ideProtocol`). Every other CLI keeps using Canopy's own
// MCP editor tools (canopy_editor_state, canopy_diagnostics, canopy_show_diff),
// which stay the fallback for Claude too when this is off.
import { agentIdForCommand } from "./agentIdentity";
import { createChannel } from "./channel";
import { harnessSupport } from "./harness";
import { isRemoteHost, isWorkspaceHost } from "./host";
import { getSettings } from "./settings";

/** The env marker that asks Rust for a server; its value is the component
 *  root for the lock. Consumed by pty.rs, never seen by the child. */
export const CLAUDE_IDE_MARKER = "CANOPY_CLAUDE_IDE";

/** The extra env a terminal launch carries to get an IDE server, or none.
 *
 *  An interactive Claude Code launch only: `command` is the line typed into
 *  the tab's shell. A run tab or micro-task hands its command to the shell as
 *  `runCommand` instead, and nobody is at its terminal to answer a diff; a
 *  headless `-p` run never connects at all (verified), so it is never asked.
 *  In a remote workspace the server runs on the VM, beside `claude` (the
 *  workspace host carries the marker to packages/remote-host/claude-ide.mjs).
 *  The phone portal is left out: its terminals are the desktop's, but the
 *  window that would answer their diffs is not the one being driven. */
export function claudeIdeLaunchEnv(launch: {
  command?: string;
  runCommand?: string;
  /** The component the tab belongs to, if known. */
  root?: string;
  /** Where the terminal starts. */
  cwd?: string;
}): [string, string][] {
  if (!launch.command || launch.runCommand) return [];
  if (!getSettings().claudeIdeIntegration) return [];
  if (isRemoteHost() && !isWorkspaceHost()) return [];
  const cli = agentIdForCommand(launch.command);
  // The ledger is the gate: only Claude Code's entry marks `ideProtocol`
  // native, and that entry is this protocol (harness.ts). No vendor id here.
  if (!cli || harnessSupport(cli, "ideProtocol") !== "native") return [];
  if (/(^|\s)(-p|--print)(\s|$)/.test(launch.command)) return [];
  return [[CLAUDE_IDE_MARKER, claudeIdeRoot(launch.root, launch.cwd)]];
}

/** The folder a session is scoped to: the lock's `workspaceFolders`, and what
 *  a selection or a mention is routed by. The component when the terminal
 *  runs inside it; the terminal's own cwd when it doesn't — an agent in a
 *  worktree sits beside the component (`<repo>-wt-…`), and every file it
 *  touches is under the worktree, never under the component it came from. */
export function claudeIdeRoot(root: string | undefined, cwd: string | undefined): string {
  const r = (root ?? "").replace(/[\\/]+$/, "");
  if (!cwd) return r;
  if (r && (cwd === r || cwd.startsWith(`${r}/`) || cwd.startsWith(`${r}\\`))) return r;
  return cwd;
}

// ---- what Rust tells us ------------------------------------------------------

/** One `claude-ide` event, as claude_ide.rs `UiEvent` serialises it. */
export type ClaudeIdeEvent =
  | { kind: "diff"; ptyId: number; tabName: string; path: string; contents: string }
  | { kind: "diffClosed"; ptyId: number; tabName: string }
  | { kind: "diffsCleared"; ptyId: number }
  | { kind: "diagnostics"; requestId: number; ptyId: number; root: string; uri: string | null }
  | { kind: "connection"; ptyId: number; root: string; connected: boolean };

/** A proposed edit waiting on the user. */
export interface PendingClaudeDiff {
  ptyId: number;
  /** How the CLI names it, and the title of the view. */
  tabName: string;
  path: string;
  /** The whole file as Claude proposes it. */
  proposed: string;
}

export interface ClaudeIdeState {
  /** Terminals with a CLI attached, and the component each one serves. */
  connections: ReadonlyMap<number, string>;
  diffs: readonly PendingClaudeDiff[];
}

export const EMPTY_STATE: ClaudeIdeState = { connections: new Map(), diffs: [] };

/** The state after one event. Pure, so the protocol's awkward orderings —
 *  close_tab before the user answered, twice, for a diff long gone — are
 *  tested as plain data. A diagnostics request changes nothing here. */
export function reduceClaudeIde(state: ClaudeIdeState, event: ClaudeIdeEvent): ClaudeIdeState {
  switch (event.kind) {
    case "diff": {
      // Same name again replaces the old one, as on the Rust side.
      const rest = state.diffs.filter(
        (d) => !(d.ptyId === event.ptyId && d.tabName === event.tabName),
      );
      return {
        ...state,
        diffs: [
          ...rest,
          { ptyId: event.ptyId, tabName: event.tabName, path: event.path, proposed: event.contents },
        ],
      };
    }
    case "diffClosed": {
      const diffs = state.diffs.filter(
        (d) => !(d.ptyId === event.ptyId && d.tabName === event.tabName),
      );
      return diffs.length === state.diffs.length ? state : { ...state, diffs };
    }
    case "diffsCleared": {
      const diffs = state.diffs.filter((d) => d.ptyId !== event.ptyId);
      return diffs.length === state.diffs.length ? state : { ...state, diffs };
    }
    case "connection": {
      const connections = new Map(state.connections);
      if (event.connected) connections.set(event.ptyId, event.root);
      else connections.delete(event.ptyId);
      // A dropped CLI cannot answer the diffs it opened; Rust says so too, but
      // the view must not outlive the connection either way.
      const diffs = event.connected
        ? state.diffs
        : state.diffs.filter((d) => d.ptyId !== event.ptyId);
      return { connections, diffs };
    }
    case "diagnostics":
      return state;
  }
}

const store = createChannel<ClaudeIdeState>(EMPTY_STATE);
export const claudeIdeState = store.get;
export const subscribeClaudeIde = store.subscribe;
export const applyClaudeIdeEvent = (event: ClaudeIdeEvent) =>
  store.set(reduceClaudeIde(store.get(), event));
/** Drop a diff from view once the user has answered it here. Rust will send
 *  close_tab's diffClosed shortly; this just doesn't wait for it. */
export const dismissClaudeDiff = (ptyId: number, tabName: string) =>
  applyClaudeIdeEvent({ kind: "diffClosed", ptyId, tabName });
export const resetClaudeIdeForTest = store.reset;

export const isClaudeIdeConnected = (ptyId: number | undefined) =>
  ptyId != null && store.get().connections.has(ptyId);

/** The diffs a project should show: those opened by its own terminals. */
export const diffsForPtys = (state: ClaudeIdeState, ptyIds: ReadonlySet<number>) =>
  state.diffs.filter((d) => ptyIds.has(d.ptyId));

/** Whether any connected session's component contains `path`. Lets the editor
 *  skip the IPC for a selection nobody would receive. */
export function hasSessionFor(state: ClaudeIdeState, path: string): boolean {
  for (const root of state.connections.values()) {
    const r = root.replace(/[\\/]+$/, "");
    if (r && (path === r || path.startsWith(`${r}/`) || path.startsWith(`${r}\\`))) return true;
  }
  return false;
}

// ---- the terminal the user last looked at -----------------------------------

let lastActivePty: number | undefined;
/** Called by a terminal when it becomes the active one, so "Add to Claude"
 *  can prefer the session the user is looking at. Rust checks it is a
 *  connected Claude session on that file before using it. */
export const noteActiveTerminal = (ptyId: number) => {
  lastActivePty = ptyId;
};
export const lastActiveTerminal = () => lastActivePty;

// ---- how an editor selection reads on the wire --------------------------------

/** Monaco's 1-based selection, as an editor reports it. */
export interface EditorSelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Longest selection text sent. The CLI attaches the selection to the next
 *  prompt verbatim; a select-all on a generated file is not context. */
export const MAX_SELECTION_CHARS = 100_000;

/** `selection_changed` params: 0-based positions, the text, the path. An
 *  empty selection is "this file is open, nothing selected" — the CLI shows
 *  `In hello.py` and tells the model the user opened it. */
export function selectionParams(path: string, sel: EditorSelection, text: string) {
  const empty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
  return {
    text: empty ? "" : text.slice(0, MAX_SELECTION_CHARS),
    filePath: path,
    fileUrl: fileUrl(path),
    selection: {
      start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 },
      end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 },
      isEmpty: empty,
    },
  };
}

/** `at_mentioned` lines, 0-based and inclusive, or none for "the whole file".
 *  A selection that ends at column 1 of a line has not selected anything on
 *  it — the CLI counts selected lines the same way. */
export function mentionLines(sel: EditorSelection | null): { lineStart: number; lineEnd: number } | null {
  if (!sel) return null;
  if (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn) return null;
  let end = sel.endLineNumber;
  if (sel.endColumn === 1 && end > sel.startLineNumber) end -= 1;
  return { lineStart: sel.startLineNumber - 1, lineEnd: end - 1 };
}

export function fileUrl(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const rooted = slashed.startsWith("/") ? slashed : `/${slashed}`;
  return `file://${rooted.split("/").map(encodeURIComponent).join("/").replace(/^\/([A-Za-z])%3A/, "/$1:")}`;
}

/** A selection-change debouncer: the last selection in a burst wins. Moving
 *  the caret fires on every keystroke and drag; the CLI only needs where it
 *  settled. */
export function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
}

// ---- diagnostics ------------------------------------------------------------

/** A Monaco marker, as much of it as the CLI needs. */
export interface MarkerLike {
  severity: number;
  message: string;
  source?: string;
  code?: string | { value: string } | null;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const SEVERITY: Record<number, string> = { 8: "Error", 4: "Warning", 2: "Info", 1: "Hint" };

/** Markers in the CLI's shape: 0-based ranges, string severities. */
export function markersToDiagnostics(markers: readonly MarkerLike[]) {
  return markers.map((m) => ({
    message: m.message,
    severity: SEVERITY[m.severity] ?? "Hint",
    ...(m.source ? { source: m.source } : {}),
    ...(m.code != null ? { code: typeof m.code === "object" ? m.code.value : String(m.code) } : {}),
    range: {
      start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
      end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
    },
  }));
}

/** The local path a `file://` URI names. */
export function pathOfFileUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const path = decodeURIComponent(uri.slice("file://".length));
  // file:///C:/x → C:/x
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

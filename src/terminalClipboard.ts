// Copy and paste for terminals, local and remote alike.
//
// xterm.js draws its selection itself, over rows that are `user-select: none`.
// To WebKit that is no selection at all: the native context menu and Edit >
// Copy validate against the DOM, find nothing, and grey Copy out — so neither a
// right-click nor ⌘C could reliably get a highlighted block out of a terminal.
// This module is the copy path that does not depend on WebKit agreeing.
//
// It is also the only way a program inside a *remote* PTY can reach the
// clipboard of the computer showing the IDE. Claude Code, tmux, vim and
// friends write OSC 52 (`ESC ] 52 ; c ; <base64> BEL`) when there is no local
// clipboard to copy into — which on a workspace VM is always.
import * as ipc from "./ipc";
import { isRemoteHost, isWorkspaceHost } from "./host";
import { IS_MAC } from "./platform";
import { format } from "./shortcuts";
import type { MenuItem } from "./components/ContextMenu";

/** Largest decoded OSC 52 payload accepted. Generous for a copied file, small
 *  enough that a runaway program cannot make the renderer decode megabytes of
 *  base64 per frame. (The native write itself caps any text at 4 MB.) */
export const OSC52_MAX_BYTES = 1024 * 1024;
/** An OSC 52 write is honoured only this soon after the user last gave the
 *  terminal input (a key, a paste, a mouse report). Every real copy is the
 *  answer to one — select-then-release, `y` in copy mode, `/copy` + Enter — so
 *  this costs nothing legitimate, while it stops replayed scrollback (a
 *  reattach re-parses old output) and `cat`ed files from silently rewriting
 *  the clipboard long after the fact. */
export const OSC52_INPUT_WINDOW_MS = 15_000;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode an OSC 52 payload (`Pc;Pd`, without the `52;`) into the text to copy.
 * Null for anything that must not reach the clipboard:
 *   - `?`, a request to READ the clipboard back into the terminal. Never
 *     answered: it would hand the clipboard to whatever program asked.
 *   - an empty payload (a "clear" request), malformed base64, or a payload
 *     over `maxBytes`.
 * The selection parameter (c/p/s/0-7, or empty) is accepted and ignored: there
 * is one system clipboard to put it on.
 */
export function parseOsc52(data: string, maxBytes = OSC52_MAX_BYTES): string | null {
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const payload = data.slice(semi + 1).replace(/\s+/g, "");
  if (!payload || payload === "?") return null;
  // Base64 inflates by 4/3 — reject before decoding anything.
  if (payload.length > Math.ceil(maxBytes / 3) * 4) return null;
  if (payload.length % 4 === 1 || !BASE64.test(payload)) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  if (binary.length > maxBytes) return null;
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const text = new TextDecoder("utf-8").decode(bytes);
  return text || null;
}

/** Text an OSC 52 sequence asks to copy, or null when it must be dropped:
 *  malformed, a query, too large, or not near any input from the user. */
export function osc52Copy(data: string, msSinceInput: number): string | null {
  if (!(msSinceInput >= 0 && msSinceInput <= OSC52_INPUT_WINDOW_MS)) return null;
  return parseOsc52(data);
}

/** The native clipboard belongs to the computer showing the IDE. That is this
 *  process locally and the desktop under a workspace host — but in the phone
 *  portal the host IS the desktop, so a native write would land on the wrong
 *  machine; there the browser's own clipboard is the right one. */
const nativeClipboard = () => !isRemoteHost() || isWorkspaceHost();

/** Last resort where the async clipboard API is refused: a throwaway textarea
 *  and the legacy copy command. Focus goes back where it was. */
function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus?.();
  return ok;
}

/**
 * Put text on the system clipboard. Native first — it needs no user gesture,
 * which an OSC 52 copy (it arrives in output) never has and an async callback
 * no longer has — then the webview clipboard, then the legacy copy command.
 * Resolves whether any of them took it.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false;
  if (nativeClipboard()) {
    try {
      await ipc.clipboardWriteText(text);
      return true;
    } catch {
      // Unsupported off macOS, or the pasteboard refused: fall through.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return execCommandCopy(text);
  }
}

/** Plain text from the system clipboard, for a Paste that is not the native
 *  paste command (a menu click, Ctrl+Shift+V). Null when there is none or it
 *  cannot be read. */
export async function readClipboardText(): Promise<string | null> {
  if (nativeClipboard()) {
    try {
      const text = await ipc.clipboardReadText();
      return text ?? null;
    } catch {
      // Unsupported off macOS: fall through to the webview.
    }
  }
  try {
    return (await navigator.clipboard.readText()) || null;
  } catch {
    return null;
  }
}

/** How to force a selection while a TUI has mouse tracking on: xterm hands a
 *  plain drag to the program, and a modifier-drag to its own selection. On a
 *  Mac that is Option (Term sets `macOptionClickForcesSelection`). */
export const forceSelectionHint = (mac = IS_MAC) =>
  mac ? "Hold ⌥ Option and drag to select text" : "Hold Shift and drag to select text";

export interface TerminalMenuActions {
  /** xterm has a selection right now. */
  hasSelection: boolean;
  /** The program in the terminal has mouse tracking on, so a plain drag goes
   *  to it rather than to xterm's selection. */
  mouseTracking: boolean;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  clear: () => void;
}

/** Canopy's terminal context menu — replaces the webview's, whose Copy can
 *  never see xterm's selection. */
export function terminalMenuItems(a: TerminalMenuActions, mac = IS_MAC): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Copy", hint: format("term-copy") || undefined, disabled: !a.hasSelection, onClick: a.copy },
  ];
  if (!a.hasSelection && a.mouseTracking) items.push({ label: forceSelectionHint(mac), disabled: true });
  items.push(
    { label: "Paste", hint: (mac ? "⌘V" : format("term-paste")) || undefined, onClick: a.paste },
    { separator: true },
    { label: "Select All", onClick: a.selectAll },
    { label: "Clear", onClick: a.clear },
  );
  return items;
}

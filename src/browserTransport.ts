// Which wire a browser op goes down.
//
// Three engines now drive the same page-side picker (preview_picker.js) with
// the same op vocabulary, and differ only in how bytes reach it:
//
//   proxy     — an <iframe> this window hosts. postMessage, both ways. Handled
//               in PreviewView directly, because only it holds the frame; this
//               module reports `null` for it rather than pretending otherwise.
//   webview   — a child WKWebView. Ops go out over IPC; results come back
//               pushed, because the page can ring a doorbell the host hooks.
//   chromium  — a browser the user installed, over CDP. Ops go out over IPC;
//               results must be PULLED, because a browser we do not host has no
//               doorbell to hook.
//
// That last difference is the only one worth a seam. Everything else is the
// same call with a different name, and writing it out once here keeps the
// engine check from spreading through every caller — which is what happened to
// the `native` flag, and is why adding a third engine touched so much.

import * as ipc from "./ipc";
import type { BrowserEngine } from "./browserBounds";
import type { BrowserOpAck } from "./ipc";

export interface BrowserTransport {
  navigate(tabId: string, url: string | null, action: string | null): Promise<void>;
  runOp(tabId: string, op: Record<string, unknown>): Promise<BrowserOpAck | null>;
  command(tabId: string, message: Record<string, unknown>): Promise<void>;
  here(tabId: string): Promise<{ url: string; title: string } | null>;
  close(tabId: string): Promise<void>;
  /** True when the page can announce results by itself. When false the caller
   *  has to poll `drain`, and an op whose ack says `done: false` is not
   *  finished — it is merely not finished *here*. */
  pushesEvents: boolean;
  /** Queued page events. Always present, because even a pushing engine wants a
   *  follow-up drain after an async op in case the doorbell was missed. */
  drain(tabId: string): Promise<unknown[]>;
}

const webviewTransport: BrowserTransport = {
  navigate: (tabId, url, action) => ipc.browserNavigate(tabId, url, action),
  runOp: (tabId, op) => ipc.browserRunOp(tabId, op),
  command: (tabId, message) => ipc.browserCommand(tabId, message),
  here: (tabId) => ipc.browserHere(tabId),
  close: (tabId) => ipc.browserClose(tabId),
  pushesEvents: true,
  // The webview engine emits browser:events off its doorbell; there is no
  // separate pull, so this resolves empty rather than inventing a second path.
  drain: async () => [],
};

function chromiumTransport(): BrowserTransport {
  return {
    // CDP has no "go back one" command that takes a delta the way the webview
    // wrapper does; history moves are done in the page, which the picker
    // already knows how to do. Only a real URL comes through here.
    navigate: async (tabId, url, action) => {
      if (url) return ipc.chromiumNavigate(tabId, url);
      const delta = action === "back" ? -1 : action === "forward" ? 1 : 0;
      await ipc.chromiumCommand(tabId, { canopy: "navigate", delta });
    },
    runOp: (tabId, op) => ipc.chromiumRunOp(tabId, op),
    command: (tabId, message) => ipc.chromiumCommand(tabId, message),
    here: (tabId) => ipc.chromiumHere(tabId),
    close: (tabId) => ipc.chromiumClose(tabId),
    pushesEvents: false,
    drain: async (tabId) => (await ipc.chromiumDrain(tabId)) ?? [],
  };
}

/** Open a tab on the given engine. Separate from the transport because only
 *  this call needs to know which binary to launch, and only the first tab
 *  actually launches anything — the rest attach to the browser already up. */
export function openOn(
  engine: BrowserEngine,
  exe: string,
  tabId: string,
  url: string,
): Promise<void> | null {
  if (engine !== "chromium") return null;
  if (!exe) return null;
  return ipc.chromiumOpen(exe, tabId, url);
}

/** The transport for an engine, or null when the engine is not driven over IPC
 *  at all (the proxy engine, whose frame lives in this window).
 *
 *  `exe` is only consulted for the chromium engine; an empty one yields null,
 *  because "chromium engine with no browser" is not a state to paper over —
 *  chooseEngine should already have fallen back to the proxy. */
export function transportFor(
  engine: BrowserEngine,
  exe: string,
): BrowserTransport | null {
  if (engine === "webview") return webviewTransport;
  if (engine === "chromium") return exe ? chromiumTransport() : null;
  return null;
}

/** The binary to drive for the chromium engine: the user's explicit choice if
 *  they made one, otherwise whatever detection ranked first. Separated from the
 *  transport so the settings UI can show the same answer the engine will use. */
export function resolveChromiumExe(
  configured: string,
  detected: { name: string; path: string }[],
): string {
  return configured.trim() || detected[0]?.path || "";
}

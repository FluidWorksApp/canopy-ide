// Which wire a browser op goes down.
//
// Both engines drive the same page-side picker (preview_picker.js) with the
// same op vocabulary, and differ only in how bytes reach it:
//
//   proxy     — an <iframe> this window hosts. postMessage, both ways. Handled
//               in PreviewView directly, because only it holds the frame; this
//               module reports `null` for it rather than pretending otherwise.
//   webview   — a child WKWebView. Ops go out over IPC; results come back
//               pushed, because the page can ring a doorbell the host hooks.
//
// Everything else is the same call with a different name, and writing it out
// once here keeps the engine check from spreading through every caller — which
// is what happened to the `native` flag.

import * as ipc from "./ipc";
import type { BrowserEngine } from "./browserBounds";
import type { BrowserOpAck } from "./ipc";

export interface BrowserTransport {
  navigate(tabId: string, url: string | null, action: string | null): Promise<void>;
  runOp(tabId: string, op: Record<string, unknown>): Promise<BrowserOpAck | null>;
  command(tabId: string, message: Record<string, unknown>): Promise<void>;
  here(tabId: string): Promise<{ url: string; title: string } | null>;
  close(tabId: string): Promise<void>;
}

const webviewTransport: BrowserTransport = {
  navigate: (tabId, url, action) => ipc.browserNavigate(tabId, url, action),
  runOp: (tabId, op) => ipc.browserRunOp(tabId, op),
  command: (tabId, message) => ipc.browserCommand(tabId, message),
  here: (tabId) => ipc.browserHere(tabId),
  close: (tabId) => ipc.browserClose(tabId),
};

/** The transport for an engine, or null when the engine is not driven over IPC
 *  at all (the proxy engine, whose frame lives in this window). */
export function transportFor(engine: BrowserEngine): BrowserTransport | null {
  if (engine === "webview") return webviewTransport;
  return null;
}

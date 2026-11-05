import type { BrowserEngine } from "./browserBounds";

const LOOPBACK = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

/** A page served from the workspace itself, which reaches this computer's
 *  embedded browser over the workspace's port forward. Any other site is
 *  loaded straight from this computer. */
export function isWorkspaceLocalPage(url: string): boolean {
  try {
    const target = new URL(url);
    return (
      ["http:", "https:"].includes(target.protocol) &&
      (LOOPBACK.includes(target.hostname) || target.hostname.endsWith(".localhost"))
    );
  } catch {
    return false;
  }
}

/** Which engine renders a preview tab. A workspace always uses the proxy: the
 *  page runs here, and only its server is elsewhere. */
export function previewEngine(opts: {
  remote: boolean;
  buildMode: boolean;
  chosen: BrowserEngine | null;
}): BrowserEngine | null {
  if (opts.remote) return "proxy";
  return opts.buildMode && opts.chosen === "webview" ? "proxy" : opts.chosen;
}

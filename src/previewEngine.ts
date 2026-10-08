import type { BrowserEngine } from "./browserBounds";

const LOOPBACK = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

function httpUrl(url: string): URL | null {
  try {
    const target = new URL(url);
    return ["http:", "https:"].includes(target.protocol) ? target : null;
  } catch {
    return null;
  }
}

/** A page served from the workspace itself, which only the workspace's own
 *  browser can reach. */
export function isWorkspaceLocalPage(url: string): boolean {
  const target = httpUrl(url);
  return !!target && (LOOPBACK.includes(target.hostname) || target.hostname.endsWith(".localhost"));
}

/** Which engine renders a preview tab. On a remote workspace every web page
 *  uses the Chrome stream: a workspace localhost page streams from the
 *  workspace's browser, any other site from this computer's Chrome (the host
 *  routes chrome_stream_open by URL). The proxy and native webview engines are
 *  desktop services the workspace does not run, so a public URL there failed
 *  with "does not support preview_start". */
export function previewEngine(opts: {
  remote: boolean;
  url: string;
  buildMode: boolean;
  chosen: BrowserEngine | null;
}): BrowserEngine | null {
  if (opts.remote && httpUrl(opts.url)) return "chrome";
  return opts.buildMode && opts.chosen === "webview" ? "proxy" : opts.chosen;
}

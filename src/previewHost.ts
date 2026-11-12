// The preview browser host: a real headless Chromium on this computer
// (packages/remote-host/preview-host.mjs, started by src-tauri/src/preview_host.rs)
// that preview tabs stream from. Cookies are first-party and each project has
// its own persistent profile, so a login holds across reloads and restarts.
//
// This module starts the host once, keeps its address, and wraps its loopback
// API. A start that fails (no Node, no Chrome) is remembered until `retry()`,
// and the preview falls back to the embedded proxy meanwhile.

import { invokeDesktop } from "./host";
import { browserStreamPath } from "./remoteExecution/browserStream";

export interface PreviewHostInfo {
  readonly port: number;
  readonly token: string;
  readonly executable: string;
}

export type PreviewHostState =
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly info: PreviewHostInfo }
  | { readonly status: "failed"; readonly error: string };

let state: PreviewHostState = { status: "starting" };
let starting: Promise<PreviewHostInfo> | null = null;
const listeners = new Set<() => void>();

const publish = (next: PreviewHostState) => {
  state = next;
  for (const listener of listeners) listener();
};

export const previewHostState = (): PreviewHostState => state;

export function subscribePreviewHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The host's address, starting it on first use. */
export function startPreviewHost(): Promise<PreviewHostInfo> {
  if (state.status === "failed") return Promise.reject(new Error(state.error));
  starting ??= invokeDesktop<PreviewHostInfo>("preview_host_start").then(
    async (info) => {
      // The app keeps the host's first line for the session, so an empty
      // executable there may be stale (Chromium was downloaded since). Ask the
      // host before saying "ready", or every new window flashes the offer.
      browserState =
        info.executable === ""
          ? await readBrowser(info).catch(() => ({ executable: "", installer: null }))
          : { executable: info.executable, installer: null };
      publish({ status: "ready", info });
      followBrowser();
      return info;
    },
    (error: unknown) => {
      const message = String((error as Error)?.message ?? error);
      publish({ status: "failed", error: message });
      throw new Error(message);
    },
  );
  return starting;
}

/** Try again after a failure (Chrome or Node was just installed). */
export function retryPreviewHost(): Promise<PreviewHostInfo> {
  starting = null;
  publish({ status: "starting" });
  return startPreviewHost();
}

/** A host that died answers nothing; the next call starts a new one. */
const forget = () => {
  starting = null;
  publish({ status: "starting" });
};

/** One profile per project, named so the host accepts it (`[A-Za-z0-9_.-]{1,64}`). */
export function previewProfile(projectId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < projectId.length; i++)
    hash = Math.imul(hash ^ projectId.charCodeAt(i), 16777619);
  const readable = projectId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return `p-${readable}-${(hash >>> 0).toString(36)}`;
}

export class PreviewHostError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return callWith<T>(await startPreviewHost(), path, init);
}

async function callWith<T>(
  info: PreviewHostInfo,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    forget();
    throw error;
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new PreviewHostError(
      response.status,
      body.error ?? `preview browser answered ${response.status}`,
    );
  return body as T;
}

/** This window's name, so the host can tell one window's tabs from another's (`retain`). */
let ownerName: Promise<string> | null = null;
const owner = () =>
  (ownerName ??= import("@tauri-apps/api/window").then(
    ({ getCurrentWindow }) => getCurrentWindow().label,
    () => "main",
  ));

export interface PreviewTabOpen {
  readonly url?: string;
  readonly profile: string;
}

/** A one-use WebSocket URL for a tab's stream; the host opens the tab if it has to. */
export async function previewStreamUrl(
  tabId: string,
  path: string,
  open: PreviewTabOpen,
): Promise<string> {
  const info = await startPreviewHost();
  const name = await owner();
  // The tab is opened first, so a page that cannot open (Chrome will not
  // launch, the profile is locked, a popup has closed) fails here with the
  // host's reason instead of as a refused upgrade the browser hides.
  await call(`/tabs/${encodeURIComponent(tabId)}/ensure`, {
    method: "POST",
    body: { ...open, owner: name, wait: false },
  });
  const { ticket } = await call<{ ticket: string }>("/tickets", {
    method: "POST",
    body: { tabId, ...open, owner: name },
  });
  const query = new URLSearchParams(
    path.includes("?") ? path.slice(path.indexOf("?") + 1) : "",
  );
  query.set("ticket", ticket);
  return `ws://127.0.0.1:${info.port}/tabs/${encodeURIComponent(tabId)}/stream?${query.toString()}`;
}

export { browserStreamPath };

/** An agent's canopy_browser_* op, run by the host on the tab's page (T3's control rules apply). */
export async function previewOp(
  tabId: string,
  op: string,
  args: Record<string, unknown>,
  open: PreviewTabOpen,
): Promise<unknown> {
  const result = await call<{ ok: boolean; data: unknown }>(
    `/tabs/${encodeURIComponent(tabId)}/op`,
    {
      method: "POST",
      body: { op, args, open },
    },
  );
  return result.data;
}

export async function closePreviewTab(tabId: string): Promise<void> {
  if (state.status !== "ready") return;
  await call(`/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" }).catch(
    () => undefined,
  );
}

/** After a reload: the host closes held tabs the IDE no longer has. */
export async function retainPreviewTabs(
  tabIds: readonly string[],
): Promise<void> {
  if (state.status !== "ready") return;
  await call("/tabs/retain", { method: "POST", body: { tabIds, owner: await owner() } }).catch(
    () => undefined,
  );
}

/** Signs a project's preview out of every site (removes its profile). */
export async function clearPreviewProfile(profile: string): Promise<void> {
  await call("/profiles/clear", { method: "POST", body: { profile } });
}

/** Every profile: what Settings › "Sign out of preview sites" does. */
export async function clearAllPreviewProfiles(): Promise<number> {
  const { profiles } = await call<{ profiles: string[] }>("/profiles");
  for (const profile of profiles) await clearPreviewProfile(profile);
  return profiles.length;
}

// ---------- tab lifetime ----------
// A preview tab's page lives in the host while the IDE holds the tab. An
// unmount closes it after a grace period, which a remount cancels. After the
// window reloads, the host is told which tabs still exist, once they have had
// time to mount, so held tabs nobody owns any more do not linger.

const CLOSE_GRACE_MS = 30_000;
const RETAIN_AFTER_MS = 15_000;
const mounted = new Set<string>();
const closing = new Map<string, ReturnType<typeof setTimeout>>();
let retained = false;

export function keepPreviewTab(tabId: string): void {
  mounted.add(tabId);
  const timer = closing.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  closing.delete(tabId);
  if (!retained) {
    retained = true;
    void startPreviewHost().then(
      () =>
        setTimeout(() => void retainPreviewTabs([...mounted]), RETAIN_AFTER_MS),
      () => {
        retained = false;
      },
    );
  }
}

export function closePreviewTabSoon(
  tabId: string,
  delayMs = CLOSE_GRACE_MS,
): void {
  mounted.delete(tabId);
  const existing = closing.get(tabId);
  if (existing !== undefined) clearTimeout(existing);
  closing.set(
    tabId,
    setTimeout(() => {
      closing.delete(tabId);
      if (!mounted.has(tabId)) void closePreviewTab(tabId);
    }, delayMs),
  );
}

// ---------- the browser the preview runs on ----------
// The host runs even on a computer with no Chrome, Edge, Chromium or Brave,
// and says so (`executable: ""`). The preview then offers Playwright's Chrome
// Headless Shell, downloaded once on request and checked against pinned
// SHA-256 digests (packages/remote-host/browser-install.mjs).

export interface PreviewInstallerStatus {
  readonly state: "missing" | "downloading" | "installed" | "failed" | "unsupported";
  readonly received: number;
  readonly total: number;
  readonly version: string;
  readonly error?: string;
}

export interface PreviewBrowserState {
  /** The browser preview tabs run on; empty until one is found or downloaded. */
  readonly executable: string;
  readonly installer: PreviewInstallerStatus | null;
}

let browserState: PreviewBrowserState | null = null;
let browserPoll: ReturnType<typeof setTimeout> | null = null;
let offerDismissed = false;
/** While a download runs. */
const BROWSER_POLL_MS = 1_000;
/** While there is no browser: another window may start the download. */
const BROWSER_IDLE_POLL_MS = 5_000;

const readBrowser = (info: PreviewHostInfo) => callWith<PreviewBrowserState>(info, "/browser");

/** Keeps reading the host's browser until there is one, faster during a download. */
function followBrowser(): void {
  if (browserPoll !== null) clearTimeout(browserPoll);
  browserPoll = null;
  if (!browserState || browserState.executable !== "") return;
  const delay = browserState.installer?.state === "downloading" ? BROWSER_POLL_MS : BROWSER_IDLE_POLL_MS;
  browserPoll = setTimeout(() => void refreshPreviewBrowser(), delay);
}

export const previewBrowserState = (): PreviewBrowserState | null => browserState;

/** Reads the host's browser and keeps following it while there is none, so
 *  every window sees a download start, progress and finish. */
export async function refreshPreviewBrowser(): Promise<PreviewBrowserState | null> {
  if (state.status !== "ready") return browserState;
  try {
    browserState = await call<PreviewBrowserState>("/browser");
    for (const listener of listeners) listener();
  } catch {
    /* the host went away; starting it again reads the browser afresh */
  }
  followBrowser();
  return browserState;
}

/** Starts the one download every window shares, then follows it. */
export async function installPreviewBrowser(): Promise<void> {
  offerDismissed = false;
  await call("/browser/install", { method: "POST" });
  await refreshPreviewBrowser();
}

/** "Not now": the offer stays hidden until the app restarts. */
export function dismissBrowserOffer(): void {
  offerDismissed = true;
  for (const listener of listeners) listener();
}

export const browserOfferDismissed = (): boolean => offerDismissed;

/** Whether the preview runs on a Chromium Canopy downloaded (Settings says so). */
export const usesDownloadedChromium = (state: PreviewBrowserState | null): boolean =>
  !!state?.executable && /chromium_headless_shell-/.test(state.executable);

// The desktop's preview browser: a real headless Chromium on this computer,
// with persistent profiles, streamed into Canopy's preview tabs. This is T3
// Code's server browser (pingdotgg/t3code apps/server/src/preview, MIT) on the
// pieces already ported for the workspace agent browser: AgentBrowser
// (ServerBrowser.ts), SessionControl, BrowserContexts and the stream
// (ServerBrowserStream.ts). The pane is a viewer of a page this process owns,
// so cookies are first-party, logins survive restarts, and the agent drives
// the same page the person is looking at.
//
// What this file adds is T3's tab layer for Canopy's preview tabs:
// - tabs keyed by the IDE's tab id, each an AgentBrowser on a shared
//   BrowserContexts, so tabs on one profile share cookies like T3's tabs;
// - T3's launch options (no automation banner or flag, a Chrome identity in
//   place of HeadlessChrome, 2x rendering, the sandbox left on);
// - T3's tab limit and idle sweep, popups as tabs (sign-in popups keep
//   `window.opener`), and one shared shutdown.
//
// Started by the desktop app (src-tauri/src/preview_host.rs). It prints one
// JSON line, `{port, token}` or `{error, code}`, and exits when stdin closes.
// Everything listens on loopback only. HTTP needs `Authorization: Bearer
// <token>`; the stream WebSocket takes a one-use ticket from POST /tickets,
// since a WebSocket cannot carry headers. Requests from a browser origin are
// refused unless the origin is the app's own (CANOPY_PREVIEW_ORIGINS).
import http from 'node:http';
import os from 'node:os';
import { access, constants, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AgentBrowser } from './agent-browser.mjs';
import { BrowserContexts } from './browser-contexts.mjs';
import { TAB_GONE_CODE, browserStreamServer, handleBrowserStream } from './browser-stream.mjs';

// T3's constants (ServerBrowser.ts).
export const SERVER_TAB_LIMIT = 32;
// T3's AGENT_TAB_IDLE_MS. It applies only to tabs no IDE tab holds (an unwatched
// popup, a tab the IDE forgot): a person's background preview keeps its page.
export const TAB_IDLE_MS = 30 * 60 * 1000;
// A profile's Chromium with no tab left exits after this long. Cookies without
// an expiry die with it, as they do when any Chrome quits.
export const PROFILE_IDLE_MS = 30 * 60 * 1000;
export const IDLE_SWEEP_MS = 60 * 1000;
export const TICKET_TTL_MS = 30 * 1000;
export const DEFAULT_PROFILE = 'default';
const VIEWPORT = { width: 1280, height: 800 };
const MAX_BODY_BYTES = 1024 * 1024;
const constVoid = () => undefined;

/** Where Chrome-family browsers live, most likely first. CANOPY_CHROMIUM_EXECUTABLE wins. */
export function chromeCandidates(platform = process.platform, env = process.env) {
  const own = env.CANOPY_CHROMIUM_EXECUTABLE ? [env.CANOPY_CHROMIUM_EXECUTABLE] : [];
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];
    const home = env.HOME ?? os.homedir();
    return [...own, ...apps.flatMap(app => [join('/Applications', app), join(home, 'Applications', app)])];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const apps = [
      'Google/Chrome/Application/chrome.exe',
      'Microsoft/Edge/Application/msedge.exe',
      'Chromium/Application/chrome.exe',
      'BraveSoftware/Brave-Browser/Application/brave.exe',
    ];
    return [...own, ...roots.flatMap(root => apps.map(app => join(root, app)))];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
  const dirs = (env.PATH ?? '/usr/bin:/usr/local/bin').split(':').concat(['/usr/bin', '/snap/bin', '/opt/google/chrome']);
  return [...own, ...[...new Set(dirs)].flatMap(dir => names.map(name => join(dir, name)))];
}

export async function findChrome(platform, env) {
  for (const candidate of chromeCandidates(platform, env)) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

const UA_PLATFORMS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
/** T3's chromeIdentity: change the user agent and Sec-CH-UA together; sites block mismatches. */
export function chromeIdentity(headlessUserAgent, host = { platform: process.platform, arch: process.arch, release: os.release() }) {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = names => [
    { brand: 'Chromium', version: names(major) },
    { brand: 'Google Chrome', version: names(major) },
    { brand: 'Not A(Brand', version: names('99') },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands(value => value),
      fullVersionList: brands(value => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? 'Unknown',
      platformVersion: host.platform === 'linux' ? host.release : '',
      architecture: host.arch.startsWith('arm') ? 'arm' : 'x86',
      bitness: host.arch.endsWith('64') ? '64' : '32',
      model: '',
      mobile: false,
      wow64: false,
    },
  };
}

/** T3's launchOptions. Only an explicit opt-out disables the sandbox. */
export function launchOptions(executablePath, env = process.env) {
  return {
    executablePath,
    headless: true,
    args: ['--disable-gpu', '--force-device-scale-factor=2', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    chromiumSandbox: env.CANOPY_PREVIEW_NO_SANDBOX !== '1',
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  };
}

const httpUrl = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && value.length <= 8192 ? url.href : null;
  } catch {
    return null;
  }
};
const POPUP_PREFIX = 'popup-';
const isPopupId = id => typeof id === 'string' && id.startsWith(POPUP_PREFIX);
const validTabId = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);
const validProfile = id => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(id) && id !== '.' && id !== '..';

export class PreviewHost {
  /**
   * @param {{
   *   profilesDir: string, executablePath: string, picker: string|URL,
   *   launch?: (directory: string) => Promise<import('playwright-core').BrowserContext>,
   *   timeoutMs?: number, tabLimit?: number, idleMs?: number, now?: () => number,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.tabs = new Map();
    this.tabLimit = options.tabLimit ?? SERVER_TAB_LIMIT;
    this.idleMs = options.idleMs ?? TAB_IDLE_MS;
    this.profileIdleMs = options.profileIdleMs ?? PROFILE_IDLE_MS;
    /** profile -> when its last tab closed */
    this.emptySince = new Map();
    this.now = options.now ?? Date.now;
    const launch = options.launch ?? (async directory => {
      const { chromium } = createRequire(import.meta.url)('playwright-core');
      return chromium.launchPersistentContext(directory, launchOptions(options.executablePath));
    });
    this.contexts = new BrowserContexts({
      profilesDir: options.profilesDir,
      launch,
      // Chromium exited: every tab on that profile is gone.
      onContextClose: context => {
        for (const entry of [...this.tabs.values()]) entry.browser.contextClosed(context);
      },
    });
  }

  /** T3's ensureTab: the tab if it exists, else a new one (opened at `url` when given). */
  async ensure(tabId, { url, profile = DEFAULT_PROFILE, adopt, openerId, held = !adopt, wait = true, owner } = {}) {
    if (!validTabId(tabId)) throw Object.assign(new Error('invalid tab id'), { status: 400 });
    // A popup exists only as the page that opened it; one that has closed is gone, not blank.
    if (!adopt && isPopupId(tabId) && !this.tabs.has(tabId)) throw Object.assign(new Error('The sign-in window closed.'), { status: 404 });
    if (!validProfile(profile)) throw Object.assign(new Error('invalid profile'), { status: 400 });
    let entry = this.tabs.get(tabId);
    if (entry && entry.profile !== profile) {
      await this.close(tabId);
      entry = undefined;
    }
    if (!entry) {
      if (this.tabs.size >= this.tabLimit) {
        throw Object.assign(new Error(`Canopy's preview browser has ${this.tabLimit} tabs open. Close one to open another.`), { status: 429 });
      }
      const browser = new AgentBrowser({
        contexts: this.contexts,
        profile,
        adopt,
        picker: this.options.picker,
        timeoutMs: this.options.timeoutMs,
        label: 'preview browser',
        onPopup: (popup, tab) => this.adoptPopup(tabId, profile, popup, tab),
        onClosed: () => {
          if (this.tabs.get(tabId)?.browser === browser) this.tabs.delete(tabId);
          this.noteEmpty(profile);
        },
        prepareTab: tab => this.presentAsChrome(tab),
        autoControl: true,
        ...(this.options.autoReleaseMs ? { autoReleaseMs: this.options.autoReleaseMs } : {}),
        fileChooser: true,
      });
      this.emptySince.delete(profile);
      entry = { browser, profile, usedAt: this.now(), openerId, held, opened: browser.open() };
      this.tabs.set(tabId, entry);
      try {
        await entry.opened;
      } catch (error) {
        if (this.tabs.get(tabId) === entry) this.tabs.delete(tabId);
        this.noteEmpty(profile);
        // Chromium's SingletonLock: another Canopy (a dev build beside a release) holds this profile.
        if (/ProcessSingleton|SingletonLock|profile (?:directory )?is (?:already )?in use/i.test(String(error?.message))) {
          throw Object.assign(new Error('Another copy of Canopy is using this preview profile. Close it, or its preview tabs, and try again.'), { status: 409 });
        }
        throw error;
      }
      const target = url && httpUrl(url);
      if (target && !adopt) {
        // A viewer attaching waits for the tab, not for the page to load.
        const navigating = browser.run('navigate', { url: target }).catch(constVoid);
        if (wait) await navigating;
      }
    }
    if (held) entry.held = true;
    if (owner) entry.owner = owner;
    entry.usedAt = this.now();
    return entry;
  }

  noteEmpty(profile) {
    if (![...this.tabs.values()].some(entry => entry.profile === profile)) this.emptySince.set(profile, this.now());
  }

  async presentAsChrome(tab) {
    const { userAgent } = await tab.cdp.send('Browser.getVersion');
    const identity = chromeIdentity(userAgent);
    if (identity) await tab.cdp.send('Emulation.setUserAgentOverride', identity);
  }

  /** T3's adoptPopup: a popup becomes its own tab, and the opener's viewers are told. */
  async adoptPopup(openerId, profile, popup, openerTab) {
    if (openerTab.closing) {
      await popup.close().catch(constVoid);
      return;
    }
    const tabId = `${POPUP_PREFIX}${randomUUID()}`;
    try {
      await this.ensure(tabId, { profile, adopt: popup, openerId });
    } catch {
      await popup.close().catch(constVoid);
      return;
    }
    const url = popup.url();
    // T3 tells only the viewer controlling the opener, so a popup the agent
    // opened never takes over a person's pane.
    const controller = [...openerTab.viewers].find(viewer => viewer.id === openerTab.control.controller);
    controller?.push({ _tag: 'popup', tabId, openerId, url: /^https?:/i.test(url) ? url : '' });
  }

  /** An op on a tab. `open` ({url, profile}) recreates a tab the host no longer has; without it an unknown tab is a 404. */
  async run(tabId, op, args, open) {
    if (!this.tabs.has(tabId) && !open) throw Object.assign(new Error('This preview tab is not open in the preview browser.'), { status: 404 });
    const entry = await this.ensure(tabId, open ?? { profile: this.tabs.get(tabId).profile });
    entry.usedAt = this.now();
    try {
      return await entry.browser.run(op, args);
    } finally {
      entry.usedAt = this.now();
    }
  }

  async close(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry) return false;
    this.tabs.delete(tabId);
    await entry.browser.close().catch(constVoid);
    this.noteEmpty(entry.profile);
    return true;
  }

  /** One IDE window's tabs after it reloads: held tabs that window no longer has close. Other windows' tabs are theirs. */
  async retain(tabIds, owner) {
    const keep = new Set(tabIds);
    for (const [tabId, entry] of [...this.tabs]) {
      if (owner !== undefined && entry.owner !== owner) continue;
      if (entry.held && !keep.has(tabId) && !(entry.openerId && keep.has(entry.openerId))) await this.close(tabId);
    }
  }

  list() {
    return [...this.tabs].map(([tabId, entry]) => {
      const page = entry.browser.current?.page;
      return { tabId, profile: entry.profile, openerId: entry.openerId ?? null, held: !!entry.held, url: page && !page.isClosed() ? page.url() : null, viewers: entry.browser.current?.viewers.size ?? 0 };
    });
  }

  /** T3's idle sweep: a tab nobody watches or drives for a while closes. Its profile, and so its logins, stay. */
  async sweep() {
    const now = this.now();
    for (const [tabId, entry] of [...this.tabs]) {
      if ((entry.browser.current?.viewers.size ?? 0) > 0) {
        entry.usedAt = now;
        continue;
      }
      if (!entry.held && now - entry.usedAt >= this.idleMs) await this.close(tabId);
    }
    for (const [profile, since] of [...this.emptySince]) {
      if (now - since < this.profileIdleMs) continue;
      this.emptySince.delete(profile);
      if (![...this.tabs.values()].some(entry => entry.profile === profile)) await this.contexts.closeProfile(profile);
    }
  }

  /** Profiles that exist on disk or are open (Settings signs every one of them out). */
  async profiles() {
    const onDisk = await readdir(this.options.profilesDir, { withFileTypes: true }).then(
      entries => entries.filter(entry => entry.isDirectory()).map(entry => decodeURIComponent(entry.name)),
      () => [],
    );
    return [...new Set([...onDisk, ...[...this.tabs.values()].map(entry => entry.profile)])].filter(validProfile);
  }

  /** Signs a profile out: closes its tabs, then removes the profile directory. */
  async clearProfile(profile = DEFAULT_PROFILE) {
    if (!validProfile(profile)) throw Object.assign(new Error('invalid profile'), { status: 400 });
    for (const [tabId, entry] of [...this.tabs]) if (entry.profile === profile) await this.close(tabId);
    await this.contexts.clearProfile(profile);
  }

  async shutdown() {
    await Promise.allSettled([...this.tabs.keys()].map(tabId => this.close(tabId)));
    await this.contexts.close();
  }
}

const sameSecret = (given, token) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readJson = request => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('body too large'), { status: 413 }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (!chunks.length) return resolve({});
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
    }
  });
  request.on('error', reject);
});

/**
 * The loopback HTTP and WebSocket front of a PreviewHost.
 * @param {PreviewHost} host
 * @param {{token: string, origins?: string[], now?: () => number}} options
 */
export function createPreviewServer(host, { token, origins = [], now = Date.now }) {
  const tickets = new Map();
  const wss = browserStreamServer();
  const allowedOrigin = origin => origin === undefined || origins.includes(origin);
  const cors = (request, response) => {
    const origin = request.headers.origin;
    if (origin && origins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      response.setHeader('Access-Control-Max-Age', '600');
    }
  };
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    cors(request, response);
    if (!allowedOrigin(request.headers.origin)) return send(response, 403, { error: 'origin not allowed' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!sameSecret(bearer, token)) return send(response, 401, { error: 'unauthorized' });
    const { pathname } = new URL(request.url, 'http://preview-host');
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (request.method === 'GET' && pathname === '/health') return send(response, 200, { ok: true, tabs: host.tabs.size });
      if (request.method === 'GET' && pathname === '/tabs') return send(response, 200, { tabs: host.list() });
      if (request.method === 'GET' && pathname === '/profiles') return send(response, 200, { profiles: await host.profiles() });
      if (request.method === 'POST' && pathname === '/tickets') {
        const body = await readJson(request);
        if (!validTabId(body.tabId)) return send(response, 400, { error: 'invalid tab id' });
        const ticket = randomBytes(24).toString('base64url');
        tickets.set(ticket, { tabId: body.tabId, url: typeof body.url === 'string' ? body.url : undefined, profile: typeof body.profile === 'string' ? body.profile : undefined, owner: typeof body.owner === 'string' ? body.owner : undefined, expires: now() + TICKET_TTL_MS });
        return send(response, 200, { ticket });
      }
      if (request.method === 'POST' && pathname === '/tabs/retain') {
        const body = await readJson(request);
        if (!Array.isArray(body.tabIds) || !body.tabIds.every(validTabId)) return send(response, 400, { error: 'tabIds must be tab ids' });
        await host.retain(body.tabIds, typeof body.owner === 'string' ? body.owner : undefined);
        return send(response, 200, { tabs: host.list() });
      }
      if (request.method === 'POST' && pathname === '/profiles/clear') {
        const body = await readJson(request);
        await host.clearProfile(body.profile ?? DEFAULT_PROFILE);
        return send(response, 200, { ok: true });
      }
      if (parts[0] === 'tabs' && parts.length >= 2) {
        const tabId = parts[1];
        if (request.method === 'DELETE' && parts.length === 2) return send(response, 200, { closed: await host.close(tabId) });
        if (request.method === 'POST' && parts[2] === 'ensure') {
          const body = await readJson(request);
          const known = host.tabs.get(tabId);
          const entry = await host.ensure(tabId, {
            url: body.url,
            wait: body.wait !== false,
            ...(typeof body.owner === 'string' ? { owner: body.owner } : {}),
            ...(body.profile ? { profile: body.profile } : known ? { profile: known.profile } : {}),
          });
          const page = entry.browser.current?.page;
          return send(response, 200, { tabId, url: page?.url() ?? null, title: page ? await page.title().catch(() => '') : '' });
        }
        if (request.method === 'POST' && parts[2] === 'op') {
          const body = await readJson(request);
          const open = body.open && typeof body.open === 'object' ? { url: body.open.url, ...(body.open.profile ? { profile: body.open.profile } : {}) } : undefined;
          const data = await host.run(tabId, body.op, body.args ?? {}, open);
          return send(response, 200, { ok: true, data });
        }
      }
      return send(response, 404, { error: 'not found' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return send(response, status, { ok: false, error: String(error?.message ?? error).slice(0, 2000) });
    }
  });
  server.on('upgrade', (request, socket, head) => {
    const refuse = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!allowedOrigin(request.headers.origin)) return refuse('403 Forbidden');
    const url = new URL(request.url, 'http://preview-host');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 3 || parts[0] !== 'tabs' || parts[2] !== 'stream') return refuse('404 Not Found');
    const ticket = url.searchParams.get('ticket') ?? '';
    const grant = tickets.get(ticket);
    tickets.delete(ticket);
    if (!grant || grant.expires < now() || grant.tabId !== parts[1]) return refuse('401 Unauthorized');
    // A popup's viewer attaches to the popup the host already holds.
    const known = host.tabs.get(grant.tabId);
    void host.ensure(grant.tabId, { url: grant.url, wait: false, held: !known || known.held, ...(grant.owner ? { owner: grant.owner } : {}), ...(grant.profile ? { profile: grant.profile } : known ? { profile: known.profile } : {}) }).then(
      entry => handleBrowserStream(entry.browser, wss, request, socket, head),
      error => {
        // A tab that cannot exist (a closed popup) is a close code the viewer stops on.
        if (error?.status === 404) {
          if (!socket.destroyed) wss.handleUpgrade(request, socket, head, ws => ws.close(TAB_GONE_CODE, 'tab closed'));
          return;
        }
        console.warn(`Preview tab failed to open: ${String(error?.message ?? error).slice(0, 200)}`);
        if (!socket.destroyed) refuse(error?.status === 429 ? '429 Too Many Requests' : '503 Service Unavailable');
      },
    );
  });
  // Expired tickets never accumulate.
  const prune = setInterval(() => {
    const at = now();
    for (const [ticket, grant] of tickets) if (grant.expires < at) tickets.delete(ticket);
  }, TICKET_TTL_MS);
  prune.unref();
  server.on('close', () => clearInterval(prune));
  return server;
}

/** The process entry: find Chrome, listen on loopback, print `{port, token}`, exit when stdin closes. */
export async function main({ env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  const print = value => stdout.write(`${JSON.stringify(value)}\n`);
  const executablePath = await findChrome(process.platform, env);
  if (!executablePath) {
    print({ code: 'no-chrome', error: 'No Chrome, Edge, Chromium or Brave was found on this computer.' });
    return 1;
  }
  const home = env.HOME ?? os.homedir();
  const host = new PreviewHost({
    profilesDir: env.CANOPY_PREVIEW_PROFILES ?? join(home, '.canopy', 'preview-browser', 'profiles'),
    executablePath,
    picker: env.CANOPY_PREVIEW_PICKER ?? new URL('./preview_picker.js', import.meta.url),
  });
  // One failed page call must not take every tab down with the process.
  process.on('unhandledRejection', error => console.warn(`Preview browser: ${String(error?.stack ?? error).slice(0, 2000)}`));
  const token = randomBytes(32).toString('base64url');
  const origins = (env.CANOPY_PREVIEW_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  const server = createPreviewServer(host, { token, origins });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const sweep = setInterval(() => void host.sweep(), IDLE_SWEEP_MS);
  let stopping;
  const stop = () => (stopping ??= (async () => {
    clearInterval(sweep);
    server.close();
    await host.shutdown();
    process.exit(0);
  })());
  stdin.on('end', stop);
  stdin.on('close', stop);
  stdin.resume();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  print({ port: server.address().port, token, executable: executablePath });
  return 0;
}

// Compared as real paths: the bundle may be reached through a symlink (macOS /var is /private/var).
const isEntry = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntry()) {
  main().then(code => { if (code) process.exit(code); }, error => {
    process.stdout.write(`${JSON.stringify({ code: 'failed', error: String(error?.message ?? error).slice(0, 500) })}\n`);
    process.exit(1);
  });
}
export const PREVIEW_HOST_FILE = fileURLToPath(import.meta.url);

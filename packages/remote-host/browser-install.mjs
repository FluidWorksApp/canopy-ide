// The preview browser's on-demand Chromium: Playwright's Chrome Headless Shell,
// downloaded once, only when a person asks for it on a computer with no
// Chrome, Edge, Chromium or Brave (preview-host.mjs).
//
// Playwright's installer downloads over HTTPS, unzips and writes its
// INSTALLATION_COMPLETE marker, but checks no digest. So it is pointed at a
// loopback server here (PLAYWRIGHT_DOWNLOAD_HOST) that serves only the
// archives pinned in browser-pins.json: each one is fetched from Playwright's
// CDN, hashed while it streams, and refused unless its SHA-256 matches. The
// unzip and the marker stay Playwright's, at the version our playwright-core
// expects. Progress is this server's own byte count.
//
// The pins are tied to playwright-core's browsers.json by a test, so a
// playwright-core bump fails until `node scripts/pin-preview-chromium.mjs`
// re-pins them. The new version is then offered again.
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export const UPSTREAM = 'https://cdn.playwright.dev';
const constVoid = () => undefined;
const require = createRequire(import.meta.url);

export const loadPins = (file = new URL('./browser-pins.json', import.meta.url)) => JSON.parse(readFileSync(file, 'utf8'));

/** Playwright's platform directory for this computer, or null where no headless shell is published. */
export function platformKey(platform = process.platform, arch = process.arch, release = os.release()) {
  if (platform === 'darwin') {
    // Playwright publishes no headless shell before macOS 14 (Darwin 23).
    if (Number.parseInt(release, 10) < 23) return null;
    return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : arch === 'x64' ? 'linux64' : null;
  if (platform === 'win32') return arch === 'x64' ? 'win64' : null;
  return null;
}

const SHELL_FILES = {
  'mac-arm64': ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
  'mac-x64': ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
  'linux64': ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
  'linux-arm64': ['chrome-headless-shell-linux-arm64', 'chrome-headless-shell'],
  'win64': ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
};

/** The pinned archives this platform downloads, with their sizes. */
export function pinnedFiles(pins, key) {
  if (!key) return [];
  return Object.entries(pins.files)
    .filter(([path]) => path.includes(`/${key}/`) || path.endsWith(`/${FFMPEG_NAMES[key]}`))
    .map(([path, pin]) => ({ path, ...pin }));
}
const FFMPEG_NAMES = {
  'mac-arm64': 'ffmpeg-mac-arm64.zip',
  'mac-x64': 'ffmpeg-mac.zip',
  'linux64': 'ffmpeg-linux.zip',
  'linux-arm64': 'ffmpeg-linux-arm64.zip',
  'win64': 'ffmpeg-win64.zip',
};

/** Runs Playwright's own installer against the verifying download host. */
export function playwrightInstaller({ browsersDir, downloadHost, signal, onOutput }) {
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir, PLAYWRIGHT_DOWNLOAD_HOST: downloadHost },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const kill = () => child.kill();
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', chunk => onOutput?.(String(chunk)));
    child.stderr.on('data', chunk => onOutput?.(String(chunk)));
    child.on('error', reject);
    child.on('exit', code => {
      signal?.removeEventListener('abort', kill);
      if (code === 0) resolve();
      else reject(new Error(`the Chromium installer exited with ${code}`));
    });
  });
}

export class BrowserInstaller {
  /**
   * @param {{
   *   browsersDir: string, pins?: ReturnType<typeof loadPins>, upstream?: string,
   *   key?: string|null, runInstaller?: typeof playwrightInstaller,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.pins = options.pins ?? loadPins();
    this.key = options.key !== undefined ? options.key : platformKey();
    this.upstream = options.upstream ?? UPSTREAM;
    this.runInstaller = options.runInstaller ?? playwrightInstaller;
    this.files = pinnedFiles(this.pins, this.key);
    this.total = this.files.reduce((sum, file) => sum + file.bytes, 0);
    this.state = this.executable() ? 'installed' : this.key && this.files.length ? 'missing' : 'unsupported';
    this.received = 0;
    this.error = null;
    this.running = null;
    this.abort = null;
  }

  /** Where Playwright puts this revision, and the binary inside it. */
  get browserDir() {
    return join(this.options.browsersDir, `chromium_headless_shell-${this.pins.revision}`);
  }

  /** The downloaded shell, once Playwright has marked it complete. */
  executable() {
    const files = this.key && SHELL_FILES[this.key];
    if (!files) return null;
    const binary = join(this.browserDir, ...files);
    return existsSync(join(this.browserDir, 'INSTALLATION_COMPLETE')) && existsSync(binary) ? binary : null;
  }

  status() {
    return {
      state: this.state,
      received: this.received,
      total: this.total,
      version: this.pins.browserVersion,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Single-flight: every caller waits on the same download. Resolves to the binary. */
  install() {
    if (this.state === 'installed') return Promise.resolve(this.executable());
    if (this.state === 'unsupported') return Promise.reject(new Error('Chromium is not available for this computer. Install Google Chrome instead.'));
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async run() {
    this.state = 'downloading';
    this.received = 0;
    this.error = null;
    const abort = new AbortController();
    this.abort = abort;
    // A run cut short (the app quit mid-download) leaves archives and a
    // half-extracted folder behind; neither is ever used, so they go first.
    await rm(join(this.options.browsersDir, '.downloads'), { recursive: true, force: true }).catch(constVoid);
    if (!this.executable()) await rm(this.browserDir, { recursive: true, force: true }).catch(constVoid);
    const staging = join(this.options.browsersDir, '.downloads', randomUUID());
    await mkdir(staging, { recursive: true });
    let refused = null;
    const verified = new Map();
    const fetchVerified = async pin => {
      const target = join(staging, pin.path.replaceAll('/', '_'));
      const response = await fetch(`${this.upstream}/${pin.path}`, { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`Chromium download failed (HTTP ${response.status}).`);
      const digest = createHash('sha256');
      const count = new Transform({
        transform: (chunk, _encoding, done) => {
          digest.update(chunk);
          this.received += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), count, createWriteStream(target));
      if (digest.digest('hex') !== pin.sha256) throw new Error('The Chromium download did not match its pinned checksum, so it was not installed.');
      return target;
    };
    const server = http.createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, 'http://download').pathname.slice(1));
      const pin = this.files.find(file => file.path === path);
      if (!pin) {
        response.writeHead(404).end();
        return;
      }
      if (!verified.has(path)) verified.set(path, fetchVerified(pin));
      verified.get(path).then(
        async target => {
          const { size } = await stat(target);
          response.writeHead(200, { 'content-type': 'application/zip', 'content-length': size });
          createReadStream(target).pipe(response);
        },
        error => {
          refused ??= error;
          response.writeHead(502).end();
          // Playwright retries five times; a refused archive must stop it now.
          abort.abort();
        },
      );
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      let output = '';
      await this.runInstaller({
        browsersDir: this.options.browsersDir,
        downloadHost: `http://127.0.0.1:${server.address().port}`,
        signal: abort.signal,
        onOutput: text => {
          output = (output + text).slice(-2000);
        },
      }).catch(error => {
        throw refused ?? (abort.signal.aborted ? new Error('The Chromium download was stopped.') : new Error(lastLine(output) || error.message));
      });
      const binary = this.executable();
      if (!binary) throw new Error('Chromium downloaded but did not install.');
      this.state = 'installed';
      this.received = this.total;
      return binary;
    } catch (error) {
      this.state = 'failed';
      this.error = String(error?.message ?? error).slice(0, 500);
      throw error;
    } finally {
      this.abort = null;
      server.close();
      server.closeAllConnections?.();
      await rm(staging, { recursive: true, force: true }).catch(constVoid);
    }
  }

  /** Stops a download in progress (the host is shutting down). */
  stop() {
    this.abort?.abort();
  }
}

const lastLine = text =>
  text
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(line => line && !/^\|/.test(line))
    .at(-1)
    ?.slice(0, 300) ?? '';

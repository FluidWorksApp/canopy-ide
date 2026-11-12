// The preview browser's on-demand Chromium (browser-install.mjs): pins match
// the playwright-core this package ships, only pinned archives are served, a
// download that does not match its SHA-256 is refused, and concurrent asks
// share one download. The real download is opt-in
// (CANOPY_TEST_REAL_CHROMIUM_DOWNLOAD=1) and never runs in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserInstaller, loadPins, pinnedFiles, platformKey } from './browser-install.mjs';

const require = createRequire(import.meta.url);

test('the pins match the playwright-core this package ships, for every platform', async () => {
  const browsers = JSON.parse(await readFile(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8')).browsers;
  const shell = browsers.find(browser => browser.name === 'chromium-headless-shell');
  const ffmpeg = browsers.find(browser => browser.name === 'ffmpeg');
  const pins = loadPins();
  // A playwright-core bump fails here until `node scripts/pin-preview-chromium.mjs` re-pins.
  assert.equal(pins.browserVersion, shell.browserVersion);
  assert.equal(pins.revision, shell.revision);
  assert.equal(pins.ffmpegRevision, ffmpeg.revision);
  for (const key of ['mac-arm64', 'mac-x64', 'linux64', 'linux-arm64', 'win64']) {
    const files = pinnedFiles(pins, key);
    assert.equal(files.length, 2, `${key} pins the shell and ffmpeg`);
    for (const file of files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test('platforms map to Playwright\'s builds; old macOS and 32-bit have none', () => {
  assert.equal(platformKey('darwin', 'arm64', '24.0.0'), 'mac-arm64');
  assert.equal(platformKey('darwin', 'x64', '23.1.0'), 'mac-x64');
  assert.equal(platformKey('darwin', 'arm64', '22.6.0'), null, 'macOS 13');
  assert.equal(platformKey('linux', 'x64'), 'linux64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(platformKey('win32', 'x64'), 'win64');
  assert.equal(platformKey('win32', 'ia32'), null);
  assert.equal(platformKey('freebsd', 'x64'), null);
});

/** A stand-in CDN and the pins for what it serves. */
async function fakeCdn(bodies) {
  const served = new Map(Object.entries(bodies));
  const server = http.createServer((request, response) => {
    const body = served.get(request.url.slice(1));
    if (!body) return response.writeHead(404).end();
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, served, upstream: `http://127.0.0.1:${server.address().port}` };
}

const sha = body => createHash('sha256').update(body).digest('hex');
const SHELL = 'builds/cft/1.0/mac-arm64/chrome-headless-shell-mac-arm64.zip';
const FFMPEG = 'builds/ffmpeg/9/ffmpeg-mac-arm64.zip';

/** Stands in for Playwright's installer: downloads from the host it is given, then installs. */
const fakeInstaller = calls => async ({ browsersDir, downloadHost }) => {
  calls.push(downloadHost);
  for (const path of [SHELL, FFMPEG]) {
    const response = await fetch(`${downloadHost}/${path}`);
    if (!response.ok) throw new Error(`download failed ${response.status}`);
    await response.arrayBuffer();
  }
  // Anything unpinned is refused.
  assert.equal((await fetch(`${downloadHost}/builds/other.zip`)).status, 404);
  const dir = join(browsersDir, 'chromium_headless_shell-7', 'chrome-headless-shell-mac-arm64');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'chrome-headless-shell'), 'binary');
  await writeFile(join(browsersDir, 'chromium_headless_shell-7', 'INSTALLATION_COMPLETE'), '');
};

test('one verified download serves every caller, and a mismatch is refused, then retried', async () => {
  const browsersDir = await mkdtemp(join(tmpdir(), 'canopy-browsers-'));
  const shell = Buffer.alloc(300_000, 1);
  const ffmpeg = Buffer.alloc(1_000, 2);
  const cdn = await fakeCdn({ [SHELL]: Buffer.alloc(300_000, 9), [FFMPEG]: ffmpeg });
  const pins = {
    browserVersion: '1.0', revision: '7', ffmpegRevision: '9',
    files: { [SHELL]: { sha256: sha(shell), bytes: shell.length }, [FFMPEG]: { sha256: sha(ffmpeg), bytes: ffmpeg.length } },
  };
  const calls = [];
  const installer = new BrowserInstaller({ browsersDir, pins, key: 'mac-arm64', upstream: cdn.upstream, runInstaller: fakeInstaller(calls) });
  try {
    assert.equal(installer.status().state, 'missing');
    assert.equal(installer.status().total, 301_000);

    // The CDN serves bytes that do not match the pin: nothing is installed.
    await assert.rejects(installer.install(), /did not match its pinned checksum/);
    assert.equal(installer.status().state, 'failed');
    assert.match(installer.status().error, /checksum/);
    assert.equal(installer.executable(), null);

    // The right bytes, two callers at once: one download, both get the binary.
    cdn.served.set(SHELL, shell);
    calls.length = 0;
    const [first, second] = await Promise.all([installer.install(), installer.install()]);
    assert.equal(calls.length, 1);
    assert.equal(first, second);
    assert.match(first, /chromium_headless_shell-7\/chrome-headless-shell-mac-arm64\/chrome-headless-shell$/);
    assert.deepEqual(installer.status(), { state: 'installed', received: 301_000, total: 301_000, version: '1.0' });
    // Staged archives are not kept.
    assert.equal((await readFile(first, 'utf8')), 'binary');

    // A new installer finds the finished install on disk.
    assert.equal(new BrowserInstaller({ browsersDir, pins, key: 'mac-arm64' }).status().state, 'installed');
  } finally {
    cdn.server.close();
    await rm(browsersDir, { recursive: true, force: true });
  }
});

test('a computer with no published build is told so instead of downloading', async () => {
  const installer = new BrowserInstaller({ browsersDir: '/nonexistent', key: null });
  assert.equal(installer.status().state, 'unsupported');
  await assert.rejects(installer.install(), /Install Google Chrome instead/);
});

test('the real Chromium download installs and launches', { skip: process.env.CANOPY_TEST_REAL_CHROMIUM_DOWNLOAD === '1' ? false : 'opt-in: CANOPY_TEST_REAL_CHROMIUM_DOWNLOAD=1', timeout: 600_000 }, async () => {
  const browsersDir = await mkdtemp(join(tmpdir(), 'canopy-browsers-real-'));
  try {
    const installer = new BrowserInstaller({ browsersDir });
    const binary = await installer.install();
    assert.equal(installer.status().state, 'installed');
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ executablePath: binary, headless: true });
    const page = await browser.newPage();
    await page.setContent('<p>ok</p>');
    assert.equal(await page.textContent('p'), 'ok');
    await browser.close();
  } finally {
    await rm(browsersDir, { recursive: true, force: true });
  }
});

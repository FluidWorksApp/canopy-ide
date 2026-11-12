// The desktop preview browser against a real Chromium: the login contract
// (first-party cookies survive reloads, other tabs and a restart), sign-in
// popups, Chrome's identity, closing one tab, and the loopback API's locks.
// Skipped where no Chromium is installed (CANOPY_CHROMIUM_EXECUTABLE or the
// usual install locations).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PreviewHost, chromeCandidates, chromeIdentity, createPreviewServer, findChrome, launchOptions } from './preview-host.mjs';

const PICKER = new URL('../../src-tauri/src/preview_picker.js', import.meta.url);
const CHROMIUM = await findChrome(process.platform, process.env);

test('chromeIdentity drops HeadlessChrome and keeps Sec-CH-UA consistent', () => {
  const identity = chromeIdentity('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.33 Safari/537.36', { platform: 'darwin', arch: 'arm64', release: '24.0.0' });
  assert.equal(identity.userAgent, 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  assert.equal(identity.userAgentMetadata.platform, 'macOS');
  assert.equal(identity.userAgentMetadata.architecture, 'arm');
  assert.deepEqual(identity.userAgentMetadata.fullVersionList.find(brand => brand.brand === 'Google Chrome'), { brand: 'Google Chrome', version: '131.0.6778.33' });
  assert.equal(chromeIdentity('Mozilla/5.0 Chrome/131.0.0.0'), null);
});

test('launch options are T3\'s: sandboxed, no automation flag, 2x', () => {
  const options = launchOptions('/x/chrome', {});
  assert.equal(options.chromiumSandbox, true);
  assert.deepEqual(options.ignoreDefaultArgs, ['--enable-automation']);
  assert.ok(options.args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(!options.args.includes('--no-sandbox'));
  assert.equal(options.deviceScaleFactor, 2);
  assert.equal(launchOptions('/x/chrome', { CANOPY_PREVIEW_NO_SANDBOX: '1' }).chromiumSandbox, false);
});

test('Chrome candidates cover each platform and honour the override', () => {
  assert.ok(chromeCandidates('darwin', { HOME: '/Users/a' }).includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(chromeCandidates('win32', { PROGRAMFILES: 'C:/Program Files' }).some(path => path.endsWith('msedge.exe')));
  assert.ok(chromeCandidates('linux', { PATH: '/usr/bin' }).includes('/usr/bin/chromium'));
  assert.equal(chromeCandidates('linux', { CANOPY_CHROMIUM_EXECUTABLE: '/opt/c', PATH: '' })[0], '/opt/c');
});

/** A site with a login, a page that reports what it sees, and a sign-in popup. */
async function site() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const html = body => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<!doctype html><title>t</title><body>${body}</body>`); };
    if (url.pathname === '/login') {
      response.setHeader('set-cookie', [
        'sid=persisted; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=3600',
        'sess=session-only; HttpOnly; Path=/',
      ]);
      return html('logged in');
    }
    if (url.pathname === '/me') return html(`<pre id="cookies">${request.headers.cookie ?? ''}</pre>`);
    if (url.pathname === '/opener') return html(`<button id="go" onclick="window.open('/popup','signin','width=400,height=500')">Sign in</button><pre id="from-popup"></pre><script>addEventListener('message', e => { document.getElementById('from-popup').textContent = e.data; });</script>`);
    if (url.pathname === '/popup') return html(`<script>window.opener && window.opener.postMessage('token-from-popup', '*');</script>popup`);
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://localhost:${server.address().port}` };
}

const bodyOf = async (host, tabId) => host.tabs.get(tabId).browser.current.page.evaluate(() => document.body.innerText);
const cookiesOf = async (host, tabId, origin) => {
  await host.run(tabId, 'navigate', { url: `${origin}/me` });
  return bodyOf(host, tabId);
};

test('a login made in one tab holds across reloads, tabs and a restart; popups become tabs', { skip: CHROMIUM ? false : 'no Chromium in this environment', timeout: 120_000 }, async () => {
  const profilesDir = await mkdtemp(join(tmpdir(), 'canopy-preview-host-'));
  const { server, origin } = await site();
  let host = new PreviewHost({ profilesDir, executablePath: CHROMIUM, picker: PICKER, timeoutMs: 60_000 });
  try {
    await host.ensure('one', { url: `${origin}/login` });
    assert.match(await bodyOf(host, 'one'), /logged in/);

    // The same tab, after a reload: both cookies, httpOnly included.
    await host.run('one', 'navigate', { action: 'reload' });
    assert.match(await cookiesOf(host, 'one', origin), /sid=persisted/);
    assert.match(await bodyOf(host, 'one'), /sess=session-only/);

    // Another tab on the profile is logged in too.
    await host.ensure('two');
    assert.match(await cookiesOf(host, 'two', origin), /sid=persisted/);

    // The page presents as Chrome, not as an automated headless browser.
    const identity = await host.tabs.get('two').browser.current.page.evaluate(() => ({ ua: navigator.userAgent, webdriver: navigator.webdriver }));
    assert.doesNotMatch(identity.ua, /HeadlessChrome/);
    assert.equal(identity.webdriver, false);

    // Closing one tab leaves the other working.
    await host.close('two');
    assert.equal(host.tabs.has('two'), false);
    assert.match(await cookiesOf(host, 'one', origin), /sid=persisted/);

    // A sign-in popup becomes its own tab and can still report to its opener.
    const output = [];
    const viewer = await host.tabs.get('one').browser.attachViewer({ maxWidth: 800, maxHeight: 600, quality: 50, canOperate: true });
    void (async () => { for (;;) { const item = await viewer.output.take(); if (!item) return; output.push(item); item.ack?.(); } })();
    await host.run('one', 'navigate', { url: `${origin}/opener` });
    // The person clicks Sign in through the stream: their input takes the page.
    const box = await host.tabs.get('one').browser.current.page.locator('#go').boundingBox();
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await viewer.input({ type: 'mouse', action: 'down', button: 'left', buttons: 1, clickCount: 1, ...at });
    await viewer.input({ type: 'mouse', action: 'up', button: 'left', buttons: 0, clickCount: 1, ...at });
    const deadline = Date.now() + 15_000;
    while (!output.some(item => item._tag === 'popup') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const popup = output.find(item => item._tag === 'popup');
    assert.ok(popup, 'the controlling viewer is told about the popup');
    assert.equal(popup.openerId, 'one');
    assert.ok(host.tabs.has(popup.tabId));
    await host.tabs.get('one').browser.current.page.waitForFunction(() => document.getElementById('from-popup').textContent === 'token-from-popup', null, { timeout: 15_000 });
    // The viewer's address bar follows navigation.
    assert.ok(output.some(item => item._tag === 'navigated' && item.url.endsWith('/opener')));
    await viewer.close();

    // A new browser process on the same profile is still logged in.
    await host.shutdown();
    host = new PreviewHost({ profilesDir, executablePath: CHROMIUM, picker: PICKER, timeoutMs: 60_000 });
    await host.ensure('again');
    const afterRestart = await cookiesOf(host, 'again', origin);
    assert.match(afterRestart, /sid=persisted/);
    // Chromium drops cookies without an expiry when the browser exits, as any
    // Chrome does without "continue where you left off", so the host process
    // must live as long as the app. This records that behaviour.
    assert.doesNotMatch(afterRestart, /sess=session-only/);

    assert.deepEqual(await host.profiles(), ['default']);
    // Clearing the profile signs out.
    await host.clearProfile('default');
    await host.ensure('fresh');
    assert.doesNotMatch(await cookiesOf(host, 'fresh', origin), /sid=persisted/);
  } finally {
    await host.shutdown();
    server.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('the loopback API needs the token, tickets are one-use, foreign origins are refused', { skip: CHROMIUM ? false : 'no Chromium in this environment', timeout: 120_000 }, async () => {
  const profilesDir = await mkdtemp(join(tmpdir(), 'canopy-preview-api-'));
  const { server: site_, origin } = await site();
  const host = new PreviewHost({ profilesDir, executablePath: CHROMIUM, picker: PICKER, timeoutMs: 60_000 });
  const token = 'test-token-0123456789';
  const server = createPreviewServer(host, { token, origins: ['tauri://localhost'] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  try {
    assert.equal((await fetch(`${base}/tabs`)).status, 401);
    assert.equal((await call('/tabs', { headers: { origin: 'https://evil.example' } })).status, 403);
    const allowed = await call('/tabs', { headers: { origin: 'tauri://localhost' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'tauri://localhost');

    const opened = await call('/tabs/a/ensure', { method: 'POST', body: JSON.stringify({ url: `${origin}/login` }) });
    assert.equal(opened.status, 200);
    assert.match((await opened.json()).url, /\/login$/);
    const op = await call('/tabs/a/op', { method: 'POST', body: JSON.stringify({ op: 'navigate', args: { url: `${origin}/me` } }) });
    assert.equal((await op.json()).ok, true);
    const bad = await call('/tabs/a/op', { method: 'POST', body: JSON.stringify({ op: 'navigate', args: { url: 'file:///etc/passwd' } }) });
    assert.equal(bad.status, 400);

    const { ticket } = await (await call('/tickets', { method: 'POST', body: JSON.stringify({ tabId: 'a' }) })).json();
    const streamUrl = `ws://127.0.0.1:${server.address().port}/tabs/a/stream?ticket=${ticket}&maxWidth=640&maxHeight=400`;
    const ws = new WebSocket(streamUrl, { origin: 'tauri://localhost' });
    const firstFrame = await new Promise((resolve, reject) => {
      ws.on('message', (data, binary) => { if (binary) resolve(data); });
      ws.on('error', reject);
    });
    assert.equal(firstFrame[0], 0xff, 'a JPEG frame');
    ws.close();
    // The same ticket does not open a second stream.
    const reused = new WebSocket(streamUrl, { origin: 'tauri://localhost' });
    const refused = await new Promise(resolve => { reused.on('unexpected-response', (_, response) => resolve(response.statusCode)); reused.on('error', () => resolve('error')); });
    assert.equal(refused, 401);

    assert.equal((await (await call('/tabs/a', { method: 'DELETE' })).json()).closed, true);
  } finally {
    server.close();
    await host.shutdown();
    site_.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('idle tabs close and the tab limit holds', async () => {
  let now = 0;
  const closed = [];
  const host = new PreviewHost({ profilesDir: '/nonexistent', executablePath: '/x', picker: PICKER, tabLimit: 2, idleMs: 1000, now: () => now });
  // Stand-in tabs: the sweep and the limit are bookkeeping over the tab map.
  const fake = (tabId, viewers) => host.tabs.set(tabId, { profile: 'default', usedAt: now, browser: { current: { viewers: new Set(Array(viewers).fill(0).map((_, i) => i)) }, close: async () => closed.push(tabId) } });
  fake('watched', 1);
  fake('idle', 0);
  // A tab the IDE holds is a person's background preview: it keeps its page.
  host.tabs.get('watched').held = false;
  await assert.rejects(host.ensure('third'), error => error.status === 429);
  now = 1500;
  await host.sweep();
  assert.deepEqual(closed, ['idle']);
  assert.ok(host.tabs.has('watched'));
  fake('background', 0);
  host.tabs.get('background').held = true;
  now = 99_000;
  await host.sweep();
  assert.ok(host.tabs.has('background'));
  // One window's list after it reloads closes only that window's held tabs.
  fake('other-window', 0);
  host.tabs.get('other-window').held = true;
  host.tabs.get('other-window').owner = 'window-2';
  host.tabs.get('background').owner = 'main';
  await host.retain(['watched'], 'main');
  assert.ok(!host.tabs.has('background'));
  assert.ok(host.tabs.has('other-window'));
  // A popup that has closed is gone, not reopened blank.
  await assert.rejects(host.ensure('popup-1234'), error => error.status === 404);
});

test('a person\'s input takes the page and gives it back; the agent drives a page someone only watches', { skip: CHROMIUM ? false : 'no Chromium in this environment', timeout: 120_000 }, async () => {
  const profilesDir = await mkdtemp(join(tmpdir(), 'canopy-preview-control-'));
  const { server, origin } = await site();
  const host = new PreviewHost({ profilesDir, executablePath: CHROMIUM, picker: PICKER, timeoutMs: 60_000, autoReleaseMs: 400 });
  try {
    await host.ensure('p', { url: `${origin}/opener`, profile: 'project-a' });
    const output = [];
    const viewer = await host.tabs.get('p').browser.attachViewer({ maxWidth: 800, maxHeight: 600, quality: 50, canOperate: true });
    void (async () => { for (;;) { const item = await viewer.output.take(); if (!item) return; output.push(item); item.ack?.(); } })();
    const controls = () => output.filter(item => item._tag === 'control').map(item => item.controller);

    // Watching does not lock the agent out.
    assert.equal(host.tabs.get('p').browser.current.control.controller, null);
    await host.run('p', 'navigate', { url: `${origin}/me` });

    // A person's click takes the page: the agent's next action is refused.
    await viewer.input({ type: 'mouse', action: 'down', button: 'left', buttons: 1, clickCount: 1, x: 5, y: 5 });
    await viewer.input({ type: 'mouse', action: 'up', button: 'left', buttons: 0, clickCount: 1, x: 5, y: 5 });
    assert.equal(controls().at(-1), 'you');
    await assert.rejects(host.run('p', 'navigate', { action: 'reload' }), error => error.status === 409);
    // Reads still work while the person has it.
    assert.ok(await host.run('p', 'console', {}));

    // Once their input stops, the page goes back and the agent continues.
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(host.tabs.get('p').browser.current.control.controller, null);
    assert.notEqual(controls().at(-1), 'you');
    await host.run('p', 'navigate', { action: 'reload' });

    // A held key keeps the page: release waits for keyUp.
    await viewer.input({ type: 'key', action: 'down', key: 'Shift', code: 'ShiftLeft' });
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.ok(host.tabs.get('p').browser.current.control.controller);
    await viewer.input({ type: 'key', action: 'up', key: 'Shift', code: 'ShiftLeft' });
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(host.tabs.get('p').browser.current.control.controller, null);

    // Unknown tabs are not invented by an op; an op that says how to open one does.
    await assert.rejects(host.run('nope', 'console', {}), error => error.status === 404);
    await host.run('reopened', 'console', {}, { url: `${origin}/me`, profile: 'project-a' });
    assert.equal(host.tabs.get('reopened').profile, 'project-a');
    await viewer.close();
  } finally {
    await host.shutdown();
    server.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('a file input is answered by the person controlling the page', { skip: CHROMIUM ? false : 'no Chromium in this environment', timeout: 120_000 }, async () => {
  const profilesDir = await mkdtemp(join(tmpdir(), 'canopy-preview-files-'));
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><input id="f" type="file" accept=".txt" style="position:absolute;left:0;top:0;width:200px;height:40px"><pre id="out"></pre><script>f.onchange=()=>{document.getElementById("out").textContent=f.files[0]?.name??""}</script>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const file = join(profilesDir, 'upload-me.txt');
  await (await import('node:fs/promises')).writeFile(file, 'hello');
  const host = new PreviewHost({ profilesDir, executablePath: CHROMIUM, picker: PICKER, timeoutMs: 60_000 });
  try {
    await host.ensure('f', { url: `http://localhost:${server.address().port}/` });
    const output = [];
    const viewer = await host.tabs.get('f').browser.attachViewer({ maxWidth: 800, maxHeight: 600, quality: 50, canOperate: true });
    void (async () => { for (;;) { const item = await viewer.output.take(); if (!item) return; output.push(item); item.ack?.(); } })();
    await viewer.input({ type: 'mouse', action: 'down', button: 'left', buttons: 1, clickCount: 1, x: 50, y: 20 });
    await viewer.input({ type: 'mouse', action: 'up', button: 'left', buttons: 0, clickCount: 1, x: 50, y: 20 });
    const deadline = Date.now() + 10_000;
    while (!output.some(item => item._tag === 'fileChooser') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const chooser = output.find(item => item._tag === 'fileChooser');
    assert.ok(chooser, 'the controller is offered the chooser');
    assert.equal(chooser.accept, '.txt');
    // The chooser keeps the page with the person until it is answered.
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.ok(host.tabs.get('f').browser.current.control.controller);
    await viewer.input({ type: 'fileChooser', id: chooser.id, paths: [file, 'relative/ignored.txt'] });
    await host.tabs.get('f').browser.current.page.waitForFunction(() => document.getElementById('out').textContent === 'upload-me.txt', null, { timeout: 10_000 });
    assert.ok(output.some(item => item._tag === 'fileChooserClosed' && item.id === chooser.id));
    await viewer.close();
  } finally {
    await host.shutdown();
    server.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('two tabs stream at once, not only the active one', { skip: CHROMIUM ? false : 'no Chromium in this environment', timeout: 120_000 }, async () => {
  // Headless Chromium casts only an active page (1064b87d); each preview tab
  // has its own viewer and both must keep painting.
  const profilesDir = await mkdtemp(join(tmpdir(), 'canopy-preview-two-'));
  const { server, origin } = await site();
  const host = new PreviewHost({ profilesDir, executablePath: CHROMIUM, picker: PICKER, timeoutMs: 60_000 });
  const viewers = [];
  try {
    const frames = { a: 0, b: 0 };
    for (const tabId of ['a', 'b']) {
      await host.ensure(tabId, { url: `${origin}/opener` });
      const viewer = await host.tabs.get(tabId).browser.attachViewer({ maxWidth: 640, maxHeight: 400, quality: 50, canOperate: true });
      viewers.push(viewer);
      void (async () => { for (;;) { const item = await viewer.output.take(); if (!item) return; if (item._tag === 'frame') frames[tabId] += 1; item.ack?.(); } })();
    }
    // Both pages repaint: each viewer must see a frame after the change.
    const before = { ...frames };
    for (const tabId of ['a', 'b']) await host.tabs.get(tabId).browser.current.page.evaluate(() => { document.body.style.background = '#0a0'; });
    const deadline = Date.now() + 15_000;
    while ((frames.a <= before.a || frames.b <= before.b) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(frames.a > before.a, 'tab a painted');
    assert.ok(frames.b > before.b, 'tab b painted');
  } finally {
    for (const viewer of viewers) await viewer.close();
    await host.shutdown();
    server.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('with no browser the host still runs, refuses tabs, and opens them once Chromium is downloaded', { skip: CHROMIUM ? false : 'no Chromium in this environment', timeout: 120_000 }, async () => {
  const profilesDir = await mkdtemp(join(tmpdir(), 'canopy-preview-nobrowser-'));
  const { server: site_, origin } = await site();
  let state = 'missing';
  const installer = {
    status: () => ({ state, received: state === 'installed' ? 10 : 0, total: 10, version: '1' }),
    install: async () => { state = 'installed'; return CHROMIUM; },
    stop() {},
  };
  const host = new PreviewHost({ profilesDir, picker: PICKER, installer, timeoutMs: 60_000 });
  const token = 'test-token-0123456789';
  const server = createPreviewServer(host, { token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const call = (path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  try {
    assert.deepEqual(await (await call('/browser')).json(), { executable: '', installer: { state: 'missing', received: 0, total: 10, version: '1' } });
    const refused = await call('/tabs/a/ensure', { method: 'POST', body: JSON.stringify({ url: `${origin}/me` }) });
    assert.equal(refused.status, 424);
    assert.equal((await call('/browser/install', { method: 'POST' })).status, 202);
    const deadline = Date.now() + 5_000;
    while ((await (await call('/browser')).json()).executable === '' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await (await call('/browser')).json()).executable, CHROMIUM);
    const opened = await call('/tabs/a/ensure', { method: 'POST', body: JSON.stringify({ url: `${origin}/me` }) });
    assert.equal(opened.status, 200);
  } finally {
    server.close();
    await host.shutdown();
    site_.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

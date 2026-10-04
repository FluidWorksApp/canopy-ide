// Real Linux Docker smoke test. Only random, synthetic workspaces are touched.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { DockerWorkspaces } from './docker.mjs';
import { createGateway } from './gateway.mjs';
import { digest } from './policy.mjs';
const execute = promisify(execFile);
const exec = (command, args, options = {}) => execute(command, args, { timeout: 120_000, maxBuffer: 256 * 1024, ...options });
const suffix = randomBytes(4).toString('hex');
const ids = [`smoke-a-${suffix}`, `smoke-b-${suffix}`];
const accountIds = [`smoke-private-a-${suffix}`, `smoke-private-b-${suffix}`, `smoke-team-${suffix}`];
const token = randomBytes(32).toString('hex');
const config = { workspaces: ids.map((id, index) => ({ id, accounts: [accountIds[index], accountIds[2]], memoryMiB: 2048, cpus: 0.5 })),
  principals: [{ id: 'smoke-client', tokenSha256: digest(token), workspaces: [ids[0]], scope: 'drive' }] };
const host = new DockerWorkspaces({ secret: randomBytes(32).toString('hex'), image: process.env.CANOPY_WORKSPACE_IMAGE });
let uiServer, uiUrl;
if (process.env.CANOPY_SMOKE_UI === '1') {
  const dist = path.resolve(import.meta.dirname, '../../dist');
  const nativeConfig = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../src-tauri/tauri.conf.json'), 'utf8'));
  uiServer = http.createServer(async (request, response) => {
    const requested = new URL(request.url, 'http://smoke').pathname;
    const file = path.resolve(dist, `.${requested === '/' ? '/index.html' : requested}`);
    if (!file.startsWith(`${dist}/`)) { response.writeHead(403); return response.end(); }
    try {
      const bytes = await readFile(file);
      response.setHeader('content-security-policy', nativeConfig.app.security.csp);
      response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  uiServer.listen(0, '127.0.0.1'); await once(uiServer, 'listening');
  uiUrl = `http://127.0.0.1:${uiServer.address().port}`;
}
const gateway = createGateway({ config, workspaces: host, origins: uiUrl ? [uiUrl] : [] });
let url;
const call = async (id, route, args) => {
  const response = await fetch(`${url}/v1/workspaces/${id}${route}`, { method: args === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: args === undefined ? undefined : JSON.stringify(args), signal: AbortSignal.timeout(30_000) });
  return { status: response.status, data: await response.json() };
};
const pause = () => new Promise(resolve => setTimeout(resolve, 200));
async function awaitRunner(id) {
  for (let i = 0; i < 50; i++) { const result = await call(id, '/sessions'); if (result.status === 200) return; await pause(); }
  throw new Error('Workspace runner did not become ready');
}
const socket = async stream => {
  const ticket = await call(ids[0], '/ticket', { stream }); assert.equal(ticket.status, 200);
  const ws = new WebSocket(`${url.replace('http', 'ws')}/v1/stream?ticket=${ticket.data.ticket}`);
  const first = once(ws, 'message'); await once(ws, 'open');
  return { ws, first: (await first)[0] };
};
const disconnect = async ws => { const closed = once(ws, 'close'); ws.close(); await closed; };
try {
  for (const account of accountIds) {
    await exec('docker', ['volume', 'create', `canopy-account-${account}`]);
    await exec('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', '--pids-limit', '16', '--cap-drop', 'ALL',
      '--user', '0:0', '--mount', `type=volume,source=canopy-account-${account},target=/template`,
      '--entrypoint', '/bin/sh', process.env.CANOPY_WORKSPACE_IMAGE ?? 'canopy-workspace:0.1.0', '-c', 'printf "SYNTHETIC_TEMPLATE" > /template/template.txt; chmod 755 /template; chmod 644 /template/template.txt']);
  }
  const opening = await Promise.allSettled(config.workspaces.map(w => host.open(w)));
  for (const result of opening) if (result.status === 'rejected') throw result.reason;
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  url = `http://127.0.0.1:${gateway.address().port}`;
  await awaitRunner(ids[0]);
  assert.equal((await call(ids[1], '/sessions')).status, 403);
  const args = { command: 'printf "CANOPY_MARKER\\n"; read line; printf "DONE:%s\\n" "$line"', requestId: 'smoke-request-1' };
  const [spawned, repeated] = await Promise.all([call(ids[0], '/sessions', args), call(ids[0], '/sessions', args)]);
  assert.equal(spawned.status, 200); assert.equal(spawned.data.id, repeated.data.id);
  const sessionId = spawned.data.id;
  const stream = `/sessions/${sessionId}/stream`;
  const initial = await socket(stream); await disconnect(initial.ws);
  await pause();
  const reattached = await socket(stream);
  const snapshot = JSON.parse(reattached.first);
  assert.ok(Buffer.from(snapshot.b64, 'base64').toString().includes('CANOPY_MARKER'));
  const exited = new Promise(resolve => reattached.ws.on('message', raw => { const event = JSON.parse(raw); if (event.t === 'exit') resolve(event.exitCode); }));
  assert.equal((await call(ids[0], `/sessions/${sessionId}/input`, { data: 'completed\r' })).status, 200);
  assert.equal(await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('PTY did not exit')), 5000))]), 0);
  await disconnect(reattached.ws);
  assert.equal((await call(ids[0], '/files/write', { path: 'identity.txt', text: 'workspace A' })).status, 200);
  assert.equal((await call(ids[0], '/files/read', { path: 'identity.txt' })).data.text, 'workspace A');
  assert.equal((await call(ids[0], '/files/read', { path: '/etc/passwd' })).status, 400);
  const b = await host.open(config.workspaces[1]);
  const other = await fetch(`${b.url}/files/read`, { method: 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'identity.txt' }) });
  assert.equal(other.status, 400);
  assert.equal((await call(ids[0], '/sessions', { command: '/bin/true', accountId: accountIds[1], requestId: 'private-account-denied' })).status, 400);
  const pool = await call(ids[0], '/sessions', {
    command: `cat "$HOME/template.txt"; printf "SESSION_COPY" > "$HOME/template.txt"; cat "/accounts/${accountIds[2]}/template.txt"; read line`,
    accountId: accountIds[2], requestId: 'shared-pool-copy-test',
  });
  assert.equal(pool.status, 200); await pause();
  const captured = await socket(`/sessions/${pool.data.id}/stream`);
  assert.ok(Buffer.from(JSON.parse(captured.first).b64, 'base64').toString().includes('SYNTHETIC_TEMPLATESYNTHETIC_TEMPLATE'));
  await disconnect(captured.ws);
  assert.equal((await call(ids[0], '/files/write', { path: 'diagnostic.ts', text: 'const answer: number = "wrong";\n' })).status, 200);
  const analyzed = await call(ids[0], '/language/analyze', { path: 'diagnostic.ts' });
  assert.equal(analyzed.status, 200, JSON.stringify(analyzed.data));
  assert.ok(analyzed.data.diagnostics.some(d => d.code === 2322), 'real TS server reports the synthetic type error');
  assert.equal((await call(ids[0], '/desktop', {})).status, 200);
  const desktop = await socket('/desktop/ws');
  assert.match(desktop.first.toString(), /^RFB 003\.\d{3}\n/); await disconnect(desktop.ws);
  const resumed = await host.open(config.workspaces[0]); assert.ok(resumed.url);
  console.log('PASS: real PTY spawn idempotency, detach/reconnect, terminal input, private files, private-account denial, shared account copy isolation, container reuse and on-demand RFB desktop handshake');
  if (uiUrl) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CANOPY_SMOKE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(connection => {
        globalThis.isTauri = true;
        localStorage.setItem('canopy.onboarding.seen.v1', '1');
        for (const tip of ['rail-project', 'rail-review', 'rail-agents', 'agent', 'multiplex']) localStorage.setItem(`canopy.coachmark.${tip}.v1`, '1');
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
        window.__TAURI_INTERNALS__ = {
          invoke: async command => command === 'execution_mode_get' ? 'remote' : command === 'execution_remote_get' ? connection : command === 'pty_renderer_register' ? { generation: 1, sessions: [] } : command === 'plugin:event|listen' ? 0 : null,
          transformCallback: () => 0,
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        };
      }, { endpoint: url, token, workspaceId: ids[0], workspaceName: 'Smoke workspace' });
      await page.goto(uiUrl);
      await page.getByRole('button', { name: 'Remote · Smoke workspace' }).waitFor();
      await page.getByTitle('New terminal / agent', { exact: true }).click();
      await page.locator('.cli-menu .cli-item').filter({ hasText: /\bShell\b/ }).click();
      const input = page.locator('.xterm-helper-textarea:visible').first();
      await input.waitFor(); await input.focus();
      await page.keyboard.type("printf 'UI_WORKSPACE_MARKER\\n'; uname -m; pwd");
      await page.keyboard.press('Enter');
      await page.getByText('UI_WORKSPACE_MARKER', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Desktop', exact: true }).click();
      await page.locator('.remote-desktop .remote-status').filter({ hasText: 'Connected' }).waitFor();
      await page.locator('.remote-desktop canvas').waitFor();
      assert.equal(await page.locator('.remote-desktop canvas').evaluate(canvas => canvas.width), 1280);
      await page.screenshot({ path: process.env.CANOPY_SMOKE_SCREENSHOT ?? '/tmp/canopy-native-workspace-smoke.png' });
      await page.getByRole('button', { name: 'Close desktop' }).click();
      assert.equal(await page.locator('.remote-desktop').count(), 0);
      assert.deepEqual(errors, []);
      console.log('PASS: normal IDE workspace routing, ordered remote shell keyboard input, lazy XFCE pixel canvas and desktop viewer disposal');
    } finally { await browser.close(); }
  }
} finally {
  gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
  if (uiServer) { uiServer.closeAllConnections(); await new Promise(resolve => uiServer.close(resolve)); }
  for (const id of ids) {
    await exec('docker', ['rm', '-f', `canopy-ws-${id}`], { timeout: 10_000 }).catch(() => {});
    await exec('docker', ['volume', 'rm', `canopy-project-${id}`, `canopy-home-${id}`], { timeout: 10_000 }).catch(() => {});
    await exec('docker', ['network', 'rm', `canopy-net-${id}`], { timeout: 10_000 }).catch(() => {});
  }
  for (const account of accountIds) await exec('docker', ['volume', 'rm', `canopy-account-${account}`], { timeout: 10_000 }).catch(() => {});
}

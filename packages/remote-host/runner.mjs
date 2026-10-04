import { nativeInvoke, startNativeServer } from "./native.mjs";
import http from 'node:http';
import net from 'node:net';
import { spawn as childSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, realpath, stat, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { body, json, sendBounded } from './http.mjs';
import { SessionHistory } from './history.mjs';
import {gitIdentityEnvironment} from './git-identity.mjs';
import { analyze } from './language.mjs';
const exec = promisify(execFile);
const ROOT = '/workspace';
const OUTPUT_CAP = 512 * 1024;

export async function scopedPath(value, writing = false) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid path');
  const candidate = path.resolve(ROOT, value);
  const inside = target => target === ROOT || target.startsWith(`${ROOT}/`);
  if (!inside(candidate)) throw new Error('Path outside workspace');
  let resolved;
  try { resolved = await realpath(candidate); }
  catch (error) {
    if (!writing || error.code !== 'ENOENT') throw error;
    resolved = path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
  }
  if (!inside(resolved)) throw new Error('Symlink outside workspace');
  return resolved;
}

export function createRunner({ secret, spawnPty, accounts = [], workspaceId = 'workspace', historyFile = null }) {
  if (!secret || secret.length < 32) throw new Error('Runner secret required');
  const sessions = new Map();
  const receipts = new Map();
  const sockets = new Set();
  let sequence = 0;
  let pendingSpawns = 0;
  let desktop = null;
  const history = new SessionHistory(historyFile);
  const fingerprint = args => createHash('sha256').update(JSON.stringify(args)).digest('hex');
  const ready = history.load().then(entries => {
    for (const entry of entries) {
      const session = { ...entry.session, exitCode: entry.session.exitCode ?? -1, output: Buffer.alloc(0), pty: null };
      sequence = Math.max(sequence, session.id);
      sessions.set(session.id, session);
      receipts.set(entry.requestId, { fingerprint: entry.fingerprint, result: Promise.resolve(summarize(session)), id: session.id });
    }
  });
  const persist = () => history.save([...receipts].filter(([, r]) => r.id != null).map(([requestId, r]) => ({ requestId, fingerprint: r.fingerprint, session: summarize(sessions.get(r.id)) })));
  const authorized = request => {
    const received = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);
    return received.length === expected.length && timingSafeEqual(received, expected);
  };
  const summarize = session => ({ id: session.id, pid:session.pty?.pid??null, title: session.title, cols: session.cols, rows: session.rows, exitCode: session.exitCode, accountId: session.accountId, kind: session.kind ?? "terminal" });
  const broadcast = (session, message) => {
    for (const socket of sockets) if (socket.sessionId === session.id) sendBounded(socket, message);
  };
  async function spawnSession(args) {
    await ready;
    if (typeof args.requestId !== 'string' || !/^[a-zA-Z0-9:-]{8,128}$/.test(args.requestId)) throw new Error('Spawn request id required');
    if (receipts.has(args.requestId)) {
      const receipt = receipts.get(args.requestId);
      if (receipt.fingerprint !== fingerprint(args)) throw new Error('Request id reused with different arguments');
      return receipt.result;
    }
    if ([...sessions.values()].filter(s => s.exitCode == null).length + pendingSpawns >= 16 || receipts.size >= 256) throw new Error('Workspace session capacity reached');
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 8192) throw new Error('Command required');
    if (args.kind && !['terminal', 'build'].includes(args.kind)) throw new Error('Invalid session kind');
    if (args.accountId && !accounts.includes(args.accountId)) throw new Error('Account not granted to workspace');
    const gitEnvironment=args.gitIdentity?gitIdentityEnvironment(args.gitIdentity):{};
    // Reserve before awaiting credential I/O, so a retry cannot race a spawn.
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    receipts.set(args.requestId, { fingerprint: fingerprint(args), result });
    pendingSpawns++;
    try {
      const id = ++sequence;
      // Record acceptance before any credential I/O or child process creation.
      const pending = { id, kind: args.kind ?? 'terminal', title: args.command.slice(0, 80), cols: 120, rows: 40, accountId: args.accountId ?? null, output: Buffer.alloc(0), exitCode: -1, pty: null };
      sessions.set(id, pending);
      receipts.get(args.requestId).id = id;
      await persist();
      let accountHome = '/home/agent';
      if (args.accountId) {
        accountHome = `/home/agent/.canopy/accounts/${randomUUID()}`;
        await mkdir(accountHome, { recursive: true, mode: 0o700 });
        // Account volumes are administrator-provisioned, read-only templates.
        // Each session gets writable refresh state; no shared credential writes.
        let template = `/accounts/${args.accountId}`;
        try { template = await realpath(`${template}/current`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await cp(template, accountHome, { recursive: true, dereference: true });
      }
      const cols = 120, rows = 40;
      const pty = spawnPty('/bin/bash', ['-lc', 'export PATH="/home/agent/.local/bin:$PATH" NPM_CONFIG_PREFIX=/home/agent/.local; '+args.command], { name: 'xterm-256color', cols, rows, cwd: ROOT,
        env: { CANOPY:'1', CANOPY_PTY:String(id), CANOPY_INSTANCE:'remote-'+workspaceId, PATH: process.env.PATH, HOME: accountHome, USER: 'agent', NPM_CONFIG_PREFIX:'/home/agent/.local', TERM: 'xterm-256color',
          CANOPY_BROWSER_QUEUE:'/home/agent/.canopy/browser-requests',BROWSER:'/opt/canopy/open-url.mjs',GH_CANOPY_BROWSER_QUEUE:'/home/agent/.canopy/browser-requests',BROWSER:'/opt/canopy/open-url.mjs', LANG: 'C.UTF-8', DISPLAY: ':99', CODEX_HOME: `${accountHome}/.codex`,
          CLAUDE_CONFIG_DIR: `${accountHome}/.claude`, CANOPY_WORKSPACE_ID: workspaceId, CANOPY_SESSION_REQUEST_ID:args.requestId,...gitEnvironment } });
      const session = { id, pty, kind: args.kind ?? 'terminal', title: args.command.slice(0, 80), cols, rows, accountId: args.accountId ?? null, output: Buffer.alloc(0), exitCode: null };
      sessions.set(id, session);
      pty.onData(text => {
        const chunk = Buffer.from(text);
        session.output = chunk.length >= OUTPUT_CAP ? Buffer.from(chunk.subarray(-OUTPUT_CAP))
          : Buffer.concat([session.output.subarray(Math.max(0, session.output.length + chunk.length - OUTPUT_CAP)), chunk]);
        broadcast(session, { t: 'data', b64: chunk.toString('base64') });
      });
      pty.onExit(event => { session.exitCode = event.exitCode; broadcast(session, { t: 'exit', exitCode: event.exitCode }); void persist().catch(() => {}); });
      resolve(summarize(session));
    } catch (error) { reject(error); } finally { pendingSpawns--; }
    return result;
  }
  async function startDesktop() {
    if (!desktop) desktop = (async () => {
      // Workspace execution is already alive; the desktop is created only on demand.
      await mkdir('/home/agent/.cache/runtime', {recursive:true,mode:0o700});
      const launch = (command, args) => {
        const child = childSpawn(command, args, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: '/home/agent', DISPLAY: ':99', XDG_RUNTIME_DIR:'/home/agent/.cache/runtime' } });
        return new Promise((resolve, reject) => { child.once('spawn', () => resolve(child)); child.once('error', reject); });
      };
      const children = [];
      try {
        children.push(await launch('Xvfb', [':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp']));
        for (let i = 0; i < 30; i++) {
          try { await stat('/tmp/.X11-unix/X99'); break; }
          catch { if (i === 29) throw new Error('Desktop display did not start'); await new Promise(r => setTimeout(r, 100)); }
        }
        children.push(await launch('dbus-run-session', ['--', 'xfce4-session']));
        children.push(await launch('x11vnc', ['-display', ':99', '-localhost', '-rfbport', '5900', '-forever', '-shared', '-nopw']));
        for (let i = 0; i < 50; i++) {
          try {
            await new Promise((resolve, reject) => {
              const probe = net.connect(5900, '127.0.0.1');
              probe.once('connect', () => { probe.destroy(); resolve(); });
              probe.once('error', reject);
            });
            break;
          } catch { if (i === 49) throw new Error('Desktop stream did not start'); await new Promise(r => setTimeout(r, 100)); }
        }
        return children;
      } catch (error) { children.forEach(child => child.kill()); desktop = null; throw error; }
    })();
    await desktop;
    return { available: true };
  }
  const server = http.createServer(async (request, response) => {
    if (!authorized(request)) return json(response, 401, { error: 'Unauthorized' });
    const route = new URL(request.url, 'http://runner').pathname;
    try {
      await ready;
      if (request.method === 'POST' && route === '/native') { const input = await body(request); return json(response, 200, {result: (await nativeInvoke(input.command, input.args)) ?? null}); }
      if (request.method === 'POST' && route === '/language/analyze') return json(response, 200, await analyze(await body(request), scopedPath));
      if (request.method === 'GET' && route === '/sessions') return json(response, 200, [...sessions.values()].map(summarize));
      if (request.method === 'POST' && route === '/sessions') return json(response, 200, await spawnSession(await body(request, 16 * 1024)));
      if (request.method === 'POST' && route === '/desktop') return json(response, 200, await startDesktop());
      if (request.method === 'POST' && route === '/files/list') {
        const { path: requested = '.' } = await body(request);
        const entries = await readdir(await scopedPath(requested), { withFileTypes: true });
        if (entries.length > 4096) throw new Error('Directory too large');
        return json(response, 200, entries.map(entry => ({ name: entry.name, directory: entry.isDirectory() })));
      }
      if (request.method === 'POST' && route === '/files/read') {
        const { path: requested } = await body(request);
        const file = await scopedPath(requested);
        if ((await stat(file)).size > 1024 * 1024) throw new Error('File too large');
        return json(response, 200, { text: await readFile(file, 'utf8') });
      }
      if (request.method === 'POST' && route === '/files/write') {
        const args = await body(request);
        if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 1024 * 1024) throw new Error('File too large');
        await writeFile(await scopedPath(args.path, true), args.text);
        return json(response, 200, { saved: true });
      }
      if (request.method === 'POST' && (route === '/git/status' || route === '/git/diff')) {
        const result = await exec('git', ['-C', ROOT, ...(route === '/git/diff' ? ['diff', '--no-ext-diff', '--no-textconv', '--', '.'] : ['status', '--short'])], { maxBuffer: 1024 * 1024, timeout: 10_000 });
        return json(response, 200, { text: result.stdout });
      }
      const match = route.match(/^\/sessions\/(\d+)\/(input|resize|stop)$/);
      if (match && request.method === 'POST') {
        const session = sessions.get(Number(match[1]));
        if (!session || session.exitCode != null) throw new Error('Session not running');
        const args = await body(request, 64 * 1024);
        if (match[2] === 'stop') session.pty.kill();
        if (match[2] === 'input') { if (typeof args.data !== 'string') throw new Error('Invalid input'); session.pty.write(args.data); }
        if (match[2] === 'resize') {
          if (!Number.isInteger(args.cols) || args.cols < 1 || args.cols > 512 || !Number.isInteger(args.rows) || args.rows < 1 || args.rows > 256) throw new Error('Invalid geometry');
          session.pty.resize(args.cols, args.rows); session.cols = args.cols; session.rows = args.rows;
        }
        return json(response, 200, { ok: true });
      }
      json(response, 404, { error: 'Unknown operation' });
    } catch (error) { json(response, 400, { error: error.message }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (!authorized(request)) return socket.destroy();
    const route = new URL(request.url, 'http://runner').pathname;
    const match = route.match(/^\/sessions\/(\d+)\/stream$/);
    if (match) {
      const session = sessions.get(Number(match[1]));
      if (!session) return socket.destroy();
      wss.handleUpgrade(request, socket, head, ws => {
        ws.sessionId = session.id; sockets.add(ws);
        sendBounded(ws, { t: 'snapshot', b64: session.output.toString('base64'), ...summarize(session) });
        ws.on('close', () => sockets.delete(ws));
      });
    } else if (route === '/desktop/ws' && desktop) {
      wss.handleUpgrade(request, socket, head, ws => {
        const tcp = net.connect(5900, '127.0.0.1');
        tcp.on('data', chunk => {
          if (ws.bufferedAmount > 4 * 1024 * 1024) return ws.close(1013, 'Slow desktop consumer');
          if (ws.readyState === 1) ws.send(chunk);
        });
        ws.on('message', data => { if (tcp.writableLength > 1024 * 1024) ws.close(1013); else tcp.write(data); });
        tcp.on('error', () => ws.close()); tcp.on('close', () => ws.close()); ws.on('close', () => tcp.destroy());
      });
    } else socket.destroy();
  });
  server.on('close', () => { for (const ws of sockets) ws.close(); });
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startNativeServer();
  const { spawn } = await import('node-pty');
  createRunner({ secret: process.env.CANOPY_RUNNER_TOKEN, spawnPty: spawn, accounts: (process.env.CANOPY_ACCOUNTS ?? '').split(',').filter(Boolean), workspaceId: process.env.CANOPY_WORKSPACE_ID, historyFile: '/home/agent/.canopy/session-history.json' })
    .listen(8080, '0.0.0.0');
}

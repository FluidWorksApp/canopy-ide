import {initializeScratch,scratchSessionEnv} from './scratch-environment.mjs';
import {decodeTerminalInput,BINARY_TERMINAL_INPUT_PROTOCOL} from './terminal-input.mjs';
import {prepareSharedAgentLaunch} from './shared-agent-launch.mjs';
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
import {safeGitRead} from './git-read.mjs';
import {gitIdentityEnvironment} from './git-identity.mjs';
import { analyze } from './language.mjs';
import {harnessEnvironment} from './runner-harness.mjs';
import {AgentBrowser} from './agent-browser.mjs';
import {claudeIde as defaultClaudeIde, lockDir as claudeIdeLockDir} from './claude-ide.mjs';
import {CLIPBOARD_BIN, installClipboardShims} from './clipboard-shims.mjs';
const exec = promisify(execFile);
const ROOT = '/workspace';
const OUTPUT_CAP = 512 * 1024;

/** The self-updating CLIs' "no background update" switches, which the image
 *  sets (Dockerfile ENV) so agents.lock.json's pinned builds stay the ones
 *  that run. Sessions get an explicit env rather than the runner's, so these
 *  are carried across by name — only when the image actually set them. */
export const PINNED_CLI_ENV_KEYS = ['DISABLE_AUTOUPDATER', 'GROK_DISABLE_AUTOUPDATER', 'AGY_CLI_DISABLE_AUTO_UPDATE'];
export const pinnedCliEnv = environment => Object.fromEntries(
  PINNED_CLI_ENV_KEYS.filter(key => typeof environment?.[key] === 'string').map(key => [key, environment[key]]));

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

export function createRunner({ secret, spawnPty, accounts = [], workspaceId = 'workspace', historyFile = null, environment = process.env, browser = null, claudeIde = defaultClaudeIde }) {
  if (!secret || secret.length < 32) throw new Error('Runner secret required');
  const sessions = new Map();
  const receipts = new Map();
  const sockets = new Set();
  let sequence = 0;
  let pendingSpawns = 0;
  let desktop = null;
  const history = new SessionHistory(historyFile);
  // The harness credential is minted per attempt by the gateway and never
  // persisted, so it is not part of a spawn's identity.
  const fingerprint = ({harness,...args}) => createHash('sha256').update(JSON.stringify(args)).digest('hex');
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
  const summarize = session => ({ inputProtocol:BINARY_TERMINAL_INPUT_PROTOCOL, id: session.id, pid:session.pty?.pid??null, title: session.title, cols: session.cols, rows: session.rows, exitCode: session.exitCode, accountId: session.accountId, kind: session.kind ?? "terminal" });
  const broadcast = (session, message) => {
    for (const socket of sockets) if (socket.sessionId === session.id) sendBounded(socket, message);
  };
  // Claude Code's IDE protocol (claude-ide.mjs): what the desktop has to act
  // on travels the session's own terminal stream, so it reaches exactly the
  // windows showing that terminal.
  claudeIde.emit = event => { const session = sessions.get(event.ptyId); if (session) broadcast(session, { t: 'ide', event }); };
  claudeIde.lastInput = id => sessions.get(id)?.lastInputAt ?? 0;
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
    const ideRequest = args.claudeIde == null ? null : claudeIdeRequest(args.claudeIde);
    const gitEnvironment=args.gitIdentity?gitIdentityEnvironment(args.gitIdentity):{};
    const harnessEnv=harnessEnvironment(args.harness);
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
      const sharedBin=args.sharedAgents?await prepareSharedAgentLaunch(accountHome,args.requestId,args.sharedAgents):null;
      const scratchEnv=await scratchSessionEnv(args.requestId,environment);
      const cols = 120, rows = 40;
      // A Claude Code tab gets its IDE server before it starts: the CLI looks
      // for the lock only during its first 30 s. A server that cannot start
      // costs the tab its IDE features, never the terminal.
      let ide = null;
      if (ideRequest) {
        try { ide = await claudeIde.open(id, { root: ideRequest.root, lockDir: claudeIdeLockDir(ideRequest.configDir, accountHome) }); }
        catch (error) { console.warn(`Claude IDE server for session ${id} unavailable: ${error.message}`); }
      }
      // Clipboard shims first, so a CLI's `xclip` copy reaches the desktop as
      // OSC 52 on the terminal recorded here (clipboard-shims.mjs).
      let pty;
      try {
      pty = spawnPty('/bin/bash', ['-lc', 'export PATH="'+(sharedBin?sharedBin+':':'')+CLIPBOARD_BIN+':/home/agent/.local/bin:$PATH" NPM_CONFIG_PREFIX=/home/agent/.local; canopy_tty=$(tty 2>/dev/null) && export CANOPY_TTY="$canopy_tty"; unset canopy_tty; '+args.command], { name: 'xterm-256color', cols, rows, cwd: ROOT,
        env: { CANOPY:'1', CANOPY_PTY:String(id), CANOPY_INSTANCE:'remote-'+workspaceId, PATH: process.env.PATH, HOME: accountHome, USER: 'agent', NPM_CONFIG_PREFIX:'/home/agent/.local', TERM: 'xterm-256color',
          CANOPY_BROWSER_QUEUE:'/home/agent/.canopy/browser-requests',BROWSER:'/opt/canopy/open-url.mjs',GH_CANOPY_BROWSER_QUEUE:'/home/agent/.canopy/browser-requests', LANG: 'C.UTF-8', DISPLAY: ':99', CODEX_HOME: `${accountHome}/.codex`,
          CLAUDE_CONFIG_DIR: `${accountHome}/.claude`, CANOPY_WORKSPACE_ID: workspaceId, CANOPY_SESSION_REQUEST_ID:args.requestId,...pinnedCliEnv(environment),...scratchEnv,...gitEnvironment,...harnessEnv,...ide?.env } });
      } catch (error) { claudeIde.close(id); throw error; }
      const session = { id, pty, kind: args.kind ?? 'terminal', title: args.command.slice(0, 80), cols, rows, accountId: args.accountId ?? null, output: Buffer.alloc(0), exitCode: null };
      sessions.set(id, session);
      pty.onData(text => {
        const chunk = Buffer.from(text);
        session.output = chunk.length >= OUTPUT_CAP ? Buffer.from(chunk.subarray(-OUTPUT_CAP))
          : Buffer.concat([session.output.subarray(Math.max(0, session.output.length + chunk.length - OUTPUT_CAP)), chunk]);
        broadcast(session, { t: 'data', b64: chunk.toString('base64') });
      });
      pty.onExit(event => { claudeIde.close(id); session.exitCode = event.exitCode; broadcast(session, { t: 'exit', exitCode: event.exitCode }); void persist().catch(() => {}); });
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
      if (request.method === 'POST' && route === '/browser') {
        if (!browser) return json(response, 503, { error: 'unavailable', reason: 'not-implemented', message: 'This workspace image has no agent browser' });
        const input = await body(request, 256 * 1024);
        try { return json(response, 200, await browser.run(input.op, input.args ?? {})); }
        catch (error) { return json(response, error.status ?? 400, { error: error.message }); }
      }
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
        const result = await safeGitRead(exec,route === '/git/diff'?['diff','--','.']:['status','--short'],{allowedRoot:ROOT,cwd:ROOT,env:process.env,maxBuffer:1024*1024,timeout:10000});
        return json(response, 200, { text: result.stdout });
      }
      const match = route.match(/^\/sessions\/(\d+)\/(input|input-binary|resize|stop)$/);
      if (match && request.method === 'POST') {
        const session = sessions.get(Number(match[1]));
        if (!session || session.exitCode != null) throw new Error('Session not running');
        const args = await body(request, 64 * 1024);
        if (match[2] === 'stop') session.pty.kill();
        // Service delivery names the child it addressed; a replaced or exited
        // terminal must not receive a message meant for its predecessor.
        if (args.expectPid != null && (!Number.isSafeInteger(args.expectPid) || args.expectPid !== session.pty.pid)) return json(response, 409, { error: 'Terminal generation changed', pid: session.pty.pid ?? null });
        if (match[2] === 'input' || match[2] === 'input-binary') { if (typeof args.data !== 'string') throw new Error('Invalid input'); session.pty.write(decodeTerminalInput(args.data,match[2]==='input-binary'?'latin1':undefined)); session.lastInputAt = Date.now(); }
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
        for (const event of claudeIde.replay(session.id)) sendBounded(ws, { t: 'ide', event });
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
  server.on('close', () => { for (const ws of sockets) ws.close(); claudeIde.closeAll(); void browser?.close(); });
  return server;
}

/** A launch's request for a Claude Code IDE server: the folder the session is
 *  scoped to and, when the launch names a profile, its CLAUDE_CONFIG_DIR. */
function claudeIdeRequest(value) {
  const root = value?.root, configDir = value?.configDir;
  const inside = typeof root === 'string' && !root.includes('\0') && (root === ROOT || root.startsWith(`${ROOT}/`)) && !root.split('/').includes('..');
  if (!inside) throw new Error('Claude IDE folder must be in the workspace');
  if (configDir != null && (typeof configDir !== 'string' || configDir.length > 4096)) throw new Error('Invalid Claude config directory');
  return { root, configDir: configDir ?? null };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  Object.assign(process.env,await initializeScratch());
  // Terminal clipboard shims. A failure leaves terminals with the image's own
  // clipboard tools, which is how they worked before.
  await installClipboardShims().catch(error => console.warn(`Clipboard shims unavailable: ${error.message}`));
  startNativeServer();
  const { spawn } = await import('node-pty');
  createRunner({ browser: new AgentBrowser({ home: '/home/agent' }), secret: process.env.CANOPY_RUNNER_TOKEN, spawnPty: spawn, accounts: (process.env.CANOPY_ACCOUNTS ?? '').split(',').filter(Boolean), workspaceId: process.env.CANOPY_WORKSPACE_ID, historyFile: '/home/agent/.canopy/session-history.json' })
    .listen(8080, '0.0.0.0');
}

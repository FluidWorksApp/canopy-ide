// Claude Code's own IDE protocol, served on the workspace VM.
//
// The desktop app serves this protocol for local Claude tabs from
// src-tauri/src/claude_ide.rs. A remote tab's `claude` runs here, in the
// container, and the CLI only talks to a server on its own loopback whose lock
// names a pid it can see — so the server has to live here too, in the runner's
// process. This module is that server, a port of claude_ide.rs: the same wire
// contract (research_notes/Harness capability parity matrix/
// claude_ide_protocol_capture.md §10), the same tool semantics, and the same
// UI events, so the desktop's diff card, selection, mentions and diagnostics
// handle a remote session exactly like a local one.
//
// What differs is only the UI transport. Events go out through `emit` (the
// runner puts them on the session's terminal stream as `{t:'ide', event}`),
// and the desktop answers through the `claude_ide_*` native commands.
//
// The points that are easy to get wrong, and why (all verified against Claude
// Code 2.1.310, see the capture):
//   - One server per PTY, its port in the PTY env as CLAUDE_CODE_SSE_PORT,
//     which turns auto-connect on and pins the CLI to this server.
//   - The lock is written before the PTY starts: the CLI only searches for 30 s.
//   - The upgrade must echo the `mcp` subprotocol or the CLI drops the socket.
//   - openDiff blocks with no timeout, and close_tab arrives on the same socket
//     while it is pending, so tool calls never hold up the read loop.
//   - A rejected diff is DIFF_REJECTED. TAB_CLOSED as an openDiff reply means
//     "accept as proposed", so it is never sent for one.
//   - Port and token live as long as the PTY: the CLI reconnects only with the
//     token it cached.
import http from 'node:http';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, open, readdir, readFile, rename, rm} from 'node:fs/promises';
import {WebSocketServer} from 'ws';

export const AUTH_HEADER = 'x-claude-code-ide-authorization';
/** What `/ide`, the selection echo and "Opened changes in …" call us. */
const IDE_NAME = 'Canopy';
/** Anything but "Claude Code JetBrains Plugin", which makes the CLI skip the
 *  diagnostics baseline. */
const SERVER_NAME = 'canopy';
const SERVER_VERSION = '0.1.0';
/** The CLI gives a `{uri}` baseline 500 ms and a `{}` fetch 2 s. The desktop
 *  that answers is a network round trip away, so these sit closer to the
 *  CLI's limits than the local server's 400/1600 ms: the CLI is on this same
 *  machine and its own overhead is a few milliseconds. Answering `[]` a little
 *  early is still better than answering correctly too late — three baseline
 *  timeouts turn baselines off for the session. */
export const URI_DIAGNOSTICS_DEADLINE_MS = 450;
export const ALL_DIAGNOSTICS_DEADLINE_MS = 1800;
/** Largest proposal (as JSON) sent to the desktop as a diff card. The event travels the
 *  terminal stream, whose hops cap a frame at 1-2 MB and close the stream on a
 *  backlog; a bigger file is answered with an error, which the CLI logs before
 *  falling back to its terminal prompt (capture §10.6). */
export const MAX_DIFF_BYTES = 512 * 1024;
/** Largest frame accepted from the CLI. openDiff carries a whole file. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const sameToken = (presented, expected) => {
  const a = Buffer.from(String(presented ?? '')), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** `file` is `root` or inside it, by whole path segments. */
export function pathWithin(file, root) {
  const r = String(root ?? '').replace(/[\\/]+$/, '');
  if (!r || typeof file !== 'string') return false;
  return file === r || file.startsWith(r + '/') || file.startsWith(r + '\\');
}

const textContent = (...texts) => ({content: texts.map(text => ({type: 'text', text}))});
const result = (id, value) => ({jsonrpc: '2.0', id, result: value});
const error = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

/** Every Claude Code IDE server this runner is running, one per PTY. */
export class ClaudeIdeHub {
  /**
   * @param {object} [options]
   * @param {(event: object) => void} [options.emit] The UI end: one event per
   *   thing the desktop has to act on, shaped like claude_ide.rs `UiEvent`.
   * @param {(ptyId: number) => number} [options.lastInput] When the user last
   *   typed into a PTY (epoch ms), for picking a mention's target.
   * @param {number} [options.pid] The pid the locks name. Must be alive as
   *   long as the servers and visible to `claude` — the runner's own.
   */
  constructor({emit = () => {}, lastInput = () => 0, pid = process.pid, deadlines = {}} = {}) {
    this.emit = emit;
    this.lastInput = lastInput;
    this.pid = pid;
    this.deadlines = {uri: URI_DIAGNOSTICS_DEADLINE_MS, all: ALL_DIAGNOSTICS_DEADLINE_MS, ...deadlines};
    this.sessions = new Map();
    /** UI round trips in flight (diagnostics), by request id. */
    this.requests = new Map();
    this.nextId = 1;
    /** Lock directories already cleared of this pid's stale locks. */
    this.swept = new Set();
  }

  /**
   * Bind a server for one PTY and write its lock. Resolves once both exist,
   * with the env that points the PTY's CLI at it; the caller spawns after.
   */
  async open(ptyId, {root, lockDir}) {
    this.close(ptyId);
    if (typeof root !== 'string' || !root) throw Error('claude ide: a workspace folder is required');
    const token = randomBytes(32).toString('hex');
    const server = http.createServer((request, response) => {
      response.writeHead(404, {'content-length': 0});
      response.end();
    });
    const wss = new WebSocketServer({
      noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false,
      handleProtocols: protocols => (protocols.has('mcp') ? 'mcp' : false),
    });
    const session = {ptyId, token, root, lockPath: null, port: 0, server, wss, clients: new Set(), diffs: new Map(), closed: false};
    // The token is checked before the upgrade, so a wrong one is a plain 401
    // and never a socket.
    server.on('upgrade', (request, socket, head) => {
      const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (route !== '/') return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      if (!sameToken(request.headers[AUTH_HEADER], token)) return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      wss.handleUpgrade(request, socket, head, ws => this.#connection(session, ws));
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    session.port = server.address().port;
    try {
      session.lockPath = await writeLock(lockDir, session.port, {
        pid: this.pid, workspaceFolders: [root], ideName: IDE_NAME, transport: 'ws', authToken: token,
      });
    } catch (cause) {
      server.close();
      throw Error(`claude ide: cannot write lock in ${lockDir}: ${cause.message}`);
    }
    this.sessions.set(ptyId, session);
    void this.#sweep(lockDir).catch(() => {});
    return {
      port: session.port,
      token,
      // SSE_PORT is a misleading name kept from the old transport: it only
      // selects which lock to use. Auto-install is skipped because there is
      // no extension to install: Canopy is the IDE.
      env: {CLAUDE_CODE_SSE_PORT: String(session.port), CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1'},
    };
  }

  /** Stop one PTY's server: close its sockets, delete its lock, tell the UI
   *  its diffs are gone. Idempotent. */
  close(ptyId) {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    this.sessions.delete(ptyId);
    session.closed = true;
    const wasConnected = session.clients.size > 0;
    for (const ws of session.clients) ws.terminate();
    session.clients.clear();
    session.wss.close();
    session.server.close();
    if (session.lockPath) void rm(session.lockPath, {force: true}).catch(() => {});
    if (this.#dropDiffs(session) > 0) this.emit({kind: 'diffsCleared', ptyId});
    if (wasConnected) this.emit({kind: 'connection', ptyId, root: session.root, connected: false});
  }

  /** Runner shutdown: no lock may outlive the process whose pid it names. */
  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /** The user answered a diff in Canopy. Throws when it is no longer pending
   *  — answered in the terminal first, the race this protocol has by design. */
  resolveDiff(ptyId, tabName, accept, contents) {
    const session = this.sessions.get(ptyId);
    if (!session) throw Error('this terminal has no Claude Code connection');
    if (accept && typeof contents !== 'string') throw Error('accepting a change needs its contents');
    const pending = session.diffs.get(tabName);
    if (!pending) throw Error('Claude Code is no longer waiting on this change');
    session.diffs.delete(tabName);
    pending.settle(accept ? {accept: true, contents} : {accept: false});
  }

  /** The UI's answer to a round trip (diagnostics). A late answer finds
   *  nothing and is dropped. */
  reply(requestId, data) {
    const settle = this.requests.get(requestId);
    if (!settle) return;
    this.requests.delete(requestId);
    settle(data);
  }

  /** Fan a selection out to every connected session working on the file (the
   *  innermost component when they nest). Returns how many it reached. */
  notifySelection(file, params) {
    const targets = this.#sessionsFor(file);
    const frame = {jsonrpc: '2.0', method: 'selection_changed', params};
    for (const session of targets) send(session, frame);
    return targets.length;
  }

  /** Put `@file#Lx-y` into exactly one Claude prompt: `prefer` when it is a
   *  connected session on this file, else the one most recently typed into.
   *  Returns the PTY it went to. */
  atMention(file, lineStart, lineEnd, prefer) {
    const targets = this.#sessionsFor(file);
    const session = targets.find(s => s.ptyId === prefer)
      ?? targets.reduce((best, s) => (!best || this.lastInput(s.ptyId) > this.lastInput(best.ptyId) ? s : best), null);
    if (!session) throw Error('No Claude Code session in this component is connected to Canopy');
    const params = {filePath: file};
    if (Number.isInteger(lineStart) && Number.isInteger(lineEnd)) Object.assign(params, {lineStart, lineEnd});
    send(session, {jsonrpc: '2.0', method: 'at_mentioned', params});
    return session.ptyId;
  }

  /** The terminals with a CLI attached right now, for a window that missed
   *  their `connection` events. */
  connections() {
    return [...this.sessions.values()].filter(s => s.clients.size > 0).map(s => ({ptyId: s.ptyId, root: s.root}));
  }

  /** What a viewer attaching to this PTY's stream needs to catch up: whether
   *  a CLI is connected, and the diffs it is still waiting on. Events reach
   *  only viewers attached when they fire, and an openDiff never times out. */
  replay(ptyId) {
    const session = this.sessions.get(ptyId);
    if (!session || session.clients.size === 0) return [];
    return [
      {kind: 'connection', ptyId, root: session.root, connected: true},
      ...[...session.diffs].map(([tabName, d]) => ({kind: 'diff', ptyId, tabName, path: d.path, contents: d.contents})),
    ];
  }

  #sessionsFor(file) {
    const containing = [...this.sessions.values()].filter(s => s.clients.size > 0 && pathWithin(file, s.root));
    const depth = s => s.root.replace(/[\\/]+$/, '').length;
    const deepest = Math.max(...containing.map(depth));
    return containing.filter(s => depth(s) === deepest);
  }

  /** Forget every pending diff. Their openDiff calls are never answered: the
   *  CLI has either moved on (close_tab) or gone (socket closed). */
  #dropDiffs(session) {
    const n = session.diffs.size;
    for (const pending of session.diffs.values()) pending.settle(null);
    session.diffs.clear();
    return n;
  }

  /** Delete locks this process wrote for servers it no longer runs. A runner
   *  restarted in a new container usually gets the same pid, so the CLI's own
   *  dead-pid sweep would never clear them and `/ide` would list dead servers. */
  async #sweep(lockDir) {
    // Once per directory: every lock written after that is one we track.
    if (this.swept.has(lockDir)) return;
    this.swept.add(lockDir);
    // Liveness is checked per file, at delete time: another PTY's open() can
    // write its lock while this sweep is between awaits.
    const live = name => [...this.sessions.values()].some(s => `${s.port}.lock` === name);
    for (const name of await readdir(lockDir)) {
      if (!/^\d+\.lock$/.test(name) || live(name)) continue;
      try {
        const lock = JSON.parse(await readFile(path.join(lockDir, name), 'utf8'));
        if (lock.ideName === IDE_NAME && lock.pid === this.pid && !live(name)) await rm(path.join(lockDir, name), {force: true});
      } catch { /* Another IDE's lock, or one being written: leave it. */ }
    }
  }

  #connection(session, ws) {
    if (session.closed) return ws.terminate();
    session.clients.add(ws);
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      if (binary) return;
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { return reply(ws, error(null, -32700, 'Parse error')); }
      // Tool calls run on their own: openDiff waits on the user, and the
      // close_tab that abandons it arrives on this same socket meanwhile.
      void this.#dispatch(session, message).then(frame => { if (frame) reply(ws, frame); }, () => {});
    });
    ws.on('close', () => {
      session.clients.delete(ws);
      if (session.clients.size > 0 || session.closed) return;
      if (this.#dropDiffs(session) > 0) this.emit({kind: 'diffsCleared', ptyId: session.ptyId});
      this.emit({kind: 'connection', ptyId: session.ptyId, root: session.root, connected: false});
    });
  }

  async #dispatch(session, message) {
    if (!message || typeof message.method !== 'string') return null;
    const params = message.params ?? {};
    // `id` 0 is a real id: initialize uses it.
    if (message.id === undefined || message.id === null) {
      // The CLI's pid comes with it; the socket is already bound to this PTY
      // by being this PTY's server, so the connection itself is the news.
      if (message.method === 'ide_connected') this.emit({kind: 'connection', ptyId: session.ptyId, root: session.root, connected: true});
      return null;
    }
    const id = message.id;
    switch (message.method) {
      case 'initialize':
        return result(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
          capabilities: {tools: {listChanged: true}, prompts: {listChanged: true}, logging: {}},
          serverInfo: {name: SERVER_NAME, version: SERVER_VERSION},
        });
      case 'ping': return result(id, {});
      case 'prompts/list': return result(id, {prompts: []});
      case 'tools/list': return result(id, {tools: TOOLS});
      case 'tools/call': {
        const outcome = await this.#tool(session, String(params.name ?? ''), params.arguments ?? {});
        if (outcome === null) return null;
        return outcome.error ? error(id, outcome.error[0], outcome.error[1]) : result(id, outcome.result);
      }
      default: return error(id, -32601, 'Method not found');
    }
  }

  /** One tool call to `{result}`, `{error:[code,message]}`, or null for an
   *  openDiff the CLI abandoned, which is never answered. */
  async #tool(session, name, args) {
    const ptyId = session.ptyId;
    const string = key => (typeof args[key] === 'string' ? args[key] : null);
    switch (name) {
      case 'openDiff': {
        const file = string('new_file_path'), contents = string('new_file_contents'), tabName = string('tab_name');
        for (const [key, value] of [['new_file_path', file], ['new_file_contents', contents], ['tab_name', tabName]])
          if (value === null) return {error: [-32602, `missing string argument \`${key}\``]};
        // Measured as it will travel: JSON escaping can double a file's size.
        if (Buffer.byteLength(JSON.stringify({file, contents, tabName})) > MAX_DIFF_BYTES)
          return {error: [-32603, 'This change is too large to review in Canopy; answer it in the terminal.']};
        // A second openDiff under the same name replaces the first, whose call
        // is then abandoned like one closed by close_tab.
        session.diffs.get(tabName)?.settle(null);
        const verdict = await new Promise(settle => {
          session.diffs.set(tabName, {settle, path: file, contents});
          this.emit({kind: 'diff', ptyId, tabName, path: file, contents});
        });
        // No timeout: the CLI holds this open for as long as the user takes.
        if (verdict === null) return null;
        return {result: verdict.accept ? textContent('FILE_SAVED', verdict.contents) : textContent('DIFF_REJECTED')};
      }
      case 'close_tab': {
        const tabName = string('tab_name') ?? '';
        // Arrives twice after every diff, and while one is still pending when
        // the user answered in the terminal: settling with null is what
        // abandons that openDiff.
        const pending = session.diffs.get(tabName);
        session.diffs.delete(tabName);
        pending?.settle(null);
        this.emit({kind: 'diffClosed', ptyId, tabName});
        return {result: textContent('TAB_CLOSED')};
      }
      case 'closeAllDiffTabs': {
        // Sent on every prompt submit; the result is ignored.
        const n = this.#dropDiffs(session);
        if (n > 0) this.emit({kind: 'diffsCleared', ptyId});
        return {result: textContent(`CLOSED_${n}_DIFF_TABS`)};
      }
      case 'getDiagnostics': {
        const uri = string('uri') || null;
        const answer = await this.#askUi(uri ? this.deadlines.uri : this.deadlines.all,
          requestId => ({kind: 'diagnostics', requestId, ptyId, root: session.root, uri}));
        return {result: textContent(JSON.stringify(shapeDiagnostics(uri, answer)))};
      }
      case 'executeCode':
        return {result: {content: [{type: 'text', text: 'executeCode is not supported: Canopy has no Jupyter kernel to run code in.'}], isError: true}};
      default:
        return {error: [-32602, `Unknown tool: ${name}`]};
    }
  }

  /** One UI round trip with a deadline: null when the UI did not answer in
   *  time, and the pending entry goes so a late answer goes nowhere. */
  #askUi(deadline, event) {
    const requestId = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.requests.delete(requestId); resolve(null); }, deadline);
      this.requests.set(requestId, value => { clearTimeout(timer); resolve(value); });
      this.emit(event(requestId));
    });
  }
}

function reply(ws, frame) {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame));
}

function send(session, frame) {
  const text = JSON.stringify(frame);
  for (const ws of session.clients) if (ws.readyState === 1) ws.send(text);
}

/** Write `<dir>/<port>.lock` atomically: a private temp file renamed into
 *  place, so a CLI scanning the directory never parses half a lock. The
 *  directory is created 0700 and the file is 0600 — the token in it is the only
 *  thing between any local process and the user's editor. An existing
 *  directory is left as it is: other IDEs share it. */
export async function writeLock(dir, port, lock) {
  await mkdir(dir, {recursive: true, mode: 0o700});
  const target = path.join(dir, `${port}.lock`);
  const temp = path.join(dir, `.${port}.lock.${process.pid}.tmp`);
  await rm(temp, {force: true});
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(JSON.stringify(lock));
    await file.sync();
    await file.close();
    file = null;
    await rename(temp, target);
  } catch (cause) {
    await file?.close().catch(() => {});
    await rm(temp, {force: true}).catch(() => {});
    throw cause;
  }
  return target;
}

/** Where the CLI in a PTY finds its lock: `$CLAUDE_CONFIG_DIR/ide` for the
 *  config dir the PTY gets. A named profile's dir when the launch names one it
 *  may use; otherwise the session's default, `<HOME>/.claude` — which the CLI
 *  also always scans, so a lock there is found even when a launch moves
 *  CLAUDE_CONFIG_DIR somewhere this can't see. */
export function lockDir(configDir, home) {
  const allowed = typeof configDir === 'string' && path.isAbsolute(configDir) && !configDir.includes('\0') &&
    !configDir.split('/').some(segment => segment === '..' || segment === '.') &&
    ['/home/agent/', '/workspace/'].some(prefix => configDir.startsWith(prefix));
  return path.join(allowed ? configDir : path.join(home, '.claude'), 'ide');
}

/** Hold the UI's diagnostics to exactly what the CLI parses: `file://` URIs,
 *  0-based ranges, string severities. For the `{uri}` form the single entry
 *  carries the requested URI verbatim (the CLI discards a baseline whose
 *  `result[0].uri` does not match), and nothing known is `[]`, never an error. */
export function shapeDiagnostics(uri, answer) {
  const entries = Array.isArray(answer) ? answer.map(shapeFile).filter(Boolean) : [];
  if (!uri) return entries;
  const wanted = uriPath(uri);
  const entry = entries.find(e => uriPath(e.uri) === wanted);
  return entry ? [{...entry, uri}] : [];
}

function uriPath(uri) {
  const raw = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function shapeFile(entry) {
  if (!entry || typeof entry.uri !== 'string' || !entry.uri.startsWith('file://')) return null;
  const diagnostics = Array.isArray(entry.diagnostics) ? entry.diagnostics.map(shapeDiagnostic).filter(Boolean) : [];
  return {uri: entry.uri, diagnostics};
}

const SEVERITY_NAMES = {error: 'Error', warning: 'Warning', info: 'Info', information: 'Info'};
const SEVERITY_NUMBERS = {1: 'Error', 2: 'Warning', 3: 'Info'};

function shapeDiagnostic(d) {
  if (!d || typeof d.message !== 'string') return null;
  const severity = typeof d.severity === 'string' ? SEVERITY_NAMES[d.severity.toLowerCase()] ?? 'Hint'
    : typeof d.severity === 'number' ? SEVERITY_NUMBERS[d.severity] ?? 'Hint' : 'Hint';
  const position = p => ({
    line: Number.isInteger(p?.line) && p.line >= 0 ? p.line : 0,
    character: Number.isInteger(p?.character) && p.character >= 0 ? p.character : 0,
  });
  const out = {message: d.message, severity, range: {start: position(d.range?.start), end: position(d.range?.end)}};
  if (typeof d.source === 'string') out.source = d.source;
  if (typeof d.code === 'string') out.code = d.code;
  else if (typeof d.code === 'number') out.code = String(d.code);
  return out;
}

/** What we advertise: only the tools the CLI calls. Every other `mcp__ide__*`
 *  tool is dropped by the CLI's allow-list, and only getDiagnostics and
 *  executeCode are shown to the model, so only their descriptions matter. */
const TOOLS = [
  {
    name: 'getDiagnostics',
    description: 'Get language diagnostics (errors, warnings) from the editor',
    inputSchema: {
      type: 'object',
      properties: {uri: {type: 'string', description: 'Optional file URI to get diagnostics for. If not provided, gets diagnostics for all open files.'}},
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
  },
  {
    name: 'openDiff',
    inputSchema: {
      type: 'object',
      properties: {old_file_path: {type: 'string'}, new_file_path: {type: 'string'}, new_file_contents: {type: 'string'}, tab_name: {type: 'string'}},
      required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
      additionalProperties: false,
    },
  },
  {name: 'close_tab', inputSchema: {type: 'object', properties: {tab_name: {type: 'string'}}, required: ['tab_name']}},
  {name: 'closeAllDiffTabs', inputSchema: {type: 'object', properties: {}}},
  {name: 'executeCode', inputSchema: {type: 'object', properties: {code: {type: 'string'}}, required: ['code']}},
];

/** The runner's hub. The runner (PTY spawns, terminal streams) and the native
 *  command server (the desktop's answers) share one process and this one
 *  instance; the runner wires its `emit` and `lastInput`. */
export const claudeIde = new ClaudeIdeHub();

/** The `claude_ide_*` native commands: the desktop's half of the protocol,
 *  the same names and arguments as the Tauri commands in claude_ide.rs.
 *  `undefined` for any other command. */
export function claudeIdeCommand(hub, command, args = {}) {
  switch (command) {
    case 'claude_ide_resolve_diff':
      hub.resolveDiff(Number(args.ptyId), String(args.tabName ?? ''), args.accept === true, args.contents);
      return {handled: true, value: null};
    case 'claude_ide_reply':
      hub.reply(Number(args.requestId), args.data);
      return {handled: true, value: null};
    case 'claude_ide_connections':
      return {handled: true, value: hub.connections()};
    case 'claude_ide_selection':
      return {handled: true, value: hub.notifySelection(String(args.path ?? ''), args.params ?? null)};
    case 'claude_ide_at_mention':
      return {handled: true, value: hub.atMention(String(args.path ?? ''), args.lineStart, args.lineEnd, args.prefer == null ? undefined : Number(args.prefer))};
    default:
      return {handled: false};
  }
}

// Contract tests for the workspace's Claude Code IDE server, against the
// capture spec (research_notes/Harness capability parity matrix/
// claude_ide_protocol_capture.md §10) and the local server it mirrors
// (src-tauri/src/claude_ide.rs). A real `ws` client plays the CLI, sending
// what Claude Code 2.1.310 was captured sending.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {AUTH_HEADER, ClaudeIdeHub, MAX_DIFF_BYTES, claudeIdeCommand, lockDir, shapeDiagnostics} from './claude-ide.mjs';

async function setup({deadlines} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canopy-claude-ide-'));
  const events = [];
  const waiters = new Set();
  const hub = new ClaudeIdeHub({
    emit: event => { events.push(event); for (const w of waiters) w(); },
    deadlines,
  });
  const nextEvent = async (pred, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = events.find(pred);
      if (found) return found;
      await new Promise(resolve => { waiters.add(resolve); setTimeout(resolve, 20); });
    }
    throw Error(`no matching event in ${JSON.stringify(events)}`);
  };
  return {dir, lockDir: path.join(dir, 'ide'), hub, events, nextEvent, cleanup: async () => { hub.closeAll(); await rm(dir, {recursive: true, force: true}); }};
}

/** The CLI's side of one socket. */
class Cli {
  static async connect(port, token, {protocols = ['mcp']} = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocols, {headers: {[AUTH_HEADER]: token}});
    const cli = new Cli(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_req, res) => reject(Object.assign(Error(`HTTP ${res.statusCode}`), {status: res.statusCode}))); });
    return cli;
  }
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = new Set();
    this.nextId = 0;
    ws.on('message', data => { this.frames.push(JSON.parse(data.toString())); for (const w of this.waiters) w(); });
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  request(method, params) {
    const id = this.nextId++;
    this.send({method, params, jsonrpc: '2.0', id});
    return id;
  }
  async response(id, ms = 2000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.frames.find(f => f.id === id);
      if (found) return found;
      await new Promise(resolve => { this.waiters.add(resolve); setTimeout(resolve, 20); });
    }
    throw Error(`no response to ${id}`);
  }
  call(method, params) { return this.response(this.request(method, params)); }
  tool(name, args) { return this.request('tools/call', {name, arguments: args, _meta: {progressToken: this.nextId}}); }
  async handshake() {
    const init = await this.call('initialize', {protocolVersion: '2025-11-25', capabilities: {roots: {listChanged: true}}, clientInfo: {name: 'claude-code', version: '2.1.310'}});
    this.send({jsonrpc: '2.0', method: 'notifications/initialized'});
    this.send({jsonrpc: '2.0', method: 'ide_connected', params: {pid: 4242}});
    return init;
  }
  close() { this.ws.close(); }
}

const TAB = '✻ [Claude Code] hello.py (84bf2c) ⧉';

test('the lock is written before the server is handed out, private, and names a live pid', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(7, {root: '/workspace/projects/app', lockDir: t.lockDir});
    assert.deepEqual(launch.env, {CLAUDE_CODE_SSE_PORT: String(launch.port), CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1'});
    const lockPath = path.join(t.lockDir, `${launch.port}.lock`);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.deepEqual(lock, {pid: process.pid, workspaceFolders: ['/workspace/projects/app'], ideName: 'Canopy', transport: 'ws', authToken: launch.token});
    assert.match(launch.token, /^[0-9a-f]{64}$/);
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    assert.equal((await stat(t.lockDir)).mode & 0o777, 0o700);
    // No temp file left behind for a scanning CLI to trip over.
    assert.deepEqual(await readdir(t.lockDir), [`${launch.port}.lock`]);
    t.hub.close(7);
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(stat(lockPath), {code: 'ENOENT'});
  } finally { await t.cleanup(); }
});

test('a wrong token is a plain 401, any other path a 404, and the mcp subprotocol is echoed', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(1, {root: '/workspace/a', lockDir: t.lockDir});
    await assert.rejects(Cli.connect(launch.port, 'f'.repeat(64)), {status: 401});
    await assert.rejects(Cli.connect(launch.port, ''), {status: 401});
    const other = new WebSocket(`ws://127.0.0.1:${launch.port}/other`, ['mcp'], {headers: {[AUTH_HEADER]: launch.token}});
    await assert.rejects(new Promise((resolve, reject) => { other.once('open', resolve); other.once('unexpected-response', (_r, res) => reject(Object.assign(Error(), {status: res.statusCode}))); }), {status: 404});
    assert.equal(t.events.length, 0);
    const cli = await Cli.connect(launch.port, launch.token);
    assert.equal(cli.ws.protocol, 'mcp');
    cli.close();
  } finally { await t.cleanup(); }
});

test('handshake: protocolVersion echoed, empty prompts, the tool surface, -32601 for the rest', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(3, {root: '/workspace/a', lockDir: t.lockDir});
    const cli = await Cli.connect(launch.port, launch.token);
    const init = await cli.handshake();
    assert.equal(init.id, 0);
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.deepEqual(init.result.capabilities, {tools: {listChanged: true}, prompts: {listChanged: true}, logging: {}});
    assert.notEqual(init.result.serverInfo.name, 'Claude Code JetBrains Plugin');
    assert.deepEqual(await t.nextEvent(e => e.kind === 'connection'), {kind: 'connection', ptyId: 3, root: '/workspace/a', connected: true});
    assert.deepEqual(t.hub.connections(), [{ptyId: 3, root: '/workspace/a'}]);
    const [tools, prompts, ping, unknown] = await Promise.all([cli.call('tools/list'), cli.call('prompts/list'), cli.call('ping'), cli.call('resources/list')]);
    assert.deepEqual(tools.result.tools.map(tool => tool.name), ['getDiagnostics', 'openDiff', 'close_tab', 'closeAllDiffTabs', 'executeCode']);
    assert.deepEqual(prompts.result, {prompts: []});
    assert.deepEqual(ping.result, {});
    assert.equal(unknown.error.code, -32601);
    const legacy = await cli.call('initialize', {});
    assert.equal(legacy.result.protocolVersion, '2024-11-05');
    cli.ws.send('not json');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(cli.frames.at(-1).error.code, -32700);
    cli.close();
  } finally { await t.cleanup(); }
});

test('openDiff waits for the user: FILE_SAVED with the contents they accepted, or DIFF_REJECTED', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(5, {root: '/workspace/a', lockDir: t.lockDir});
    const cli = await Cli.connect(launch.port, launch.token);
    await cli.handshake();
    const proposed = 'def greet():\n    return "howdy"\n';
    const id = cli.tool('openDiff', {old_file_path: '/workspace/a/hello.py', new_file_path: '/workspace/a/hello.py', new_file_contents: proposed, tab_name: TAB});
    assert.deepEqual(await t.nextEvent(e => e.kind === 'diff'), {kind: 'diff', ptyId: 5, tabName: TAB, path: '/workspace/a/hello.py', contents: proposed});
    // Still pending: no timeout, and meanwhile other calls are answered.
    assert.deepEqual((await cli.call('ping')).result, {});
    assert.equal(cli.frames.find(f => f.id === id), undefined);
    const edited = `${proposed}# EDITED_IN_IDE\n`;
    t.hub.resolveDiff(5, TAB, true, edited);
    assert.deepEqual((await cli.response(id)).result, {content: [{type: 'text', text: 'FILE_SAVED'}, {type: 'text', text: edited}]});

    const rejected = cli.tool('openDiff', {old_file_path: '/workspace/a/hello.py', new_file_path: '/workspace/a/hello.py', new_file_contents: proposed, tab_name: `${TAB}2`});
    await t.nextEvent(e => e.kind === 'diff' && e.tabName === `${TAB}2`);
    t.hub.resolveDiff(5, `${TAB}2`, false);
    assert.deepEqual((await cli.response(rejected)).result, {content: [{type: 'text', text: 'DIFF_REJECTED'}]});
    // Never TAB_CLOSED as an openDiff answer: that means "accept as proposed".
    assert.ok(!cli.frames.some(f => f.result?.content?.[0]?.text === 'TAB_CLOSED'));
    assert.throws(() => t.hub.resolveDiff(5, TAB, true, edited), /no longer waiting/);
    assert.throws(() => t.hub.resolveDiff(99, TAB, false), /no Claude Code connection/);
    cli.close();
  } finally { await t.cleanup(); }
});

test('close_tab while openDiff is pending drops it unanswered (the user answered in the terminal)', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(2, {root: '/workspace/a', lockDir: t.lockDir});
    const cli = await Cli.connect(launch.port, launch.token);
    await cli.handshake();
    const id = cli.tool('openDiff', {old_file_path: '/workspace/a/x.py', new_file_path: '/workspace/a/x.py', new_file_contents: 'x', tab_name: TAB});
    await t.nextEvent(e => e.kind === 'diff');
    const closed = await cli.response(cli.tool('close_tab', {tab_name: TAB}));
    assert.deepEqual(closed.result, {content: [{type: 'text', text: 'TAB_CLOSED'}]});
    assert.deepEqual(await t.nextEvent(e => e.kind === 'diffClosed'), {kind: 'diffClosed', ptyId: 2, tabName: TAB});
    // ...and it arrives twice after every diff.
    await cli.response(cli.tool('close_tab', {tab_name: TAB}));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(cli.frames.find(f => f.id === id), undefined, 'an abandoned openDiff is never answered');
    assert.throws(() => t.hub.resolveDiff(2, TAB, true, 'late'), /no longer waiting/);
    assert.deepEqual(t.hub.replay(2), [{kind: 'connection', ptyId: 2, root: '/workspace/a', connected: true}]);
    cli.close();
  } finally { await t.cleanup(); }
});

test('closeAllDiffTabs abandons every pending diff and says how many', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(4, {root: '/workspace/a', lockDir: t.lockDir});
    const cli = await Cli.connect(launch.port, launch.token);
    await cli.handshake();
    assert.equal((await cli.response(cli.tool('closeAllDiffTabs', {}))).result.content[0].text, 'CLOSED_0_DIFF_TABS');
    assert.equal(t.events.filter(e => e.kind === 'diffsCleared').length, 0);
    const a = cli.tool('openDiff', {old_file_path: '/workspace/a/1', new_file_path: '/workspace/a/1', new_file_contents: '1', tab_name: 'one'});
    const b = cli.tool('openDiff', {old_file_path: '/workspace/a/2', new_file_path: '/workspace/a/2', new_file_contents: '2', tab_name: 'two'});
    await t.nextEvent(e => e.kind === 'diff' && e.tabName === 'two');
    assert.equal(t.hub.replay(4).filter(e => e.kind === 'diff').length, 2);
    assert.equal((await cli.response(cli.tool('closeAllDiffTabs', {}))).result.content[0].text, 'CLOSED_2_DIFF_TABS');
    assert.deepEqual(await t.nextEvent(e => e.kind === 'diffsCleared'), {kind: 'diffsCleared', ptyId: 4});
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(!cli.frames.some(f => f.id === a || f.id === b));
    cli.close();
  } finally { await t.cleanup(); }
});

test('a proposal too large for the terminal stream is an error, leaving the terminal prompt in charge', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(6, {root: '/workspace/a', lockDir: t.lockDir});
    const cli = await Cli.connect(launch.port, launch.token);
    await cli.handshake();
    const big = await cli.response(cli.tool('openDiff', {old_file_path: '/workspace/a/big', new_file_path: '/workspace/a/big', new_file_contents: 'x'.repeat(MAX_DIFF_BYTES), tab_name: 'big'}));
    assert.equal(big.error.code, -32603);
    // Escaping counts: a file of quotes doubles on the wire.
    const quoted = await cli.response(cli.tool('openDiff', {old_file_path: '/workspace/a/q', new_file_path: '/workspace/a/q', new_file_contents: '"'.repeat(MAX_DIFF_BYTES / 2 + 10), tab_name: 'q'}));
    assert.equal(quoted.error.code, -32603);
    assert.ok(!t.events.some(e => e.kind === 'diff'));
    const missing = await cli.response(cli.tool('openDiff', {new_file_path: '/workspace/a/m', tab_name: 'm'}));
    assert.equal(missing.error.code, -32602);
    const unknown = await cli.response(cli.tool('openFile', {}));
    assert.equal(unknown.error.code, -32602);
    const execute = await cli.response(cli.tool('executeCode', {code: '1'}));
    assert.equal(execute.result.isError, true);
    cli.close();
  } finally { await t.cleanup(); }
});

test('getDiagnostics: the {uri} baseline answers [] inside the CLI\'s 500 ms when the desktop is silent', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(8, {root: '/workspace/a', lockDir: t.lockDir});
    const cli = await Cli.connect(launch.port, launch.token);
    await cli.handshake();
    const started = Date.now();
    const silent = await cli.response(cli.tool('getDiagnostics', {uri: 'file:///workspace/a/hello.py'}));
    assert.ok(Date.now() - started < 500, `answered after ${Date.now() - started} ms`);
    assert.deepEqual(silent.result, {content: [{type: 'text', text: '[]'}]});
    const asked = t.events.find(e => e.kind === 'diagnostics');
    assert.deepEqual({...asked, requestId: 0}, {kind: 'diagnostics', requestId: 0, ptyId: 8, root: '/workspace/a', uri: 'file:///workspace/a/hello.py'});
    // A late answer goes nowhere.
    t.hub.reply(asked.requestId, [{uri: 'file:///workspace/a/hello.py', diagnostics: [{message: 'late'}]}]);

    // Answered in time: the entry for the file, carrying the URI as asked.
    const id = cli.tool('getDiagnostics', {uri: 'file:///workspace/a/my%20file.py'});
    const request = await t.nextEvent(e => e.kind === 'diagnostics' && e.uri === 'file:///workspace/a/my%20file.py');
    t.hub.reply(request.requestId, [
      {uri: 'file:///workspace/a/other.py', diagnostics: []},
      {uri: 'file:///workspace/a/my file.py', diagnostics: [{message: 'CANARY_DIAG', severity: 'Error', source: 'fake-lsp', code: 7, range: {start: {line: 1, character: 0}, end: {line: 1, character: 10}}}]},
    ]);
    const answered = JSON.parse((await cli.response(id)).result.content[0].text);
    assert.deepEqual(answered, [{uri: 'file:///workspace/a/my%20file.py', diagnostics: [{message: 'CANARY_DIAG', severity: 'Error', source: 'fake-lsp', code: '7', range: {start: {line: 1, character: 0}, end: {line: 1, character: 10}}}]}]);

    // The {} fetch: every file the desktop reports.
    const all = cli.tool('getDiagnostics', {});
    const allRequest = await t.nextEvent(e => e.kind === 'diagnostics' && e.uri === null);
    t.hub.reply(allRequest.requestId, [{uri: 'file:///workspace/a/x.ts', diagnostics: [{message: 'w', severity: 2}]}, {uri: 'untitled:1', diagnostics: []}]);
    assert.deepEqual(JSON.parse((await cli.response(all)).result.content[0].text), [{uri: 'file:///workspace/a/x.ts', diagnostics: [{message: 'w', severity: 'Warning', range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}}]}]);
    cli.close();
  } finally { await t.cleanup(); }
});

test('selections reach every connected session on the file, innermost component first; a mention exactly one', async () => {
  const t = await setup();
  const lastInput = new Map([[10, 100], [11, 300], [12, 200]]);
  t.hub.lastInput = id => lastInput.get(id) ?? 0;
  try {
    const outer = await t.hub.open(10, {root: '/workspace/repo', lockDir: t.lockDir});
    const inner = await t.hub.open(11, {root: '/workspace/repo/web', lockDir: t.lockDir});
    const sibling = await t.hub.open(12, {root: '/workspace/repo/web/', lockDir: t.lockDir});
    const unconnected = await t.hub.open(13, {root: '/workspace/repo/web', lockDir: t.lockDir});
    void unconnected;
    const clis = {10: await Cli.connect(outer.port, outer.token), 11: await Cli.connect(inner.port, inner.token), 12: await Cli.connect(sibling.port, sibling.token)};
    for (const cli of Object.values(clis)) await cli.handshake();
    const params = {text: 'x', filePath: '/workspace/repo/web/a.ts', selection: {start: {line: 0, character: 0}, end: {line: 0, character: 1}, isEmpty: false}};
    assert.equal(t.hub.notifySelection('/workspace/repo/web/a.ts', params), 2);
    assert.equal(t.hub.notifySelection('/workspace/repo/api/b.ts', params), 1);
    assert.equal(t.hub.notifySelection('/workspace/repository/c.ts', params), 0, 'whole path segments only');
    await new Promise(resolve => setTimeout(resolve, 50));
    const methods = id => clis[id].frames.filter(f => f.method).map(f => f.method);
    assert.deepEqual(methods(10), ['selection_changed']);
    assert.deepEqual(methods(11), ['selection_changed']);
    assert.deepEqual(clis[11].frames.find(f => f.method).params, params);

    assert.equal(t.hub.atMention('/workspace/repo/web/a.ts', 0, 1, undefined), 11, 'most recently typed into');
    assert.equal(t.hub.atMention('/workspace/repo/web/a.ts', undefined, undefined, 12), 12, 'the terminal in front wins');
    assert.equal(t.hub.atMention('/workspace/repo/web/a.ts', 0, 1, 10), 11, 'unless it is not on this file');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(clis[11].frames.filter(f => f.method === 'at_mentioned').map(f => f.params), [{filePath: '/workspace/repo/web/a.ts', lineStart: 0, lineEnd: 1}, {filePath: '/workspace/repo/web/a.ts', lineStart: 0, lineEnd: 1}]);
    assert.deepEqual(clis[12].frames.filter(f => f.method === 'at_mentioned').map(f => f.params), [{filePath: '/workspace/repo/web/a.ts'}]);
    assert.throws(() => t.hub.atMention('/elsewhere/x', 0, 0), /No Claude Code session/);
    for (const cli of Object.values(clis)) cli.close();
  } finally { await t.cleanup(); }
});

test('a dropped CLI takes its diffs with it, and reconnects with the token it cached', async () => {
  const t = await setup();
  try {
    const launch = await t.hub.open(9, {root: '/workspace/a', lockDir: t.lockDir});
    const first = await Cli.connect(launch.port, launch.token);
    await first.handshake();
    first.tool('openDiff', {old_file_path: '/workspace/a/x', new_file_path: '/workspace/a/x', new_file_contents: 'x', tab_name: TAB});
    await t.nextEvent(e => e.kind === 'diff');
    assert.equal(t.hub.replay(9).length, 2);
    first.close();
    assert.deepEqual(await t.nextEvent(e => e.kind === 'diffsCleared'), {kind: 'diffsCleared', ptyId: 9});
    assert.deepEqual(await t.nextEvent(e => e.kind === 'connection' && !e.connected), {kind: 'connection', ptyId: 9, root: '/workspace/a', connected: false});
    assert.deepEqual(t.hub.replay(9), []);
    assert.deepEqual(t.hub.connections(), []);
    const again = await Cli.connect(launch.port, launch.token);
    await again.handshake();
    await t.nextEvent(() => t.events.filter(e => e.kind === 'connection' && e.connected).length === 2);
    // The terminal ending closes the server and tells the UI once.
    t.hub.close(9);
    t.hub.close(9);
    assert.equal(t.events.filter(e => e.kind === 'connection' && !e.connected).length, 2);
  } finally { await t.cleanup(); }
});

test('locks this process left from servers it no longer runs are swept; other IDEs\' are not', async () => {
  const t = await setup();
  try {
    await mkdir(t.lockDir, {recursive: true});
    await writeFile(path.join(t.lockDir, '1111.lock'), JSON.stringify({pid: process.pid, ideName: 'Canopy', workspaceFolders: [], transport: 'ws', authToken: 'x'}));
    await writeFile(path.join(t.lockDir, '2222.lock'), JSON.stringify({pid: process.pid, ideName: 'Visual Studio Code'}));
    await writeFile(path.join(t.lockDir, '3333.lock'), JSON.stringify({pid: 1, ideName: 'Canopy'}));
    const launch = await t.hub.open(1, {root: '/workspace/a', lockDir: t.lockDir});
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual((await readdir(t.lockDir)).sort(), ['2222.lock', '3333.lock', `${launch.port}.lock`].sort());
  } finally { await t.cleanup(); }
});

test('the lock follows a profile\'s CLAUDE_CONFIG_DIR only when it is a plain workspace path', () => {
  assert.equal(lockDir(null, '/home/agent'), '/home/agent/.claude/ide');
  assert.equal(lockDir('/home/agent/.canopy/profiles/work/.claude', '/home/agent'), '/home/agent/.canopy/profiles/work/.claude/ide');
  assert.equal(lockDir('/workspace/.claude', '/home/agent/.canopy/accounts/u'), '/workspace/.claude/ide');
  for (const bad of ['/etc', '/home/agent/../../etc', 'relative/.claude', '', 42, '/home/agentx/.claude'])
    assert.equal(lockDir(bad, '/home/agent/.canopy/accounts/u'), '/home/agent/.canopy/accounts/u/.claude/ide', String(bad));
});

test('diagnostics are held to the shape the CLI parses', () => {
  assert.deepEqual(shapeDiagnostics('file:///a.py', null), []);
  assert.deepEqual(shapeDiagnostics(null, 'garbage'), []);
  assert.deepEqual(shapeDiagnostics(null, [{uri: 'file:///a', diagnostics: [{message: 'm', severity: 'information'}, {severity: 'Error'}, {message: 'n', severity: 'weird', range: {start: {line: -1, character: 2.5}}}]}]), [{uri: 'file:///a', diagnostics: [
    {message: 'm', severity: 'Info', range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}},
    {message: 'n', severity: 'Hint', range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}},
  ]}]);
});

test('the desktop\'s native commands map onto the hub', async () => {
  const calls = [];
  const hub = {
    resolveDiff: (...args) => calls.push(['resolveDiff', ...args]),
    reply: (...args) => calls.push(['reply', ...args]),
    connections: () => [{ptyId: 1, root: '/w'}],
    notifySelection: (...args) => { calls.push(['notifySelection', ...args]); return 2; },
    atMention: (...args) => { calls.push(['atMention', ...args]); return 4; },
  };
  assert.deepEqual(claudeIdeCommand(hub, 'claude_ide_resolve_diff', {ptyId: 3, tabName: 't', accept: true, contents: 'c'}), {handled: true, value: null});
  assert.deepEqual(claudeIdeCommand(hub, 'claude_ide_reply', {requestId: 9, data: []}), {handled: true, value: null});
  assert.deepEqual(claudeIdeCommand(hub, 'claude_ide_connections'), {handled: true, value: [{ptyId: 1, root: '/w'}]});
  assert.deepEqual(claudeIdeCommand(hub, 'claude_ide_selection', {path: '/w/a', params: {text: ''}}), {handled: true, value: 2});
  assert.deepEqual(claudeIdeCommand(hub, 'claude_ide_at_mention', {path: '/w/a', lineStart: 0, lineEnd: 2, prefer: 4}), {handled: true, value: 4});
  assert.deepEqual(claudeIdeCommand(hub, 'claude_ide_other', {}), {handled: false});
  assert.deepEqual(calls, [['resolveDiff', 3, 't', true, 'c'], ['reply', 9, []], ['notifySelection', '/w/a', {text: ''}], ['atMention', '/w/a', 0, 2, 4]]);
});

test('PTYs opening together in one directory keep both their locks', async () => {
  const t = await setup();
  try {
    const launches = await Promise.all([1, 2, 3, 4].map(id => t.hub.open(id, {root: '/workspace/a', lockDir: t.lockDir})));
    await new Promise(resolve => setTimeout(resolve, 100));
    const later = await t.hub.open(5, {root: '/workspace/a', lockDir: t.lockDir});
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual((await readdir(t.lockDir)).sort(), [...launches, later].map(l => `${l.port}.lock`).sort());
  } finally { await t.cleanup(); }
});

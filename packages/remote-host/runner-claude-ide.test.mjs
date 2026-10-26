// How the runner wires Claude Code's IDE server (claude-ide.mjs) and the
// clipboard shims into the PTYs it spawns. The hub is a stub here: its own
// protocol is covered by claude-ide.test.mjs, and a real one would write locks
// into this machine's home.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket from 'ws';
import {createRunner} from './runner.mjs';
import {CLIPBOARD_BIN} from './clipboard-shims.mjs';

const secret = 'x'.repeat(64);
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

function stubHub({fail = false} = {}) {
  const hub = {
    opened: [], closed: [], replays: new Map(),
    async open(id, options) {
      if (fail) throw Error('no port');
      hub.opened.push([id, options]);
      return {port: 5555, token: 't', env: {CLAUDE_CODE_SSE_PORT: '5555', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1'}};
    },
    close(id) { hub.closed.push(id); },
    closeAll() {},
    replay(id) { return hub.replays.get(id) ?? []; },
  };
  return hub;
}

function fakePty() {
  const pty = {pid: 4321, written: [], write(data) { pty.written.push(data); }, resize() {}, kill() {}, onData(handler) { pty.data = handler; }, onExit(handler) { pty.exit = handler; }};
  return pty;
}

async function runner(hub) {
  const launches = [], ptys = [];
  const server = createRunner({secret, claudeIde: hub, spawnPty: (bin, args, options) => { const pty = fakePty(); launches.push({bin, args, options}); ptys.push(pty); return pty; }});
  const url = await listen(server);
  const call = async (route, body) => {
    const response = await fetch(url + route, {method: 'POST', headers: {authorization: `Bearer ${secret}`, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  };
  return {server, url, call, launches, ptys};
}

test('a Claude tab gets its IDE server before it starts, and loses it when it ends', async () => {
  const hub = stubHub();
  const {server, call, launches, ptys} = await runner(hub);
  try {
    const spawned = await call('/sessions', {requestId: 'ide-session-1', command: 'exec bash', claudeIde: {root: '/workspace/projects/app'}});
    assert.equal(spawned.status, 200, JSON.stringify(spawned.data));
    assert.deepEqual(hub.opened, [[spawned.data.id, {root: '/workspace/projects/app', lockDir: '/home/agent/.claude/ide'}]]);
    assert.equal(launches[0].options.env.CLAUDE_CODE_SSE_PORT, '5555');
    assert.equal(launches[0].options.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, '1');
    assert.equal(launches[0].options.env.CLAUDE_CONFIG_DIR, '/home/agent/.claude');
    // A profile's config dir carries the lock with it.
    await call('/sessions', {requestId: 'ide-session-2', command: 'exec bash', claudeIde: {root: '/workspace', configDir: '/home/agent/.canopy/profiles/work/.claude'}});
    assert.equal(hub.opened[1][1].lockDir, '/home/agent/.canopy/profiles/work/.claude/ide');
    // A plain terminal gets neither.
    await call('/sessions', {requestId: 'plain-session-3', command: 'exec bash'});
    assert.equal(hub.opened.length, 2);
    assert.equal(launches[2].options.env.CLAUDE_CODE_SSE_PORT, undefined);
    ptys[0].exit({exitCode: 0});
    assert.deepEqual(hub.closed, [spawned.data.id]);
  } finally { await close(server); }
});

test('an IDE folder outside the workspace refuses the spawn; a server that cannot start does not', async () => {
  const {server, call, launches} = await runner(stubHub());
  try {
    for (const root of ['/etc', '/workspace/../etc', 42, '']) {
      const refused = await call('/sessions', {requestId: `bad-root-${launches.length}-${String(root).length}`, command: 'exec bash', claudeIde: {root}});
      assert.equal(refused.status, 400, String(root));
    }
    assert.equal(launches.length, 0);
  } finally { await close(server); }
  const failing = await runner(stubHub({fail: true}));
  try {
    const spawned = await failing.call('/sessions', {requestId: 'ide-unavailable', command: 'exec bash', claudeIde: {root: '/workspace'}});
    assert.equal(spawned.status, 200);
    assert.equal(failing.launches[0].options.env.CLAUDE_CODE_SSE_PORT, undefined);
  } finally { await close(failing.server); }
});

test('every PTY has the clipboard shims first on PATH and knows its own terminal', async () => {
  const {server, call, launches} = await runner(stubHub());
  try {
    await call('/sessions', {requestId: 'clipboard-session', command: 'cursor-agent'});
    const script = launches[0].args[1];
    assert.ok(script.startsWith(`export PATH="${CLIPBOARD_BIN}:/home/agent/.local/bin:$PATH"`), script);
    assert.match(script, /canopy_tty=\$\(tty 2>\/dev\/null\) && export CANOPY_TTY="\$canopy_tty"; unset canopy_tty; cursor-agent$/);
    // The desktop keeps its display; no fake Wayland one is needed.
    assert.equal(launches[0].options.env.DISPLAY, ':99');
    assert.equal(launches[0].options.env.WAYLAND_DISPLAY, undefined);
  } finally { await close(server); }
});

test('IDE events ride the session stream, a late viewer is caught up, and input feeds mention routing', async () => {
  const hub = stubHub();
  const {server, url, call} = await runner(hub);
  try {
    const {data: {id}} = await call('/sessions', {requestId: 'stream-session', command: 'exec bash', claudeIde: {root: '/workspace'}});
    hub.replays.set(id, [{kind: 'connection', ptyId: id, root: '/workspace', connected: true}]);
    const ws = new WebSocket(`${url.replace('http', 'ws')}/sessions/${id}/stream`, {headers: {authorization: `Bearer ${secret}`}});
    const frames = [];
    ws.on('message', data => frames.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    while (frames.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(frames[0].t, 'snapshot');
    assert.deepEqual(frames[1], {t: 'ide', event: {kind: 'connection', ptyId: id, root: '/workspace', connected: true}});
    hub.emit({kind: 'diff', ptyId: id, tabName: 'tab', path: '/workspace/a', contents: 'x'});
    hub.emit({kind: 'diff', ptyId: id + 100, tabName: 'tab', path: '/workspace/a', contents: 'x'});
    while (frames.length < 3) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(frames.slice(2), [{t: 'ide', event: {kind: 'diff', ptyId: id, tabName: 'tab', path: '/workspace/a', contents: 'x'}}]);
    assert.equal(hub.lastInput(id), 0);
    const before = Date.now();
    await call(`/sessions/${id}/input`, {data: 'hi'});
    assert.ok(hub.lastInput(id) >= before);
    ws.close();
  } finally { await close(server); }
});

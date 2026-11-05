import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunner } from './runner.mjs';

// Every spawn leaves a receipt (and the history file keeps it across
// restarts). A workspace that had opened 256 terminals refused every new one
// with "Workspace session capacity reached", though almost none were running.

const secret = 'x'.repeat(64);
const fakePty = () => {
  const pty = { pid: 1, exits: [], onData() {}, onExit(listener) { pty.exits.push(listener); }, write() {}, resize() {}, kill() { pty.exits.forEach(listener => listener({ exitCode: 0 })); } };
  return pty;
};

async function start(t, options = {}) {
  const ptys = [];
  const server = createRunner({ secret, spawnPty: () => { const pty = fakePty(); ptys.push(pty); return pty; }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (route, payload) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: payload ? 'POST' : 'GET', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: payload && JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ptys, call, spawn: requestId => call('/sessions', { requestId, command: 'bash' }) };
}

test('finished sessions stop counting toward the cap', async t => {
  const { ptys, spawn, call } = await start(t);
  const live = await spawn('live-session-0');
  for (let i = 1; i < 300; i++) {
    const result = await spawn(`spawn-session-${i}`);
    assert.equal(result.status, 200, result.body.error);
    ptys.at(-1).kill();
  }
  const sessions = (await call('/sessions')).body;
  assert.ok(sessions.length <= 256);
  // The running terminal keeps its receipt: a retry still gets the same session.
  assert.ok(sessions.some(session => session.id === live.body.id && session.exitCode == null));
  assert.equal((await spawn('live-session-0')).body.id, live.body.id);
});

test('running sessions are never pruned to make room', async t => {
  const { spawn } = await start(t);
  for (let i = 0; i < 16; i++) assert.equal((await spawn(`running-session-${i}`)).status, 200);
  assert.deepEqual((await spawn('one-too-many')).body, { error: 'Workspace session capacity reached' });
});

test('a full history from before the fix no longer blocks spawning', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runner-receipts-'));
  const historyFile = path.join(directory, 'session-history.json');
  const fingerprint = 'a'.repeat(64);
  await writeFile(historyFile, JSON.stringify(Array.from({ length: 256 }, (_, i) => ({
    requestId: `restored-session-${i}`, fingerprint, session: { id: i + 1, title: 'bash', cols: 120, rows: 40, exitCode: i < 3 ? null : 0, accountId: null, kind: 'terminal' },
  }))));
  const { spawn } = await start(t, { historyFile });
  const result = await spawn('after-restart');
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.id, 257);
  const saved = JSON.parse(await readFile(historyFile, 'utf8'));
  assert.equal(saved.length, 256);
  assert.equal(saved.at(-1).requestId, 'after-restart');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRunner } from './runner.mjs';

test('restart restores accepted receipts without respawning ambiguous work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canopy-history-'));
  const historyFile = path.join(directory, 'sessions.json');
  const secret = 'x'.repeat(64);
  let spawns = 0;
  const spawnPty = () => { spawns++; return { onData() {}, onExit() {}, kill() {}, resize() {}, write() {} }; };
  const args = { command: 'synthetic build', requestId: 'durable-request-1' };
  const open = async () => {
    const server = createRunner({ secret, spawnPty, historyFile });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const call = async data => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/sessions`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
      return { status: response.status, session: await response.json() };
    };
    return { server, call };
  };
  let running;
  try {
    running = await open();
    const initial = await running.call(args); assert.equal(initial.session.id, 1); assert.equal(spawns, 1);
    running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve));
    running = await open();
    const retried = await running.call(args);
    assert.equal(retried.session.id, 1); assert.equal(retried.session.exitCode, -1); assert.equal(spawns, 1);
    assert.equal((await running.call({ ...args, command: 'changed command' })).status, 400);
    assert.equal((await running.call({ ...args, requestId: 'new-request-2' })).session.id, 2);
  } finally {
    running?.server.closeAllConnections(); if (running) await new Promise(resolve => running.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending durable reservations count against the running-process cap', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canopy-admission-'));
  let spawned = 0;
  const secret = 'x'.repeat(64);
  const runner = createRunner({ secret, historyFile: path.join(directory, 'sessions.json'), spawnPty: () => {
    spawned++; return { onData() {}, onExit() {}, kill() {}, resize() {}, write() {} };
  } });
  runner.listen(0, '127.0.0.1'); await once(runner, 'listening');
  try {
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) => fetch(`http://127.0.0.1:${runner.address().port}/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'synthetic', requestId: `parallel-request-${index}` }),
    })));
    assert.equal(results.filter(r => r.status === 200).length, 16); assert.equal(spawned, 16);
  } finally {
    runner.closeAllConnections(); await new Promise(resolve => runner.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

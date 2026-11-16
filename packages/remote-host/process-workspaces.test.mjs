import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessWorkspaces } from './process-workspaces.mjs';
import { initHost, serviceUnit, hostPaths } from './canopy-host.mjs';
import { validateConfig, digest } from './policy.mjs';

const SECRET = 'x'.repeat(64);
const fakeChild = () => Object.assign(new EventEmitter(), { kill() { this.emit('exit', null); } });

function harness({ ready = async () => ({ ok: true }) } = {}) {
  const spawned = [];
  let port = 40000;
  const workspaces = new ProcessWorkspaces({
    secret: SECRET, home: '/tmp/home', user: 'me', port: async () => ++port, readyMs: 500, log: {},
    spawn: (command, args, options) => { const child = fakeChild(); spawned.push({ command, args, options, child }); return child; },
    fetchImpl: ready,
  });
  return { workspaces, spawned };
}

test('open starts one loopback runner per workspace and reuses it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pw-'));
  const { workspaces, spawned } = harness();
  const [a, b] = await Promise.all([workspaces.open({ id: 'work', root }), workspaces.open({ id: 'work', root })]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(a, b);
  assert.equal(a.token, workspaces.token('work'));
  const env = spawned[0].options.env;
  assert.equal(env.CANOPY_WORKSPACE_ROOT, root);
  assert.equal(env.CANOPY_AGENT_HOME, '/tmp/home');
  assert.equal(env.CANOPY_RUNNER_BIND, '127.0.0.1');
  assert.equal(a.url, `http://127.0.0.1:${env.CANOPY_RUNNER_PORT}`);
  assert.equal(a.nativeUrl, `http://127.0.0.1:${env.CANOPY_NATIVE_PORT}`);
});

test('a runner that exits is started again on the next open', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pw-'));
  const { workspaces, spawned } = harness();
  await workspaces.open({ id: 'work', root });
  spawned[0].child.emit('exit', 1);
  await new Promise(resolve => setImmediate(resolve));
  await workspaces.open({ id: 'work', root });
  assert.equal(spawned.length, 2);
});

test('a runner that dies while starting fails open, and the next open retries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pw-'));
  const { workspaces, spawned } = harness({ ready: async () => { throw new Error('refused'); } });
  const opening = workspaces.open({ id: 'work', root });
  await new Promise(resolve => setTimeout(resolve, 20));
  spawned[0].child.emit('exit', 1);
  await assert.rejects(opening, /exited during start/);
  assert.equal(workspaces.running.size, 0);
});

test('initHost writes a valid single-user setup once and never overwrites it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ch-'));
  const first = await initHost({ home });
  assert.equal(first.created, true);
  const config = validateConfig(JSON.parse(await readFile(first.config, 'utf8')));
  const token = (await readFile(first.token, 'utf8')).trim();
  assert.equal(config.principals[0].tokenSha256, digest(token));
  assert.equal(config.workspaces[0].root, path.join(home, 'work'));
  assert.equal((await stat(first.token)).mode & 0o777, 0o600);
  assert.equal((await initHost({ home })).created, false);
  assert.equal((await readFile(hostPaths(home).token, 'utf8')).trim(), token);
});

test('the user service runs serve without the harness daemon', () => {
  const unit = serviceUnit({ node: '/usr/bin/node', script: '/opt/ch/canopy-host.mjs' });
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/ch\/canopy-host\.mjs serve$/m);
  assert.match(unit, /CANOPY_SERVICE_ADMIN_SOCKET=off/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('the connect link carries the address, and the token only in the fragment', async () => {
  const { connectLink, tailnetAddress } = await import('./canopy-host.mjs');
  assert.equal(connectLink('100.64.1.2', 'a/b'), 'http://100.64.1.2:8787/connect#token=a%2Fb');
  assert.equal(tailnetAddress(() => '100.101.2.3\nfd7a::1'), '100.101.2.3');
  assert.equal(tailnetAddress(() => '10.0.0.5'), null);
  assert.equal(tailnetAddress(() => null), null);
});

test('the link uses the MagicDNS name, never a public one', async () => {
  const { tailnetName } = await import('./canopy-host.mjs');
  assert.equal(tailnetName(() => JSON.stringify({ Self: { DNSName: 'box.tail1234.ts.net.' } })), 'box.tail1234.ts.net');
  assert.equal(tailnetName(() => JSON.stringify({ Self: { DNSName: 'box.example.com.' } })), null);
  assert.equal(tailnetName(() => 'not json'), null);
});

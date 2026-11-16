import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const load = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  "const p=await import('./paths.mjs');console.log(JSON.stringify(p))"], { cwd: import.meta.dirname, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));

test('defaults are the workspace image layout', () => {
  const p = load({});
  assert.equal(p.WORKSPACE_ROOT, '/workspace');
  assert.equal(p.AGENT_HOME, '/home/agent');
  assert.equal(p.AGENT_USER, 'agent');
  assert.equal(p.CANOPY_CODE, '/opt/canopy');
  assert.equal(p.RUNNER_URL, 'http://127.0.0.1:8080');
  assert.equal(p.NATIVE_PORT, 8081);
  assert.equal(p.RUNNER_BIND, '0.0.0.0');
});

test('a process workspace overrides them, and bad values fall back', () => {
  const p = load({ CANOPY_WORKSPACE_ROOT: '/home/me/work/', CANOPY_AGENT_HOME: 'relative', CANOPY_RUNNER_PORT: '41000', CANOPY_NATIVE_PORT: '99999', CANOPY_RUNNER_BIND: '127.0.0.1' });
  assert.equal(p.WORKSPACE_ROOT, '/home/me/work');
  assert.equal(p.AGENT_HOME, '/home/agent');
  assert.equal(p.RUNNER_URL, 'http://127.0.0.1:41000');
  assert.equal(p.NATIVE_PORT, 8081);
  assert.equal(p.RUNNER_BIND, '127.0.0.1');
});

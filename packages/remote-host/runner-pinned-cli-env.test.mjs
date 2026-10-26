import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRunner, pinnedCliEnv, PINNED_CLI_ENV_KEYS } from './runner.mjs';

// agents.lock.json pins every CLI; the self-updating ones (Claude Code, Grok,
// Antigravity) must be told not to replace the pinned build in the
// persistent home. The image sets the switches; sessions get an explicit env,
// so the runner has to carry them across.

test('the image sets every pinned-CLI switch the runner forwards', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  for (const key of PINNED_CLI_ENV_KEYS) assert.match(dockerfile, new RegExp(`^ENV .*\\b${key}=`, 'm'), key);
});

test('only switches the environment actually sets are forwarded', () => {
  assert.deepEqual(pinnedCliEnv({ DISABLE_AUTOUPDATER: '1', PATH: '/bin' }), { DISABLE_AUTOUPDATER: '1' });
  assert.deepEqual(pinnedCliEnv({}), {});
  assert.deepEqual(pinnedCliEnv(undefined), {});
});

test('terminal sessions inherit the pinned-CLI switches', async t => {
  const environment = { DISABLE_AUTOUPDATER: '1', GROK_DISABLE_AUTOUPDATER: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  let seen = null;
  const server = createRunner({
    secret: 'x'.repeat(64),
    environment,
    spawnPty: (_bin, _args, options) => { seen = options.env; return { onData() {}, onExit() {} }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/sessions`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + 'x'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'pinned-cli-session', command: 'claude' }),
  });
  assert.equal(response.status, 200);
  for (const [key, value] of Object.entries(environment)) assert.equal(seen?.[key], value, key);
});

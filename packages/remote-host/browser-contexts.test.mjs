// Ported from T3 Code (MIT) apps/server/src/preview/ServerBrowserContexts.test.ts
// (pingdotgg/t3code d5290e9): the persistent-profile cases. Canopy has no
// shared or isolated browser, so those cases are not ported. A real temp
// directory stands in for T3's mocked node:fs/promises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserContexts } from './browser-contexts.mjs';

const makeContext = () => {
  const events = new EventEmitter();
  let closed = false;
  const context = {
    closes: 0,
    on: (event, listener) => events.on(event, listener),
    pages: () => [],
    close: async () => {
      context.closes++;
      if (!closed) { closed = true; events.emit('close'); }
    },
  };
  return context;
};
const exists = path => stat(path).then(() => true, () => false);

async function pool(t, options = {}) {
  const profilesDir = await mkdtemp(join(tmpdir(), 'browser-contexts-'));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const launches = [];
  const contexts = new BrowserContexts({
    profilesDir,
    launch: async directory => { launches.push(directory); const context = options.makeContext?.() ?? makeContext(); return context; },
    ...options,
  });
  return { contexts, launches, profilesDir };
}

test('keeps one persistent context per profile directory, with T3 path encoding', async t => {
  const { contexts, launches, profilesDir } = await pool(t);
  const [first, second] = await Promise.all([contexts.contextFor('work/team'), contexts.contextFor('work/team')]);
  assert.equal(first, second);
  assert.equal(await contexts.contextFor('work/team'), first);
  assert.deepEqual(launches, [join(profilesDir, 'work%2Fteam')]);
  assert.equal(contexts.profileDirectory('..'), join(profilesDir, '%2E%2E'));
  assert.equal(contexts.profileDirectory('agent-tools'), join(profilesDir, 'agent-tools'));
  await contexts.close();
  assert.equal(first.closes, 1);
});

test('closes the pages a persistent context restores', async t => {
  let closedPages = 0;
  const { contexts } = await pool(t, { makeContext: () => ({ ...makeContext(), pages: () => [{ close: async () => { closedPages++; } }] }) });
  await contexts.contextFor('default');
  assert.equal(closedPages, 1);
  await contexts.close();
});

test('clears a profile by closing its open context before deleting its storage', async t => {
  const onContextClose = [];
  const { contexts, profilesDir } = await pool(t, { onContextClose: context => onContextClose.push(context) });
  const persistent = await contexts.contextFor('work/team');
  const directory = join(profilesDir, 'work%2Fteam');
  await writeFile(join(directory, 'SingletonLock'), '');
  let existedAtClose;
  const close = persistent.close;
  persistent.close = async () => { existedAtClose = await exists(directory); await close(); };
  await contexts.clearProfile('work/team');
  assert.equal(existedAtClose, true, 'the context closes before its directory goes');
  assert.deepEqual(onContextClose, [persistent]);
  assert.equal(await exists(directory), false);
  assert.notEqual(await contexts.contextFor('work/team'), persistent);
  await contexts.clearProfile('never-opened');
  await contexts.close();
});

test('waits for the context to close when the same profile is cleared concurrently', async t => {
  const human = makeContext();
  const closed = Promise.withResolvers();
  let closes = 0;
  human.close = async () => { closes++; await closed.promise; };
  const { contexts, profilesDir } = await pool(t, { makeContext: () => human });
  await contexts.contextFor('work/team');
  const directory = join(profilesDir, 'work%2Fteam');
  const first = contexts.clearProfile('work/team');
  const second = contexts.clearProfile('work/team');
  await new Promise(resolve => setTimeout(resolve, 20));
  const deletedBeforeClose = !(await exists(directory));
  closed.resolve();
  await Promise.all([first, second]);
  assert.equal(deletedBeforeClose, false);
  assert.equal(closes, 1);
  assert.equal(await exists(directory), false);
  await contexts.close();
});

test('opens a profile requested during its clear only after the storage is deleted', async t => {
  const launchedAfterDelete = [];
  const { contexts, profilesDir } = await pool(t);
  const directory = join(profilesDir, 'work%2Fteam');
  await contexts.contextFor('work/team');
  await writeFile(join(directory, 'Cookies'), 'old');
  contexts.options.launch = async () => { launchedAfterDelete.push(!(await exists(join(directory, 'Cookies')))); return makeContext(); };
  const clearing = contexts.clearProfile('work/team');
  const reopening = contexts.contextFor('work/team');
  await Promise.all([clearing, reopening]);
  assert.deepEqual(launchedAfterDelete, [true]);
  await contexts.close();
});

test('a context that closes by itself is relaunched on the next request', async t => {
  const { contexts, launches } = await pool(t);
  const first = await contexts.contextFor('default');
  await first.close();
  assert.notEqual(await contexts.contextFor('default'), first);
  assert.equal(launches.length, 2);
  await contexts.close();
});

test('cleans up a context whose launch finishes during shutdown and rejects future work', async t => {
  const launch = Promise.withResolvers();
  const late = makeContext();
  const { contexts } = await pool(t);
  contexts.options.launch = () => launch.promise;
  const opening = assert.rejects(contexts.contextFor('default'), /closed/);
  const closing = contexts.close();
  assert.equal(contexts.close(), closing, 'close is idempotent');
  launch.resolve(late);
  await Promise.all([opening, closing]);
  await assert.rejects(contexts.contextFor('default'), /closed/);
  assert.equal(late.closes >= 1, true);
});

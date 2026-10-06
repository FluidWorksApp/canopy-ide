import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('initialization separates secrets and refuses to overwrite deployed grants', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canopy-init-'));
  try {
    const init = new URL('./init.mjs', import.meta.url).pathname;
    const output = execFileSync(process.execPath, [init, directory], { encoding: 'utf8' });
    const tokens = JSON.parse(await readFile(path.join(directory, 'access-tokens.json'), 'utf8'));
    const config = await readFile(path.join(directory, 'host.json'), 'utf8');
    for (const token of Object.values(tokens)) { assert.ok(!config.includes(token)); assert.ok(!output.includes(token)); }
    assert.equal((await stat(path.join(directory, 'access-tokens.json'))).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, [init, directory], { stdio: 'ignore' }));
    assert.equal(await readFile(path.join(directory, 'host.json'), 'utf8'), config);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'access-tokens.json'), 'utf8')), tokens);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

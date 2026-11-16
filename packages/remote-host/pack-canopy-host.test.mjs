import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { manifest, packageFiles } from './pack-canopy-host.mjs';
import { installPlan } from './canopy-host.mjs';

test('the package holds every module the host loads, and no tests', async () => {
  const files = await packageFiles();
  const packed = new Set(files);
  for (const entry of ['canopy-host.mjs', 'runner.mjs', 'native.mjs', 'paths.mjs', 'process-workspaces.mjs', 'gateway.mjs']) assert.ok(packed.has(entry), entry);
  assert.equal(files.some(f => f.endsWith('.test.mjs')), false);
  for (const file of files.filter(f => f.endsWith('.mjs'))) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    // Static and dynamic imports, URLs next to the module, and CANOPY_CODE + '/x.mjs' paths.
    for (const [, target] of source.matchAll(/(?:(?:from\s*|import\s*\(\s*|new URL\(\s*)['"]\.\/|CANOPY_CODE\s*\+\s*['"]\/)([\w.-]+\.(?:mjs|json))['"]/g))
      assert.ok(packed.has(target) || target === 'package.json', `${file} needs ${target}`);
  }
});

test('the manifest runs the CLI, installs node-pty prebuilt, and leaves out unused packages', () => {
  const own = { ws: '8.22.0', 'node-pty': '1.1.0', '@novnc/novnc': '1.7.0', '@xterm/headless': '6.0.0', '@xterm/addon-serialize': '0.14.0', '@xterm/addon-unicode11': '0.9.0', 'playwright-core': '1.0.0' };
  const m = manifest({ version: '0.1.0', dependencies: own });
  assert.deepEqual(m.bin, { 'canopy-host': 'canopy-host.mjs' });
  assert.equal(m.name, 'canopy-host');
  assert.deepEqual(m.os, ['linux']);
  assert.equal(m.dependencies['node-pty'], 'npm:@lydell/node-pty@1.1.0');
  assert.equal('@novnc/novnc' in m.dependencies, false);
  assert.equal(m.dependencies.ws, '8.22.0');
});

test('up installs an npx copy under ~/.canopy-host/app and runs the service from there', () => {
  const cached = installPlan({ codeDir: '/home/me/.npm/_npx/ab12/node_modules/canopy-host', home: '/home/me', name: 'canopy-host', version: '0.1.0' });
  assert.deepEqual(cached, { install: 'canopy-host@0.1.0', prefix: '/home/me/.canopy-host/app', script: '/home/me/.canopy-host/app/node_modules/canopy-host/canopy-host.mjs' });
  assert.deepEqual(installPlan({ codeDir: '/opt/ch', home: '/home/me', name: 'canopy-host', version: '0.1.0' }), { install: null, script: '/opt/ch/canopy-host.mjs' });
  assert.equal(installPlan({ codeDir: '/home/me/.npm/_npx/x/node_modules/r', home: '/home/me', name: '@canopy/remote-host', version: '0.1.0' }).install, null);
});

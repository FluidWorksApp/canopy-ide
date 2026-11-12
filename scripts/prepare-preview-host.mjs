// Stages the preview browser host (packages/remote-host/preview-host.mjs and
// the modules it runs on) with its two runtime dependencies into
// src-tauri/preview-host, which tauri.conf.json bundles as a resource.
// src-tauri/src/preview_host.rs runs it with the user's Node.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'packages/remote-host');
const require = createRequire(resolve(source, 'package.json'));
const target = resolve(root, 'src-tauri/preview-host');
export const PREVIEW_HOST_FILES = ['preview-host.mjs', 'agent-browser.mjs', 'browser-contexts.mjs', 'session-control.mjs', 'browser-stream.mjs', 'browser-install.mjs', 'browser-pins.json'];

await rm(resolve(target, 'node_modules'), { recursive: true, force: true });
await mkdir(resolve(target, 'node_modules'), { recursive: true });
for (const file of PREVIEW_HOST_FILES) await cp(resolve(source, file), resolve(target, file));
await cp(resolve(root, 'src-tauri/src/preview_picker.js'), resolve(target, 'preview_picker.js'));
await writeFile(resolve(target, 'package.json'), `${JSON.stringify({ name: 'canopy-preview-host', private: true, type: 'module' }, null, 2)}\n`);
for (const dependency of ['playwright-core', 'ws']) {
  await cp(dirname(require.resolve(`${dependency}/package.json`)), resolve(target, 'node_modules', dependency), { recursive: true });
}
console.log('Preview browser host staged.');

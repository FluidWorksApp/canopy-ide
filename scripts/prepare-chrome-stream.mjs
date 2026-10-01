import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/chrome-stream/package.json', import.meta.url));
const target = resolve(root, 'src-tauri/chrome-stream');
await mkdir(resolve(target, 'node_modules'), { recursive: true });
for (const file of ['package.json', 'server.mjs', 'protocol.mjs', 'playwright.mjs', 'viewer.html', 'viewer.js']) {
  await cp(resolve(root, 'packages/chrome-stream', file), resolve(target, file));
}
await cp(resolve(root, 'src-tauri/src/preview_picker.js'), resolve(target, 'preview_picker.js'));
await rm(resolve(target, 'node_modules/playwright-core'), { recursive: true, force: true });
await cp(dirname(require.resolve('playwright-core/package.json')), resolve(target, 'node_modules/playwright-core'), { recursive: true });
console.log('Chrome streaming bridge staged.');

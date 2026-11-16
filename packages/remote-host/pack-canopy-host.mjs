#!/usr/bin/env node
// Builds the npm package `canopy-host` into a folder: node pack-canopy-host.mjs <out-dir> <version>
// The host's own package.json stays as it is (the Docker image and release scripts use it).
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = ['agents.lock.json', 'browser-pins.json'];
// Imported at runtime by canopy-host, runner.mjs and native.mjs. node-pty is the prebuilt fork,
// so installing needs no compiler; it keeps the `node-pty` name so the code is unchanged.
const DEPENDENCIES = ['@xterm/addon-serialize', '@xterm/addon-unicode11', '@xterm/headless', 'playwright-core', 'ws'];
const PTY = 'npm:@lydell/node-pty@1.1.0';

/** Every non-test module, plus the data files the runner reads. */
export async function packageFiles(dir = HERE) {
  const names = await readdir(dir);
  return [...names.filter(n => n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !n.startsWith('smoke-') && n !== 'pack-canopy-host.mjs'), ...DATA].sort();
}

export function manifest({ version, dependencies }) {
  return {
    name: 'canopy-host', version,
    description: 'Run a Canopy workspace on any Linux machine and connect to it from the Canopy app.',
    license: 'MIT', type: 'module', os: ['linux'], engines: { node: '>=22' },
    bin: { 'canopy-host': 'canopy-host.mjs' },
    homepage: 'https://github.com/FluidWorksApp/canopy-ide/tree/main/packages/remote-host',
    repository: { type: 'git', url: 'git+https://github.com/FluidWorksApp/canopy-ide.git', directory: 'packages/remote-host' },
    dependencies: { ...Object.fromEntries(DEPENDENCIES.map(name => [name, dependencies[name]])), 'node-pty': PTY },
  };
}

const README = `# canopy-host

Run a Canopy workspace on any Linux machine, then connect to it from the Canopy app.

    npx canopy-host up

\`up\` checks the machine, sets up one workspace in \`~/work\`, installs a user service
(systemd, no root) and prints a link. In Canopy, open **Add a workspace › Your own machine**
and paste the link.

- On a Tailscale network the link uses this machine's tailnet name.
- Otherwise it prints an \`ssh -L\` command to run on your computer first.
- \`npx canopy-host link\` prints the link again. \`npx canopy-host status\` shows whether it runs.

Needs Linux with Node.js 22 or newer, git and systemd. Workspaces run as your user, without containers.
`;

async function main([out, version]) {
  if (!out || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) { console.error('Usage: node pack-canopy-host.mjs <out-dir> <version>'); process.exit(2); }
  const own = JSON.parse(await readFile(path.join(HERE, 'package.json'), 'utf8'));
  await mkdir(out, { recursive: true });
  for (const file of await packageFiles()) await copyFile(path.join(HERE, file), path.join(out, file));
  await copyFile(path.join(HERE, '../../LICENSE.md'), path.join(out, 'LICENSE.md'));
  await writeFile(path.join(out, 'README.md'), README);
  await writeFile(path.join(out, 'package.json'), JSON.stringify(manifest({ version, dependencies: own.dependencies }), null, 2) + '\n');
  console.log(`canopy-host ${version} → ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

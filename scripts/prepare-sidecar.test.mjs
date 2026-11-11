import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SIDECARS = ['canopy-hook', 'canopy-pty-host'];
const TRIPLE = 'x86_64-pc-windows-msvc';

// A scratch repo with a fake `cargo` on PATH. Each call is appended to a log;
// a build reports the artifact for the `--bin` it was asked for (or nothing in
// 'empty' mode), and `metadata` reports the fake target directory.
async function fixture(mode) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canopy-sidecar-test-')));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'tools'));
  await copyFile(new URL('./prepare-sidecar.mjs', import.meta.url), join(root, 'scripts/prepare-sidecar.mjs'));
  const output = join(root, 'cargo-output');
  await mkdir(output);
  const binaries = {};
  for (const name of SIDECARS) {
    binaries[name] = join(output, name);
    await writeFile(binaries[name], `synthetic ${name}`);
  }
  const log = join(root, 'calls.jsonl');
  const tool = join(root, 'tools/cargo');
  await writeFile(
    tool,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'metadata') {
  console.log(JSON.stringify({ target_directory: ${JSON.stringify(output)} }));
} else if (${JSON.stringify(mode)} === 'empty') {
  console.log('');
} else {
  const name = args[args.indexOf('--bin') + 1];
  console.log(JSON.stringify({ reason: 'compiler-artifact', target: { name }, executable: ${JSON.stringify(output)} + '/' + name }));
}
`,
    { mode: 0o755 },
  );
  const calls = async () =>
    (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return {
    root,
    output,
    binaries,
    calls,
    env: { ...process.env, PATH: join(root, 'tools') + ':' + process.env.PATH, TAURI_ENV_TARGET_TRIPLE: TRIPLE },
  };
}

const run = (f, opts = {}) =>
  execFileSync(process.execPath, [join(f.root, 'scripts/prepare-sidecar.mjs'), '--release'], { env: f.env, ...opts });

test('every sidecar is built from its own manifest and staged without a Tauri placeholder', async () => {
  const f = await fixture();
  try {
    run(f);
    const builds = (await f.calls()).filter((args) => args[0] === 'build');
    assert.equal(builds.length, 2);
    for (const args of builds) {
      assert.ok(args.includes('--release'));
      assert.equal(args[args.indexOf('--target') + 1], TRIPLE);
    }
    const manifest = (name) => {
      const args = builds.find((a) => a[a.indexOf('--bin') + 1] === name);
      return args[args.indexOf('--manifest-path') + 1];
    };
    assert.equal(manifest('canopy-hook'), join(f.root, 'packages/agent-hook/Cargo.toml'));
    assert.equal(manifest('canopy-pty-host'), join(f.root, 'crates/canopy-pty-host/Cargo.toml'));
    for (const name of SIDECARS) {
      const staged = await readFile(join(f.root, `src-tauri/binaries/${name}-${TRIPLE}.exe`));
      assert.equal(staged.toString(), `synthetic ${name}`);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('empty build output resolves the actual Cargo target directory rather than assuming app target layout', async () => {
  const f = await fixture('empty');
  try {
    const dir = join(f.output, TRIPLE, 'release');
    await mkdir(dir, { recursive: true });
    for (const name of SIDECARS) await copyFile(f.binaries[name], join(dir, `${name}.exe`));
    run(f);
    for (const name of SIDECARS) {
      assert.ok((await stat(join(f.root, `src-tauri/binaries/${name}-${TRIPLE}.exe`))).size > 0);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a zero-length artifact is rejected instead of staging a broken sidecar', async () => {
  for (const name of SIDECARS) {
    const f = await fixture();
    try {
      await writeFile(f.binaries[name], '');
      assert.throws(() => run(f, { stdio: 'pipe' }), `${name} must not be staged empty`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

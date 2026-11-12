import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// What every release builds. canopy-term-app is not in this list: it is built
// for macOS and Linux release builds only (see TERM_APP).
const SIDECARS = ['canopy-hook', 'canopy-pty-host'];
const TERM_APP = 'canopy-term-app';
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
  for (const name of [...SIDECARS, TERM_APP]) {
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

// A fake `codesign` that logs its arguments, next to the fake cargo.
async function withFakeCodesign(f, { fail = false } = {}) {
  const log = join(f.root, 'codesign.jsonl');
  await writeFile(
    join(f.root, 'tools/codesign'),
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(${fail ? 1 : 0});
`,
    { mode: 0o755 },
  );
  return async () => {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
}

const MAC = 'aarch64-apple-darwin';

test('a macOS release signs a separate copy of the host with its own entitlements', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const codesigns = await withFakeCodesign(f);
    run({ ...f, env: { ...f.env, TAURI_ENV_TARGET_TRIPLE: MAC, APPLE_SIGNING_IDENTITY: 'Developer ID: Test' } });
    const staged = join(f.root, 'src-tauri/binaries/canopy-pty-host-signed');
    assert.equal((await readFile(staged)).toString(), 'synthetic canopy-pty-host');
    const calls = await codesigns();
    // The host is signed and verified first, then the terminal app (below).
    assert.equal(calls.length, 4);
    const [sign, verify] = calls;
    assert.ok(sign.includes('--force') && sign.includes('--timestamp'));
    assert.equal(sign[sign.indexOf('--options') + 1], 'runtime');
    assert.equal(
      sign[sign.indexOf('--entitlements') + 1],
      join(f.root, 'src-tauri/pty-host-entitlements.plist'),
    );
    assert.equal(sign[sign.indexOf('--sign') + 1], 'Developer ID: Test');
    assert.equal(sign.at(-1), staged);
    assert.deepEqual(verify, ['--verify', '--strict', staged]);
    // The hook helper is left to the bundler: only the host and the terminal
    // app get a signed copy.
    await assert.rejects(stat(join(f.root, 'src-tauri/binaries/canopy-hook-signed')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('without a signing identity the host copy is staged unsigned and codesign is never run', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const codesigns = await withFakeCodesign(f);
    const env = { ...f.env, TAURI_ENV_TARGET_TRIPLE: MAC };
    delete env.APPLE_SIGNING_IDENTITY;
    run({ ...f, env });
    assert.ok((await stat(join(f.root, 'src-tauri/binaries/canopy-pty-host-signed'))).size > 0);
    assert.ok((await stat(join(f.root, 'src-tauri/binaries/canopy-term-app-signed'))).size > 0);
    assert.deepEqual(await codesigns(), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a codesign failure fails the build before anything is bundled', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await withFakeCodesign(f, { fail: true });
    assert.throws(() =>
      run(
        { ...f, env: { ...f.env, TAURI_ENV_TARGET_TRIPLE: MAC, APPLE_SIGNING_IDENTITY: 'x' } },
        { stdio: 'pipe' },
      ),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('non-macOS targets stage no signed host copy', async () => {
  const f = await fixture();
  try {
    run(f);
    await assert.rejects(stat(join(f.root, 'src-tauri/binaries/canopy-pty-host-signed')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the macOS release config swaps the host from externalBin to an unsigned-by-bundler file', async () => {
  const base = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const over = JSON.parse(await readFile(new URL('../src-tauri/tauri.release-macos.conf.json', import.meta.url), 'utf8'));
  assert.ok(base.bundle.externalBin.includes('binaries/canopy-pty-host'));
  assert.deepEqual(over.bundle.externalBin, base.bundle.externalBin.filter((b) => b !== 'binaries/canopy-pty-host'));
  assert.equal(over.bundle.macOS.files['MacOS/canopy-pty-host'], 'binaries/canopy-pty-host-signed');
  // The host's plist must really grant nothing.
  const plist = await readFile(new URL('../src-tauri/pty-host-entitlements.plist', import.meta.url), 'utf8');
  assert.ok(!/<key>/.test(plist));
});

const LINUX = 'x86_64-unknown-linux-gnu';

const buildsOf = async (f) => (await f.calls()).filter((args) => args[0] === 'build');
const binOf = (args) => args[args.indexOf('--bin') + 1];

test('a Linux release builds the terminal app from its own manifest and stages it as an externalBin', async () => {
  const f = await fixture();
  try {
    run({ ...f, env: { ...f.env, TAURI_ENV_TARGET_TRIPLE: LINUX } });
    const builds = await buildsOf(f);
    assert.deepEqual(builds.map(binOf), ['canopy-hook', 'canopy-pty-host', TERM_APP]);
    const args = builds.find((a) => binOf(a) === TERM_APP);
    assert.equal(args[args.indexOf('--manifest-path') + 1], join(f.root, 'crates/canopy-term-app/Cargo.toml'));
    assert.equal(args[args.indexOf('--target') + 1], LINUX);
    assert.ok(args.includes('--release'));
    assert.equal(
      (await readFile(join(f.root, `src-tauri/binaries/${TERM_APP}-${LINUX}`))).toString(),
      `synthetic ${TERM_APP}`,
    );
    // Nothing is signed or copied for Linux.
    await assert.rejects(stat(join(f.root, 'src-tauri/binaries/canopy-term-app-signed')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the terminal app is not built for Windows, so Windows packaging needs no Zig', async () => {
  const f = await fixture();
  try {
    run(f);
    assert.ok(!(await buildsOf(f)).some((a) => binOf(a) === TERM_APP));
    await assert.rejects(stat(join(f.root, `src-tauri/binaries/${TERM_APP}-${TRIPLE}.exe`)));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a debug build skips the terminal app, so `tauri dev` needs no Zig', async () => {
  const f = await fixture();
  try {
    execFileSync(process.execPath, [join(f.root, 'scripts/prepare-sidecar.mjs')], {
      env: { ...f.env, TAURI_ENV_TARGET_TRIPLE: LINUX },
    });
    assert.deepEqual((await buildsOf(f)).map(binOf), ['canopy-hook', 'canopy-pty-host']);
    await assert.rejects(stat(join(f.root, `src-tauri/binaries/${TERM_APP}-${LINUX}`)));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a macOS release signs a separate copy of the terminal app with its own empty entitlements', { skip: process.platform === 'win32' }, async () => {
  for (const triple of [MAC, 'x86_64-apple-darwin']) {
    const f = await fixture();
    try {
      const codesigns = await withFakeCodesign(f);
      run({ ...f, env: { ...f.env, TAURI_ENV_TARGET_TRIPLE: triple, APPLE_SIGNING_IDENTITY: 'Developer ID: Test' } });
      const staged = join(f.root, 'src-tauri/binaries/canopy-term-app-signed');
      assert.equal((await readFile(staged)).toString(), `synthetic ${TERM_APP}`);
      const calls = (await codesigns()).filter((c) => c.at(-1) === staged);
      assert.equal(calls.length, 2, `sign and verify for ${triple}`);
      const [sign, verify] = calls;
      assert.ok(sign.includes('--force') && sign.includes('--timestamp'));
      assert.equal(sign[sign.indexOf('--options') + 1], 'runtime');
      assert.equal(sign[sign.indexOf('--entitlements') + 1], join(f.root, 'src-tauri/term-app-entitlements.plist'));
      assert.equal(sign[sign.indexOf('--sign') + 1], 'Developer ID: Test');
      assert.deepEqual(verify, ['--verify', '--strict', staged]);
      // The host's own signing is unchanged by the terminal app.
      const host = join(f.root, 'src-tauri/binaries/canopy-pty-host-signed');
      const hostSign = (await codesigns()).find((c) => c.at(-1) === host && c.includes('--sign'));
      assert.equal(hostSign[hostSign.indexOf('--entitlements') + 1], join(f.root, 'src-tauri/pty-host-entitlements.plist'));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('the release configs bundle the terminal app on macOS and Linux only, and never as a macOS externalBin', async () => {
  const read = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url), 'utf8'));
  const base = await read('../src-tauri/tauri.conf.json');
  const mac = await read('../src-tauri/tauri.release-macos.conf.json');
  const linux = await read('../src-tauri/tauri.release-linux.conf.json');
  const win = await read('../src-tauri/tauri.windows.conf.json');
  // Not in the base config: dev and CI builds do not stage it (CI stubs only hook and host).
  assert.ok(!base.bundle.externalBin.includes('binaries/canopy-term-app'));
  assert.ok(!(win.bundle?.externalBin ?? []).includes('binaries/canopy-term-app'));
  // macOS: a bundle file the bundler never signs, not an externalBin it would sign with the app's entitlements.
  assert.equal(mac.bundle.macOS.files['MacOS/canopy-term-app'], 'binaries/canopy-term-app-signed');
  assert.ok(!mac.bundle.externalBin.some((b) => b.includes('canopy-term-app')));
  // Linux: the base list plus the terminal app (a --config array replaces, it does not append).
  assert.deepEqual(linux.bundle.externalBin, [...base.bundle.externalBin, 'binaries/canopy-term-app']);
  const plist = await readFile(new URL('../src-tauri/term-app-entitlements.plist', import.meta.url), 'utf8');
  assert.ok(!/<key>/.test(plist));
});

test('the release workflow installs Zig before the build, passes the Linux config, and verifies the bundled terminal app', async () => {
  const yml = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const build = yml.slice(yml.indexOf('\n  build:\n'));
  assert.ok(build.indexOf('./.github/actions/install-zig') > 0);
  assert.ok(build.indexOf('./.github/actions/install-zig') < build.indexOf('tauri-apps/tauri-action'));
  assert.match(build, /if: matrix\.platform != 'windows-latest'/);
  assert.match(build, /args: "--config src-tauri\/tauri\.release-linux\.conf\.json"/);
  assert.match(build, /Verify the terminal app is bundled and signed \(macOS\)/);
  assert.match(build, /Verify the terminal app is bundled \(Linux\)/);
});

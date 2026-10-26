import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile, chmod, mkdir, readlink, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CLIPBOARD_MAX_BYTES, CLIPBOARD_TOOLS, installClipboardShims} from './clipboard-shims.mjs';

const OSC = text => `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canopy-clipboard-'));
  const bin = await installClipboardShims(path.join(root, 'shims'));
  const tty = path.join(root, 'tty');
  await writeFile(tty, '');
  return {root, bin, tty, cleanup: () => rm(root, {recursive: true, force: true})};
}

/** Run a shim with no controlling terminal (a new session), so its copy can
 *  only go to CANOPY_TTY — a plain file here. */
function run(bin, tool, args, {input = '', env = {}} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, tool), args, {
      detached: true,
      env: {PATH: `${bin}:/usr/bin:/bin`, TMPDIR: os.tmpdir(), ...env},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

test('the four names are links to one shim script', async () => {
  const {bin, cleanup} = await fixture();
  try {
    for (const tool of CLIPBOARD_TOOLS) assert.equal(await readlink(path.join(bin, tool)), 'canopy-clipboard');
    assert.equal((await stat(path.join(bin, 'canopy-clipboard'))).mode & 0o777, 0o755);
    // Installing again (every runner start) replaces it in place.
    await installClipboardShims(bin);
    assert.equal(await readlink(path.join(bin, 'xclip')), 'canopy-clipboard');
  } finally { await cleanup(); }
});

test('a copy to the clipboard becomes one OSC 52 sequence on the session terminal', async () => {
  const {bin, tty, cleanup} = await fixture();
  try {
    const env = {CANOPY_TTY: tty};
    const cases = [
      ['xclip', ['-selection', 'clipboard'], 'héllo\nworld\n'],
      ['xclip', ['-sel', 'c', '-i'], 'pyperclip'],
      ['xclip', ['-selection', 'clipboard', '-t', 'text/plain'], 'typed'],
      ['xsel', ['--clipboard', '--input'], 'xsel long'],
      ['xsel', ['-bi'], 'xsel short'],
      ['wl-copy', [], 'wayland'],
      ['pbcopy', [], 'mac habit'],
    ];
    for (const [tool, args, text] of cases) {
      await writeFile(tty, '');
      const result = await run(bin, tool, args, {input: text, env});
      assert.equal(result.code, 0, `${tool} ${args.join(' ')}: ${result.stderr}`);
      assert.equal(await readFile(tty, 'utf8'), OSC(text), `${tool} ${args.join(' ')}`);
    }
  } finally { await cleanup(); }
});

test('wl-copy copies its arguments, and trims a newline when asked', async () => {
  const {bin, tty, cleanup} = await fixture();
  try {
    assert.equal((await run(bin, 'wl-copy', ['two', 'words'], {env: {CANOPY_TTY: tty}})).code, 0);
    assert.equal(await readFile(tty, 'utf8'), OSC('two words'));
    await writeFile(tty, '');
    assert.equal((await run(bin, 'wl-copy', ['-n'], {input: 'line\n', env: {CANOPY_TTY: tty}})).code, 0);
    assert.equal(await readFile(tty, 'utf8'), OSC('line'));
    await writeFile(tty, '');
    assert.equal((await run(bin, 'xclip', ['-selection', 'clipboard', '-rmlastnl'], {input: 'x\n\n', env: {CANOPY_TTY: tty}})).code, 0);
    assert.equal(await readFile(tty, 'utf8'), OSC('x\n'));
  } finally { await cleanup(); }
});

test('xclip copies named files and -filter passes the text through', async () => {
  const {root, bin, tty, cleanup} = await fixture();
  try {
    const file = path.join(root, 'notes.txt');
    await writeFile(file, 'from a file');
    assert.equal((await run(bin, 'xclip', ['-selection', 'clipboard', file], {env: {CANOPY_TTY: tty}})).code, 0);
    assert.equal(await readFile(tty, 'utf8'), OSC('from a file'));
    await writeFile(tty, '');
    const filtered = await run(bin, 'xclip', ['-selection', 'clipboard', '-f'], {input: 'echoed', env: {CANOPY_TTY: tty}});
    assert.equal(filtered.stdout, 'echoed');
    assert.equal(await readFile(tty, 'utf8'), OSC('echoed'));
  } finally { await cleanup(); }
});

test('reads, images and the primary selection never reach the terminal', async () => {
  const {bin, tty, cleanup} = await fixture();
  try {
    const env = {CANOPY_TTY: tty};
    // No real tool in this PATH: a read is an empty clipboard, as xclip says it.
    for (const [tool, args] of [['xclip', ['-selection', 'clipboard', '-o']], ['xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']], ['xsel', ['--clipboard', '--output']]]) {
      const result = await run(bin, tool, args, {env});
      assert.equal(result.code, 1, `${tool} ${args.join(' ')}`);
      assert.equal(result.stdout, '');
    }
    assert.equal((await run(bin, 'xclip', ['-selection', 'clipboard', '-t', 'image/png'], {input: '\x89PNG', env})).code, 1);
    // Claude Code copies to both selections; only one clipboard write results.
    for (const [tool, args] of [['xclip', ['-selection', 'primary']], ['xclip', []], ['xsel', ['--primary', '--input']], ['wl-copy', ['--primary']]]) {
      const result = await run(bin, tool, args, {input: 'primary', env});
      assert.equal(result.code, 0, `${tool} ${args.join(' ')}`);
    }
    assert.equal(await readFile(tty, 'utf8'), '');
  } finally { await cleanup(); }
});

test('the real tool still answers what the shim does not handle', async () => {
  const {root, bin, tty, cleanup} = await fixture();
  try {
    const realBin = path.join(root, 'real');
    await mkdir(realBin);
    await writeFile(path.join(realBin, 'xclip'), '#!/bin/sh\necho "real xclip $*"\n');
    await chmod(path.join(realBin, 'xclip'), 0o755);
    const result = await run(bin, 'xclip', ['-selection', 'clipboard', '-o'], {env: {CANOPY_TTY: tty, PATH: `${bin}:${realBin}:/usr/bin:/bin`}});
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'real xclip -selection clipboard -o\n');
    // ...and the shim never mistakes itself, or a copy of itself, for it.
    const copyBin = path.join(root, 'copy');
    await installClipboardShims(copyBin);
    const looped = await run(bin, 'xclip', ['-o'], {env: {CANOPY_TTY: tty, PATH: `${bin}:${copyBin}:/usr/bin:/bin`}});
    assert.equal(looped.code, 1);
  } finally { await cleanup(); }
});

test('a copy over the terminal cap is refused, not truncated', async () => {
  const {bin, tty, cleanup} = await fixture();
  try {
    const result = await run(bin, 'xclip', ['-selection', 'clipboard'], {input: 'a'.repeat(CLIPBOARD_MAX_BYTES + 1), env: {CANOPY_TTY: tty}});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /1 MiB/);
    assert.equal(await readFile(tty, 'utf8'), '');
    const exact = await run(bin, 'xclip', ['-selection', 'clipboard'], {input: 'b'.repeat(CLIPBOARD_MAX_BYTES), env: {CANOPY_TTY: tty}});
    assert.equal(exact.code, 0);
    assert.equal((await readFile(tty, 'utf8')).length, OSC('b'.repeat(CLIPBOARD_MAX_BYTES)).length);
  } finally { await cleanup(); }
});

test('with no terminal at all the copy fails loudly', async () => {
  const {bin, cleanup} = await fixture();
  try {
    const result = await run(bin, 'pbcopy', [], {input: 'lost'});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no terminal/);
  } finally { await cleanup(); }
});

// The controlling-terminal path needs a real PTY; Python's pty module gives one.
const python = spawnSync('python3', ['-c', 'import pty'], {stdio: 'ignore'}).status === 0;
const PTY_RUN = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '-c', 'printf %s "$CLIP_TEXT" | "$CLIP_SHIM" -selection clipboard'])
out = b''
while True:
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
`;

test('on its controlling terminal, and wrapped for tmux passthrough inside tmux', {skip: !python && 'python3 is not available'}, async () => {
  const {bin, cleanup} = await fixture();
  try {
    const ptyRun = env => spawnSync('python3', ['-c', PTY_RUN], {env: {PATH: `${bin}:/usr/bin:/bin`, CLIP_SHIM: path.join(bin, 'xclip'), CLIP_TEXT: 'in a pty', ...env}, encoding: 'latin1'});
    const plain = ptyRun({});
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, OSC('in a pty'));
    const tmux = ptyRun({TMUX: '/tmp/tmux-1000/default,1,0'});
    const b64 = Buffer.from('in a pty').toString('base64');
    assert.equal(tmux.stdout, `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`);
  } finally { await cleanup(); }
});

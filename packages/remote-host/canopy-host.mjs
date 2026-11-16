#!/usr/bin/env node
// canopy-host: run a Canopy host on any Linux machine as the current user.
//   up      check the machine, create a single-user config, install the user service
//   serve   run the gateway with process workspaces (what the service runs)
//   link    print the link to paste into the app (Add a workspace › Your own machine)
//   token   print the bare access token
//   status  show whether the service is running
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, validateConfig } from './policy.mjs';

const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 8787;

export function hostPaths(home = os.homedir()) {
  const dir = path.join(home, '.canopy-host');
  return { dir, config: path.join(dir, 'host.json'), key: path.join(dir, 'host.key'), token: path.join(dir, 'access-token'), state: path.join(dir, 'state') };
}

/** One owner, one workspace rooted at `projects`. Never overwrites an existing setup. */
export async function initHost({ home = os.homedir(), projects = path.join(home, 'work') } = {}) {
  const paths = hostPaths(home);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  try { await access(paths.config); return { ...paths, created: false }; } catch {}
  const token = randomBytes(32).toString('base64url');
  const config = {
    workspaces: [{ id: 'work', name: path.basename(projects) || 'work', root: projects, memoryMiB: 512, cpus: 1, accounts: [] }],
    principals: [{ id: 'owner', tokenSha256: digest(token), scope: 'drive', workspaces: ['work'] }],
  };
  validateConfig(config);
  await writeFile(paths.token, token + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(paths.key, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  await writeFile(paths.config, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  await mkdir(projects, { recursive: true });
  return { ...paths, created: true };
}

export function serviceUnit({ node = process.execPath, script = path.join(CODE_DIR, 'canopy-host.mjs'), port = DEFAULT_PORT } = {}) {
  return `[Unit]
Description=Canopy host
After=network-online.target

[Service]
ExecStart=${node} ${script} serve
Environment=PORT=${port} CANOPY_SERVICE_ADMIN_SOCKET=off
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export async function listening(port, { host = '127.0.0.1', timeoutMs = 15000 } = {}) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise(r => setTimeout(r, 300))) {
    const ok = await new Promise(resolve => { const s = net.connect(port, host); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
    if (ok) return true;
  }
  return false;
}

const run = (command, args) => { try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };

export function checks() {
  const major = Number(process.versions.node.split('.')[0]);
  const claude = run('claude', ['--version']);
  return [
    { ok: major >= 22, label: `Node ${process.versions.node}`, fix: 'Install Node.js 22 or newer.' },
    { ok: !!run('git', ['--version']), label: 'git', fix: 'Install git.' },
    { ok: !!run('systemctl', ['--user', '--version']), label: 'systemd (user)', fix: 'This needs systemd.' },
    { ok: !!claude, optional: true, label: claude ? `claude ${claude.split(' ')[0]}` : 'claude not found', fix: 'Install Claude Code to run agents here.' },
    { ok: true, optional: true, label: run('docker', ['--version']) ? 'Docker found, but workspaces run as you (no containers)' : 'No Docker needed: workspaces run as you' },
  ];
}

/** The tailnet IPv4 address, read only; canopy-host never runs `tailscale up` or `serve`. */
export function tailnetAddress(read = () => run('tailscale', ['ip', '-4'])) {
  const ip = (read() ?? '').split('\n')[0].trim();
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(ip) ? ip : null;
}

/** This machine's MagicDNS name (box.tailnet.ts.net), which the app accepts over plain http. */
export function tailnetName(read = () => run('tailscale', ['status', '--json', '--self=true', '--peers=false'])) {
  try { const name = String(JSON.parse(read() ?? '').Self?.DNSName ?? '').replace(/\.$/, ''); return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(name) ? name : null; }
  catch { return null; }
}

/** What the app's link field takes. The token stays in the #fragment. */
export function connectLink(host, token, port = DEFAULT_PORT) {
  return `http://${host}:${port}/connect#token=${encodeURIComponent(token)}`;
}

function printLink(token) {
  const name = tailnetAddress() && tailnetName();
  if (name) console.log(`\nPaste this into Canopy (Add a workspace › Your own machine), from any device on your tailnet:\n\n  ${connectLink(name, token)}\n`);
  else console.log(`\nNo Tailscale here, so connect over SSH. On your computer run:\n  ssh -N -L ${DEFAULT_PORT}:127.0.0.1:${DEFAULT_PORT} ${os.userInfo().username}@<this machine>\n\nthen paste this into Canopy (Add a workspace › Your own machine):\n\n  ${connectLink('127.0.0.1', token)}\n`);
  console.log(`Show it again: ${process.execPath} ${path.join(CODE_DIR, 'canopy-host.mjs')} link`);
}

async function up(argv) {
  const flag = argv.indexOf('--projects');
  const projects = path.resolve(flag >= 0 && argv[flag + 1] ? argv[flag + 1] : path.join(os.homedir(), 'work'));
  console.log(`Canopy host · ${os.hostname()} (${process.platform} ${process.arch}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB)\n\nChecking this machine`);
  const results = checks();
  for (const c of results) console.log(`  ${c.ok ? '✓' : c.optional ? '·' : '✗'} ${c.label}${c.ok ? '' : ` (${c.fix})`}`);
  if (results.some(c => !c.ok && !c.optional)) process.exit(1);
  const setup = await initHost({ projects });
  const root = JSON.parse(await readFile(setup.config, 'utf8')).workspaces[0]?.root ?? projects;
  console.log(`\nProjects folder: ${root}${setup.created ? '' : ' (existing setup kept)'}`);
  const unitDir = path.join(os.homedir(), '.config/systemd/user');
  await mkdir(unitDir, { recursive: true });
  await writeFile(path.join(unitDir, 'canopy-host.service'), serviceUnit());
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', 'canopy-host']);
  run('systemctl', ['--user', 'restart', 'canopy-host']);
  if (!(await listening(DEFAULT_PORT))) { console.log('✗ The canopy-host service did not start. See: journalctl --user -u canopy-host'); process.exit(1); }
  const ip = tailnetAddress();
  console.log(`✓ Running, starts on boot · listening on 127.0.0.1${ip ? ` and your tailnet (${ip})` : ''}, never on public addresses`);
  if (run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']) !== 'yes') console.log(`· To keep it running after you log out: sudo loginctl enable-linger ${os.userInfo().username}`);
  printLink((await readFile(setup.token, 'utf8')).trim());
}

/** Forward the tailnet address to the loopback gateway, following the address if it appears or changes. */
function tailnetForwarder(port, { every = 30000 } = {}) {
  let current = null, server = null;
  const refresh = () => {
    const ip = tailnetAddress();
    if (ip === current) return;
    server?.close(); server = null; current = ip;
    if (!ip) return;
    server = net.createServer(socket => { const upstream = net.connect(port, '127.0.0.1'); socket.pipe(upstream).pipe(socket); socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); });
    server.on('error', error => { console.warn(`Tailnet listener on ${ip}: ${error.message}`); server = null; current = null; });
    server.listen(port, ip, () => console.log(`Canopy host listening on tailnet ${ip}`));
  };
  refresh();
  const timer = setInterval(refresh, every); timer.unref();
  return () => { clearInterval(timer); server?.close(); };
}

async function serve() {
  const paths = hostPaths();
  const config = validateConfig(JSON.parse(await readFile(process.env.CANOPY_HOST_CONFIG ?? paths.config, 'utf8')));
  const secret = (await readFile(paths.key, 'utf8')).trim();
  const [{ createGateway }, { ProcessWorkspaces }] = await Promise.all([import('./gateway.mjs'), import('./process-workspaces.mjs')]);
  const workspaces = new ProcessWorkspaces({ secret });
  const server = createGateway({ config, workspaces, hostName: os.hostname() });
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  let stopTailnet = () => {};
  const stop = () => { stopTailnet(); workspaces.close(); server.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  server.listen(port, '127.0.0.1', () => { console.log('Canopy host listening on loopback'); stopTailnet = tailnetForwarder(port); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'up', ...argv] = process.argv.slice(2);
  if (command === 'up') await up(argv);
  else if (command === 'serve') await serve();
  else if (command === 'token') console.log((await readFile(hostPaths().token, 'utf8')).trim());
  else if (command === 'link') printLink((await readFile(hostPaths().token, 'utf8')).trim());
  else if (command === 'status') console.log(run('systemctl', ['--user', 'is-active', 'canopy-host']) ?? 'not installed');
  else { console.error('Usage: canopy-host [up [--projects <dir>] | link | serve | token | status]'); process.exit(2); }
}

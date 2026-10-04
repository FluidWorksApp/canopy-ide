import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validId } from './policy.mjs';

// Operator-only interactive renewal. Credentials stay in Docker volumes and
// stdin, never enter API responses, host configuration or command arguments.
const account = process.argv[2];
if (!validId(account)) throw new Error('Usage: node accounts.mjs <account-id>');
if (!process.stdin.isTTY) throw new Error('Account login requires an interactive terminal');
const image = process.env.CANOPY_WORKSPACE_IMAGE ?? 'canopy-workspace:0.1.0';
const staging = `canopy-account-login-${randomUUID()}`;
const pool = `canopy-account-${account}`;
function docker(args, interactive = false) {
  const result = spawnSync('docker', args, { stdio: interactive ? 'inherit' : 'ignore' });
  if (result.error || result.status !== 0) throw new Error('Account provisioning operation failed');
}
try {
  docker(['volume', 'create', staging]);
  docker(['volume', 'create', pool]);
  const mounts = ['--mount', `type=volume,source=${staging},target=/login`, '--mount', `type=volume,source=${pool},target=/pool`];
  docker(['run', '--rm', '--user', '0:0', ...mounts, image, 'chown', '1000:1000', '/login', '/pool']);
  console.log('Log in with the provider CLI, then exit the shell to publish this account generation.');
  docker(['run', '--rm', '-it', '--init', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', '1g', '--memory-swap', '1g', '--pids-limit', '128', ...mounts.slice(0, 2),
    '--env', 'HOME=/login', '--env', 'CODEX_HOME=/login/.codex', '--env', 'CLAUDE_CONFIG_DIR=/login/.claude', image, '/bin/bash'], true);
  // An immutable generation and atomic pointer avoid readers seeing a half-copy.
  const publish = `const fs = require('node:fs/promises'); const crypto = require('node:crypto');
    (async () => {
      await fs.rm('/login/.bash_history', {force:true});
      const names = await fs.readdir('/login'); if (!names.length) throw Error('Empty login home');
      let bytes = 0, files = 0;
      const scan = async path => {
        for (const entry of await fs.readdir(path, {withFileTypes:true})) {
          const file = path + '/' + entry.name;
          if (++files > 4096 || entry.isSymbolicLink()) throw Error('Invalid account template');
          if (entry.isDirectory()) await scan(file); else bytes += (await fs.stat(file)).size;
          if (bytes > 64 * 1024 * 1024) throw Error('Account template too large');
        }
      };
      await scan('/login');
      const id = crypto.randomUUID(); const root = '/pool/generations/' + id;
      await fs.mkdir(root, {recursive:true,mode:448}); await fs.cp('/login', root, {recursive:true});
      await fs.writeFile(root + '/.canopy-account.json', JSON.stringify({createdAt:new Date().toISOString()}), {mode:384});
      const next = '/pool/.current-' + id; await fs.symlink('generations/' + id, next); await fs.rename(next, '/pool/current');
    })().catch(() => process.exit(1));`;
  docker(['run', '--rm', '--network', 'none', '--user', '1000:1000', ...mounts, image, 'node', '-e', publish]);
  console.log('Account generation published. New sessions use it; running sessions retain their private profile.');
} finally { spawnSync('docker', ['volume', 'rm', staging], { stdio: 'ignore' }); }

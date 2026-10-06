import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { digest } from './policy.mjs';

const directory = path.resolve(process.argv[2] ?? './host-state');
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokens = Object.fromEntries(['alice', 'bob'].map(id => [id, randomBytes(32).toString('base64url')]));
const config = {
  workspaces: ['alice', 'bob'].map(id => ({ id: `${id}-work`, name: `${id}'s workspace`, memoryMiB: 3072, memoryMaxMiB: 16384, cpus: 1, cpusMax: 4, accounts: [id, 'team'] })),
  principals: ['alice', 'bob'].map(id => ({ id, tokenSha256: digest(tokens[id]), scope: 'drive', workspaces: [`${id}-work`] })),
};
// Never overwrite deployed grants or print credentials into service logs.
const tokenPath = path.join(directory, 'access-tokens.json');
await writeFile(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600, flag: 'wx' });
try { await writeFile(path.join(directory, 'host.json'), JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' }); }
catch (error) { await rm(tokenPath); throw error; }
console.log(`Created configuration and separate access-token file in ${directory}`);

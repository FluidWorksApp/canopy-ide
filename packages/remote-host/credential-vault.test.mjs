import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readdir,readFile,chmod,writeFile,symlink} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {CredentialVault} from './credential-vault.mjs';
const ws='ws-11111111-1111-4111-8111-111111111111',other='ws-22222222-2222-4222-8222-222222222222',secret='synthetic-provider-secret';
async function fixture(run){const root=await mkdtemp(path.join(os.tmpdir(),'canopy-vault-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
test('vault persists encrypted secrets and binds each account to a workspace',()=>fixture(async root=>{
 const vault=await CredentialVault.initialize(root);await vault.store(ws,'shared',{provider:'anthropic',token:secret});
 const files=await readdir(root);const entry=files.find(f=>f.endsWith('.json'));assert.ok(!(await readFile(path.join(root,entry),'utf8')).includes(secret));
 const restarted=await CredentialVault.initialize(root);assert.equal((await restarted.load('shared',{workspaceId:ws})).token,secret);
 await assert.rejects(restarted.load('shared',{workspaceId:other}));await assert.rejects(restarted.load('another',{workspaceId:ws}));
 await restarted.remove(ws,'shared');await assert.rejects(restarted.load('shared',{workspaceId:ws}));
}));
test('permissive roots, symlink keys and readable credential files fail closed',()=>fixture(async root=>{
 await chmod(root,0o755);await assert.rejects(CredentialVault.initialize(root));await chmod(root,0o700);
 const target=path.join(root,'target');await writeFile(target,Buffer.alloc(32),{mode:0o600});await symlink(target,path.join(root,'vault.key'));await assert.rejects(CredentialVault.initialize(root));await rm(path.join(root,'vault.key'));
 const vault=await CredentialVault.initialize(root);await vault.store(ws,'shared',{provider:'openai',token:secret});const entry=(await readdir(root)).find(f=>f.endsWith('.json'));await chmod(path.join(root,entry),0o644);await assert.rejects(vault.load('shared',{workspaceId:ws}));
}));
test('tampered or transplanted ciphertext cannot return credentials',()=>fixture(async root=>{
 const vault=await CredentialVault.initialize(root);await vault.store(ws,'shared',{provider:'github',token:secret,repository:'example/repo'});
 const entry=vault.location(ws,'shared').file;const bytes=await readFile(entry);await writeFile(vault.location(other,'shared').file,bytes,{mode:0o600});await assert.rejects(vault.load('shared',{workspaceId:other}));
 const envelope=JSON.parse(bytes);envelope.ciphertext=Buffer.alloc(8).toString('base64');await writeFile(entry,JSON.stringify(envelope));await assert.rejects(vault.load('shared',{workspaceId:ws}));
 await assert.rejects(vault.store(ws,'../other',{provider:'github',token:secret}));await assert.rejects(vault.store(ws,'shared',{provider:'github',token:secret,workspaceId:other}));
}));

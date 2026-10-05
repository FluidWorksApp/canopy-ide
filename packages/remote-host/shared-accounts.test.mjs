import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {CredentialVault} from './credential-vault.mjs';import {SharedAccounts} from './shared-accounts.mjs';
const ws='ws-11111111-1111-4111-8111-111111111111',other='ws-22222222-2222-4222-8222-222222222222';
async function fixture(run){const root=await mkdtemp(path.join(os.tmpdir(),'shared-accounts-'));try{await run(await CredentialVault.initialize(root));}finally{await rm(root,{force:true,recursive:true});}}
test('project selection persists independently of secrets and concurrent updates preserve both',()=>fixture(async vault=>{
 await vault.store(ws,'claude',{provider:'anthropic',token:'synthetic-private-token'});await vault.store(ws,'codex',{provider:'openai',token:'another-private-token'});
 const accounts=new SharedAccounts(vault);await Promise.all([accounts.bind(ws,'app','claude','claude'),accounts.bind(ws,'docs','codex','codex')]);
 assert.equal((await new SharedAccounts(vault).list(ws)).length,2);assert.equal(await accounts.resolve(ws,'app','claude'),'claude');assert.equal(await accounts.resolve(other,'app','claude'),undefined);
 assert.ok(!(await readFile(accounts.file(ws),'utf8')).includes('private-token'));
 await accounts.remove(ws,'claude');assert.equal(await accounts.resolve(ws,'app','claude'),undefined);await assert.rejects(vault.load('claude',{workspaceId:ws}));assert.equal(await accounts.resolve(ws,'docs','codex'),'codex');
}));
test('provider mismatch, cross-workspace credential and malformed selectors fail closed',()=>fixture(async vault=>{
 await vault.store(ws,'claude',{provider:'anthropic',token:'synthetic'});const accounts=new SharedAccounts(vault);
 await assert.rejects(accounts.bind(ws,'app','git','claude'));await assert.rejects(accounts.bind(other,'app','claude','claude'));await assert.rejects(accounts.bind(ws,'../app','claude','claude'));await assert.rejects(accounts.bind(ws,'app','billing','claude'));assert.deepEqual(await accounts.list(ws),[]);
}));

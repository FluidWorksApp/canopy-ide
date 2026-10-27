import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,realpath,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {WorkspaceGates,rootHash,tokenMac} from './gates.mjs';
import {stat} from 'node:fs/promises';

// Same digest as src-tauri/src/gates.rs root_hash (sha256, first 16 bytes, hex).
test('root hash matches the Rust policy key',()=>{
 assert.equal(rootHash('').length,32);
 assert.equal(rootHash(''),'e3b0c44298fc1c149afbf4c8996fb924');
});

test('policy is written where the VM hook reads it, filtered to the DSL',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-gates-')));
 try{
  const repo=path.join(home,'repo');await mkdir(repo);
  const gates=new WorkspaceGates({home,run:async()=>{throw Error('not a repo');}});
  const file=await gates.write(repo,{trifecta:'block',gates:[
   {id:'a',rule:'Never touch migrations/',gate:{type:'deny-path-write',globs:['migrations/']}},
   {id:'b',rule:'x',gate:{type:'run-anything'}},
   {id:'c',rule:'y',gate:{type:'unenforceable',reason:'r'}},
  ],guidance:['Prefer small PRs',3]});
  assert.equal(file,path.join(home,'.canopy/policy',rootHash(repo)+'.json'));
  const value=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(value.gates.map(g=>g.id),['a']);
  assert.equal(value.trifecta,'block');assert.deepEqual(value.guidance,['Prefer small PRs']);assert.equal(value.root,repo);
  assert.deepEqual((await gates.read(repo)).gates[0].gate.globs,['migrations/']);
  await gates.allowOnce('0123456789abcdef0123456789abcdef');
  const token=JSON.parse(await readFile(path.join(home,'.canopy/policy/approvals/0123456789abcdef0123456789abcdef.json'),'utf8'));
  assert.ok(token.expiresAt>Date.now());
  // Signed with the key the hook verifies, kept outside the policy folder.
  const keyFile=path.join(home,'.canopy/keys/gate-approval.key');
  const secret=Buffer.from((await readFile(keyFile,'utf8')).trim(),'hex');
  assert.equal(secret.length,32);assert.equal((await stat(keyFile)).mode&0o777,0o600);
  assert.equal(token.mac,tokenMac(secret,'0123456789abcdef0123456789abcdef',token.expiresAt));
  await gates.allowOnce('0123456789abcdef0123456789abcdef');
  assert.equal((await readFile(keyFile,'utf8')).trim(),secret.toString('hex'),'one key, reused');
  await assert.rejects(gates.allowOnce('../../etc/passwd'));
  await assert.rejects(gates.write(repo,{}));
 }finally{await rm(home,{recursive:true,force:true});}
});

// Pins the token MAC to RFC 4231 HMAC-SHA256, the same vector gates.rs
// `hmac_matches_rfc_4231` checks, so the two signers cannot drift apart.
test('token MAC is RFC 4231 HMAC-SHA256 over the same message as gates.rs',async()=>{
 const {createHmac}=await import('node:crypto');
 assert.equal(createHmac('sha256','Jefe').update('what do ya want for nothing?').digest('hex'),'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
 const secret=Buffer.alloc(32,7);
 assert.equal(tokenMac(secret,'ab'.repeat(16),1234),createHmac('sha256',secret).update(`canopy-approve-once\n${'ab'.repeat(16)}\n1234`).digest('hex'));
});

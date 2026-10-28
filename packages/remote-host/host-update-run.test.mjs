import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';import * as fs from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runHostUpdate,managementReady} from './host-update-run.mjs';
const payload={updateId:'11111111-2222-3333-4444-555555555555',url:'https://bucket.s3.amazonaws.com/x',runtimeSha256:'a'.repeat(64),runtimeLockSha256:'b'.repeat(64),revision:'c'.repeat(40),image:'ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'d'.repeat(64)};
async function fixture(body=payload){
 const dir=await mkdtemp(join(tmpdir(),'canopy-update-run-')),statusDir=join(dir,'status'),file=join(dir,'payload.json');
 await writeFile(file,typeof body==='string'?body:JSON.stringify(body));
 const status=async(id=payload.updateId)=>JSON.parse(await readFile(join(statusDir,id+'.json'),'utf8'));
 return {dir,statusDir,file,status,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
const exists=async file=>{try{await stat(file);return true;}catch{return false;}};
test('progress is written step by step, the update id is current while it runs, and the end is a done status',async()=>{
 const f=await fixture(),seen=[];
 try{
  const update=async(input,{ready,onStep})=>{
   assert.deepEqual(input,payload);assert.equal(typeof ready,'function');
   assert.equal((await readFile(join(f.statusDir,'current'),'utf8')).trim(),payload.updateId);
   seen.push((await f.status()).step);
   for(const step of ['gateway','gateway-ready','image']){onStep(step);await new Promise(resolve=>setTimeout(resolve,5));seen.push((await f.status()).step);}
   return {code:'updated',host:{code:'updated',revision:payload.revision},image:{code:'updated'}};
  };
  const done=await runHostUpdate(f.file,{fs,statusDir:f.statusDir,update,now:()=>'2026-10-28T12:00:00.000Z'});
  assert.deepEqual(seen,['download','gateway','gateway-ready','image']);
  assert.deepEqual(await f.status(),{state:'done',code:'updated',host:{code:'updated',revision:payload.revision},image:{code:'updated'},detail:null,updatedAt:'2026-10-28T12:00:00.000Z'});
  assert.equal(done.code,'updated');
  assert.equal(await exists(join(f.statusDir,'current')),false);
  assert.deepEqual((await readdir(f.statusDir)).sort(),[payload.updateId+'.json'],'no temporary files are left');
  assert.equal((await stat(join(f.statusDir,payload.updateId+'.json'))).mode&0o777,0o600);
 }finally{await f.cleanup();}
});
test('a step reported just before the end never overwrites the done status',async()=>{
 const f=await fixture();
 try{
  await runHostUpdate(f.file,{fs,statusDir:f.statusDir,update:async(_input,{onStep})=>{onStep('rollback');return {code:'rolled-back',host:{code:'rolled-back',detail:'The updated host did not become ready.'},image:{code:'skipped'}};}});
  await new Promise(resolve=>setTimeout(resolve,20));
  const status=await f.status();
  assert.equal(status.state,'done');assert.equal(status.code,'rolled-back');assert.equal(status.detail,'The updated host did not become ready.');
 }finally{await f.cleanup();}
});
test('a crash, an unreadable request or a missing update id still ends with a done status',async()=>{
 const crash=await fixture();
 try{
  const done=await runHostUpdate(crash.file,{fs,statusDir:crash.statusDir,update:async()=>{throw Error('docker vanished');}});
  assert.deepEqual([done.code,(await crash.status()).state,(await crash.status()).detail],['failed','done','Update stopped: docker vanished']);
  assert.equal(await exists(join(crash.statusDir,'current')),false);
 }finally{await crash.cleanup();}
 for(const body of ['{not json',{...payload,updateId:'../etc/passwd'}]){
  const f=await fixture(body);let ran=false;
  try{
   const done=await runHostUpdate(f.file,{fs,statusDir:f.statusDir,update:async()=>{ran=true;}});
   assert.equal(done.code,'invalid');assert.equal(ran,false);
   assert.deepEqual([(await f.status('invalid-request')).state,(await f.status('invalid-request')).code],['done','invalid']);
  }finally{await f.cleanup();}
 }
});
test('readiness is both services active and the management route answering 401',async()=>{
 const calls=[];const exec=async(command,args)=>{calls.push([command,...args].join(' '));};
 assert.equal(await managementReady({exec,fetchImpl:async url=>{calls.push(url);return new Response(null,{status:401});}})(),true);
 assert.deepEqual(calls,['systemctl is-active --quiet canopy-host','systemctl is-active --quiet caddy','http://127.0.0.1:8787/v1/workspaces']);
 assert.equal(await managementReady({exec,fetchImpl:async()=>new Response(null,{status:502})})(),false);
 assert.equal(await managementReady({exec:async()=>{throw Error('inactive');},fetchImpl:async()=>new Response(null,{status:401})})(),false);
});

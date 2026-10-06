import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {CloneJobs} from './git-clone.mjs';
test('reports real Git phases and keeps cancellation scoped to its clone',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'canopy-clone-'));const children=[];
 const jobs=new CloneJobs({scoped:async p=>p,launch:(_bin,args)=>{const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{child.killed=true;};child.args=args;children.push(child);return child;}});
 try{
  const first=await jobs.start(root,'https://github.com/org/first.git');const second=await jobs.start(root,'https://github.com/org/second.git');
  children[0].stderr.emit('data',Buffer.from('remote: Counting objects: 100% (10/10)\rReceiving objects: 46% (46/100)\r'));
  assert.equal(jobs.status(first.id).percent,46);assert.equal(jobs.status(first.id).stage,'Receiving objects');
  await assert.rejects(jobs.start(root,'https://github.com/org/third.git'),/already running/);
  jobs.cancel(first.id);assert.equal(children[0].killed,true);assert.equal(children[1].killed,undefined);assert.equal(jobs.status(first.id).state,'cancelled');
  children[1].emit('close',0);assert.equal(jobs.status(second.id).state,'complete');
  await assert.rejects(jobs.start(root,'https://github.com/org/second.git'),/already exists/);
 }finally{await rm(root,{recursive:true,force:true});}
});

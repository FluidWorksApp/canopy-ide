import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {WorkspaceProfiles} from './profiles.mjs';import {prepareSession} from './session-transfer.mjs';
test('selected conversation transfers without credentials or overwriting divergent history',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-transfer-')));
 try{
  const profiles=new WorkspaceProfiles(home),work=await profiles.create('Work');
  const dir=home+'/.claude/projects/app';await mkdir(dir,{recursive:true});
  const source=dir+'/session.jsonl',content=JSON.stringify({sessionId:'session',cwd:'/workspace/app',type:'user',message:{content:'Continue this work'}})+'\n';await writeFile(source,content);
  await writeFile(home+'/.claude/.credentials.json','source-secret');await writeFile(work.root+'/.claude/.credentials.json','target-secret');
  const args={agent:'claude',sessionId:'session',sourceProfile:'default',targetProfile:'work'};
  assert.deepEqual(await prepareSession(home,args),{sessionId:'session',profile:'work',cwd:'/workspace/app'});
  const destination=work.root+'/.claude/projects/app/session.jsonl';assert.equal(await readFile(destination,'utf8'),content);
  assert.equal(await readFile(source,'utf8'),content);assert.equal(await readFile(work.root+'/.claude/.credentials.json','utf8'),'target-secret');
  await prepareSession(home,args);
  const continued=content+JSON.stringify({sessionId:'session',cwd:'/workspace/app',type:'user',message:{content:'Continue with work account'}})+'\n';
  await writeFile(destination,continued);
  await prepareSession(home,{...args,sourceProfile:'work',targetProfile:'default'});
  assert.equal(await readFile(source,'utf8'),continued);
  await writeFile(destination,'newer target history');
  await assert.rejects(prepareSession(home,args),/different version/);assert.equal(await readFile(destination,'utf8'),'newer target history');
  await assert.rejects(prepareSession(home,{...args,sourceProfile:'another-member'}),/not found/);
  await rm(work.root+'/.claude/projects',{recursive:true});await symlink(dir,work.root+'/.claude/projects');
  await assert.rejects(prepareSession(home,args),/symlink/);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('fabricated hook digest cannot copy a credential as a conversation',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-forged-session-')));
 try{
  const profiles=new WorkspaceProfiles(home);await profiles.create('Work');
  await mkdir(home+'/.canopy/sessions',{recursive:true});
  await writeFile(home+'/private-token','must remain private');
  await writeFile(home+'/.canopy/sessions/forged.json',JSON.stringify({
   agent:'claude',session_id:'forged',profile:'default',transcript_path:home+'/private-token',resumable:true
  }));
  await assert.rejects(prepareSession(home,{agent:'claude',sessionId:'forged',sourceProfile:'default',targetProfile:'work'}),/not found/);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('an exact known old conversation transfers even when it is outside the 512-row display inventory',async()=>{
 const {utimes}=await import('node:fs/promises');const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-old-transfer-')));
 try{
  const work=await new WorkspaceProfiles(home).create('Work'),dir=home+'/.claude/projects/app';await mkdir(dir,{recursive:true});
  for(let i=0;i<530;i++){const id='session-'+i;await writeFile(dir+'/'+id+'.jsonl',JSON.stringify({sessionId:id,cwd:'/workspace/app',type:'user',message:{content:id}})+'\n');}
  const id='old-selected',content=JSON.stringify({sessionId:id,cwd:'/workspace/app',type:'user',message:{content:'old selected conversation'}})+'\n';await writeFile(dir+'/'+id+'.jsonl',content);await utimes(dir+'/'+id+'.jsonl',1,1);
  const {sessionDigestReader}=await import('./session-digests.mjs');assert.ok(!(await sessionDigestReader(home)()).some(row=>row.session_id===id));
  await prepareSession(home,{agent:'claude',sessionId:id,sourceProfile:'default',targetProfile:'work'});assert.equal(await readFile(work.root+'/.claude/projects/app/'+id+'.jsonl','utf8'),content);
 }finally{await rm(home,{recursive:true,force:true});}
});

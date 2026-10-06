import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {WorkspaceProfiles} from './profiles.mjs';
import {sessionDigestReader} from './session-digests.mjs';
test('conversation inventory spans own accounts, preserves resume provenance and excludes other homes',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-conversations-')));
 try{
  const profiles=new WorkspaceProfiles(home),work=await profiles.create('Work');
  const claude=home+'/.claude/projects/app';await mkdir(claude,{recursive:true});
  await writeFile(claude+'/personal.jsonl',JSON.stringify({type:'user',sessionId:'personal',cwd:'/workspace/app',message:{content:'Personal conversation'}})+'\n');
  const codex=work.root+'/.codex/sessions/2026/10/04';await mkdir(codex,{recursive:true});
  await writeFile(codex+'/work.jsonl',[{type:'session_meta',payload:{id:'work-session',cwd:'/workspace/app'}},{type:'event_msg',payload:{type:'user_message',message:'Work conversation'}}].map(JSON.stringify).join('\n')+'\n');
  await writeFile(home+'/private.jsonl',JSON.stringify({type:'user',sessionId:'private',cwd:'/workspace/app',message:{content:'Never expose'}}));
  await symlink(home+'/private.jsonl',claude+'/linked.jsonl');
  const read=sessionDigestReader(home),rows=await read();assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>r.profile).sort(),['default','work']);
  assert.ok(rows.every(r=>r.store&&r.resumable&&!r.state));
  assert.equal(rows.find(r=>r.agent==='codex').first_prompt,'Work conversation');
  await profiles.activate('work');assert.deepEqual(await read(),rows);
  assert.ok(!JSON.stringify(rows).includes('Never expose'));
 }finally{await rm(home,{recursive:true,force:true});}
});
test('hook lifecycle joins saved transcript while retaining verified resume location',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-hook-digest-')));
 try{
  await mkdir(home+'/.claude/projects/app',{recursive:true});await mkdir(home+'/.canopy/sessions',{recursive:true});
  await writeFile(home+'/.claude/projects/app/id.jsonl',JSON.stringify({sessionId:'id',cwd:'/workspace/app',type:'user',message:{content:'work'}})+'\n');
  await writeFile(home+'/.canopy/sessions/id.json',JSON.stringify({session_id:'id',agent:'claude',state:'working',surface:'42',instance:'remote-demo',cwd:'/workspace/app/sub',transcript_path:'/other/member/private'}));
  const [row]=await sessionDigestReader(home)();assert.equal(row.state,'working');assert.equal(row.surface,'42');assert.equal(row.store,false);assert.equal(row.resume_cwd,'/workspace/app');assert.equal(row.transcript_path,undefined);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('bounded newest conversation inventory stays fair across a full default profile and a named account',async()=>{
 const {utimes}=await import('node:fs/promises');const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-fair-conversations-')));
 try{
  const work=await new WorkspaceProfiles(home).create('Work'),personal=home+'/.claude/projects/app',named=work.root+'/.claude/projects/app';await mkdir(personal,{recursive:true});await mkdir(named,{recursive:true});
  for(let i=0;i<530;i++){const id='old-'+i,file=personal+'/'+id+'.jsonl';await writeFile(file,JSON.stringify({sessionId:id,cwd:'/workspace/app',type:'user',message:{content:id}})+'\n');await utimes(file,100,100);}
  await writeFile(personal+'/newest.jsonl',JSON.stringify({sessionId:'newest',cwd:'/workspace/app',type:'user',message:{content:'newest'}})+'\n');
  await writeFile(named+'/named.jsonl',JSON.stringify({sessionId:'named',cwd:'/workspace/app',type:'user',message:{content:'named'}})+'\n');
  const rows=await sessionDigestReader(home)();assert.equal(rows.length,512);assert.ok(rows.some(row=>row.session_id==='named'&&row.profile==='work'));assert.ok(rows.some(row=>row.session_id==='newest'));
 }finally{await rm(home,{recursive:true,force:true});}
});

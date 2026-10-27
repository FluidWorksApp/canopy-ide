import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {storeDigestReader,withStoreDigests} from './session-store-digests.mjs';

const L=v=>JSON.stringify(v);

test('the other CLIs\' stores join the session list, one row per conversation',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-store-digests-')));
 try{
  const project=home+'/project';await mkdir(project,{recursive:true});
  // omp
  const omp=home+'/.omp/agent/sessions/app';await mkdir(omp,{recursive:true});
  await writeFile(omp+'/2026-07-19T23-41-29-912Z_019f7cc1-aaaa-bbbb.jsonl',[L({type:'session',id:'019f7cc1-aaaa-bbbb',cwd:project}),L({type:'message',message:{role:'user',content:[{type:'text',text:'ship it'}]}})].join('\n')+'\n');
  // gemini
  const bucket=home+'/.gemini/tmp/'+createHash('sha256').update(project).digest('hex');await mkdir(bucket+'/chats',{recursive:true});
  await writeFile(bucket+'/chats/session-1.json',L({sessionId:'g-1',messages:[{type:'user',content:'rename the button'},{type:'gemini',content:'Done.'}]}));
  // aider
  await writeFile(project+'/.aider.chat.history.md','# aider chat started at 2026-07-23 04:30:16\n#### add a retry\nSure.\n');
  const read=storeDigestReader(home,{scoped:async p=>{if(!p.startsWith(home))throw Error('outside');return p;}});
  const rows=await read([project]);
  const by=a=>rows.find(r=>r.agent===a);
  assert.deepEqual(rows.map(r=>r.agent).sort(),['aider','gemini','omp']);
  assert.deepEqual({...by('omp'),updated:0},{session_id:'019f7cc1-aaaa-bbbb',agent:'omp',profile:'default',cwd:project,launch_cwd:project,resume_cwd:project,updated:0,prompts:['ship it'],first_prompt:'ship it',resumable:true,store:true});
  assert.equal(by('gemini').session_id,'g-1');assert.equal(by('gemini').cwd,project);assert.deepEqual(by('gemini').prompts,['rename the button']);
  assert.equal(by('aider').session_id,project+'/.aider.chat.history.md#2026-07-23T04:30:16');assert.deepEqual(by('aider').prompts,['add a retry']);
  // Unchanged files are not re-read; a root the workspace does not own is not read.
  assert.deepEqual(await read([project]),rows);
  assert.deepEqual((await storeDigestReader(home,{scoped:async()=>{throw Error('no');}})([project])).map(r=>r.agent).sort(),['gemini','omp']);
  // Merged without duplicating what the claude/codex list already has.
  const merged=withStoreDigests([{agent:'omp',session_id:'019f7cc1-aaaa-bbbb',updated:1},{agent:'claude',session_id:'c1',updated:5}],rows);
  assert.equal(merged.filter(r=>r.session_id==='019f7cc1-aaaa-bbbb').length,1);
  assert.equal(merged.length,4);
 }finally{await rm(home,{recursive:true,force:true});}
});

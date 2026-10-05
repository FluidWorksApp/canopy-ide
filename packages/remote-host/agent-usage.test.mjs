import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm,realpath,utimes} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {freshUsage,foldUsage,agentUsageReader} from './agent-usage.mjs';
test('Claude message snapshots count once, while separate replies add',()=>{const row=freshUsage('claude','test');const reply=(id,output)=>({type:'assistant',cwd:'/workspace/app',message:{id,model:'claude-test',usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:2,cache_creation_input_tokens:3},content:[{text:'PRIVATE PROMPT'}]}});foldUsage(row,reply('a',4));foldUsage(row,reply('a',7));foldUsage(row,reply('b',5));assert.equal(row.input_tokens,20);assert.equal(row.output_tokens,12);assert.equal(row.turns,2);assert.ok(!JSON.stringify(row).includes('PRIVATE PROMPT'));});
test('Codex cumulative usage replaces counters, splitting cached input and plan headroom',()=>{const row=freshUsage('codex','test');for(const input of [100,200])foldUsage(row,{type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:40,output_tokens:20}},rate_limits:{primary:{used_percent:65,window_minutes:300,resets_at:123}}}});assert.equal(row.input_tokens,160);assert.equal(row.cache_read_tokens,40);assert.equal(row.output_tokens,20);assert.equal(row.plan.windows[0].label,'5h');});
test('incremental transcripts retain incomplete tails, reset truncation and expose numeric fields only',async()=>{const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-usage-')));try{const dir=home+'/.claude/projects/app';await mkdir(dir,{recursive:true});const file=dir+'/session.jsonl';const line=JSON.stringify({type:'assistant',sessionId:'session',cwd:'/workspace/app',message:{id:'a',usage:{input_tokens:10,output_tokens:2},content:[{text:'SECRET'}]}});await writeFile(file,line);const reader=agentUsageReader(home);assert.deepEqual(await reader.usage(),[]);await appendFile(file,'\n');const first=await reader.usage();assert.equal(first[0].input_tokens,10);assert.ok(!JSON.stringify(first).includes('SECRET'));assert.deepEqual(await reader.usage(),first);await writeFile(file,'');assert.deepEqual(await reader.usage(),[]);}finally{await rm(home,{recursive:true,force:true});}});
test('usage remains visible across own account switches without scanning other member homes',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-profile-usage-')));
 try{
  const {WorkspaceProfiles}=await import('./profiles.mjs');const profiles=new WorkspaceProfiles(home);
  const work=await profiles.create('Work');
  for(const [root,id] of [[home,'personal'],[work.root,'work'],[home+'/other-member','private']]){
   const dir=root+'/.codex/sessions/2026/10/04';await mkdir(dir,{recursive:true});
   await writeFile(dir+'/rollout.jsonl',[
    {type:'session_meta',payload:{id,cwd:'/workspace/app'}},
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:2}},rate_limits:{primary:{used_percent:5,window_minutes:300}}}}
   ].map(JSON.stringify).join('\n')+'\n');
  }
  const reader=agentUsageReader(home);
  const before=await reader.usage();assert.deepEqual(before.map(r=>[r.session_id,r.profile]).sort(),[['personal','default'],['work','work']]);
  await profiles.activate('work');assert.deepEqual(await reader.usage(),before);
  assert.deepEqual((await reader.plans()).map(r=>r.profile).sort(),['default','work']);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('per-session Claude footer returns model and numeric totals from the requested own transcript only',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-footer-')));
 try{
  const dir=home+'/.claude/projects/app';await mkdir(dir,{recursive:true});const file=dir+'/active.jsonl';
  await writeFile(file,JSON.stringify({type:'assistant',message:{id:'reply',model:'claude-model',usage:{input_tokens:7,output_tokens:3},content:[{text:'SECRET'}]}})+'\n');
  const reader=agentUsageReader(home);const stats=await reader.sessionStats(file);
  assert.deepEqual(stats,{model:'claude-model',input_tokens:7,output_tokens:3,cache_read_tokens:0,cache_creation_tokens:0,turns:1});
  const outsider=home+'/outside.jsonl';await writeFile(outsider,'{}\n');await assert.rejects(reader.sessionStats(outsider),/Not a Claude transcript/);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('Codex plan headroom follows the requested session instead of the newest other session',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-plan-session-')));
 try{
  const dir=home+'/.codex/sessions/2026/10/05';await mkdir(dir,{recursive:true});
  for(const [id,used] of [['active',12],['other',80]])await writeFile(dir+'/'+id+'.jsonl',[
   {type:'session_meta',payload:{id}},
   {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:1}},rate_limits:{primary:{used_percent:used,window_minutes:300}}}}
  ].map(JSON.stringify).join('\n')+'\n');
  const reader=agentUsageReader(home);await reader.usage();assert.equal((await reader.plans('active'))[0].windows[0].used_percent,12);assert.deepEqual(await reader.plans('missing'),[]);
 }finally{await rm(home,{recursive:true,force:true});}
});


test('recent usage and explicit footer transcripts survive more than 256 historic sessions',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-large-usage-')));
 try{
  const dir=home+'/.claude/projects/app';await mkdir(dir,{recursive:true});
  const record=id=>JSON.stringify({type:'assistant',sessionId:id,message:{id:'reply',model:'claude-current',usage:{input_tokens:7,output_tokens:3}}})+'\n';
  for(let i=0;i<270;i++){const file=dir+'/'+String(i).padStart(3,'0')+'.jsonl';await writeFile(file,record(String(i)));await utimes(file,100,100);}
  const active=dir+'/active.jsonl';await writeFile(active,record('active'));
  const reader=agentUsageReader(home);const rows=await reader.usage();assert.equal(rows.length,256);assert.ok(rows.some(row=>row.session_id==='active'));
  // Explicit selection of an old session must still load its footer immediately.
  assert.equal((await reader.sessionStats(dir+'/269.jsonl')).model,'claude-current');
 }finally{await rm(home,{recursive:true,force:true});}
});

test('removing an own CLI profile invalidates its usage and plan cache immediately',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-removed-usage-')));
 try{
  const {WorkspaceProfiles}=await import('./profiles.mjs');const profiles=new WorkspaceProfiles(home),work=await profiles.create('Work');
  const dir=work.root+'/.codex/sessions/2026/10/05';await mkdir(dir,{recursive:true});
  await writeFile(dir+'/active.jsonl',[
   {type:'session_meta',payload:{id:'active'}},
   {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:1}},rate_limits:{primary:{used_percent:12,window_minutes:300}}}}
  ].map(JSON.stringify).join('\n')+'\n');
  const reader=agentUsageReader(home);assert.equal((await reader.usage()).length,1);
  await profiles.remove('work');assert.deepEqual(await reader.usage(),[]);assert.deepEqual(await reader.plans('active'),[]);
 }finally{await rm(home,{recursive:true,force:true});}
});

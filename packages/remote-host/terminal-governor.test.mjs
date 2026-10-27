import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalGovernor,baseAllowance,cliKeyOf,governorSampler,workspaceMemory,CAPABILITY} from './terminal-governor.mjs';

const MIB=1024*1024,GIB=1024*MIB,TOTAL=8*GIB,AVAIL=6*GIB;
async function setup(){const dir=await mkdtemp(join(tmpdir(),'governor-'));return {dir,file:join(dir,'defaults.json'),gov:new TerminalGovernor({defaultsFile:join(dir,'defaults.json')}),done:()=>rm(dir,{recursive:true,force:true})};}
const at=s=>s*1000;

test('allowances follow the desktop: base by workspace size, cli keys content-free',()=>{
 assert.equal(baseAllowance(8*GIB),GIB);assert.equal(baseAllowance(16*GIB),GIB+512*MIB);assert.equal(baseAllowance(32*GIB),4*GIB);
 assert.equal(cliKeyOf({bin:'claude',pkg:'npm:@anthropic-ai/claude-code'}),'pkg:npm:@anthropic-ai/claude-code');
 assert.equal(cliKeyOf({bin:'Codex.exe',pkg:null}),'bin:codex');assert.equal(cliKeyOf(null),null);
});

test('a terminal is warned, then asked about, then granted more room, with events and incidents',async()=>{
 const t=await setup();
 try{
  await t.gov.observe([{id:4,bytes:100*MIB,cliKey:'bin:claude'}],TOTAL,AVAIL,at(0));
  let s=t.gov.snapshot();assert.equal(s.capability,CAPABILITY);assert.equal(s.sessions[0].state,'normal');assert.equal(s.sessions[0].allowance_bytes,GIB);
  const cursor=t.gov.drain(null).cursor;
  // 80%: warned after two samples; 95%: awaiting a grant.
  await t.gov.observe([{id:4,bytes:820*MIB}],TOTAL,AVAIL,at(2));await t.gov.observe([{id:4,bytes:820*MIB}],TOTAL,AVAIL,at(4));
  assert.equal(t.gov.snapshot().sessions[0].state,'warned');
  await t.gov.observe([{id:4,bytes:980*MIB}],TOTAL,AVAIL,at(6));
  s=t.gov.snapshot().sessions[0];assert.equal(s.state,'awaiting_grant');assert.deepEqual(s.grant_request.increments,[512*MIB,GIB]);
  const {events}=t.gov.drain(cursor);assert.deepEqual(events.map(e=>[e.kind,e.status.state]),[['state_changed','warned'],['state_changed','awaiting_grant']]);
  assert.throws(()=>t.gov.grant(4,s.budget_generation,'pty-4-grant-99',512*MIB),/stale grant request/);
  const out=t.gov.grant(4,s.budget_generation,s.grant_request.request_id,512*MIB);
  assert.equal(out.applied,true);assert.equal(out.status.state,'relief');assert.equal(out.status.allowance_bytes,GIB+512*MIB);
  assert.deepEqual(t.gov.grant(4,s.budget_generation,s.grant_request.request_id,512*MIB).idempotent,true);
  // Remembered for this CLI, and applied to its next terminal.
  const remembered=await t.gov.rememberDefault(4,s.grant_request.request_id,s.budget_generation,512*MIB,true);
  assert.deepEqual(remembered,{persisted:true,idempotent:false,cli_key:'bin:claude',increment_bytes:512*MIB});
  assert.deepEqual(JSON.parse(await readFile(t.file,'utf8')).defaults,{'bin:claude':512*MIB});
  await t.gov.observe([{id:4,bytes:100*MIB},{id:5,bytes:50*MIB,cliKey:'bin:claude'}],TOTAL,AVAIL,at(8));
  assert.equal(t.gov.snapshot().sessions[1].remembered_default_bytes,512*MIB);
  assert.ok(t.gov.incidents().some(i=>i.event==='grant_applied'));
 }finally{await t.done();}
});

test('a sustained breach is over allowance; a stop asks the workspace to end the terminal once',async()=>{
 const t=await setup();
 try{
  for(let i=0;i<=6;i++)await t.gov.observe([{id:2,bytes:1200*MIB}],TOTAL,AVAIL,at(i*2));
  let s=t.gov.snapshot().sessions[0];assert.equal(s.state,'over_allowance');assert.ok(s.grant_request);
  const stopped=[];
  await assert.rejects(t.gov.stop(2,s.budget_generation,'pty-2-stop-0',async id=>stopped.push(id)),/stale stop request/);
  const out=await t.gov.stop(2,s.budget_generation,s.stop_request_id,async id=>stopped.push(id));
  assert.equal(out.requested,true);assert.equal(out.status.state,'stopping');assert.deepEqual(stopped,[2]);
  assert.equal((await t.gov.stop(2,s.budget_generation,s.stop_request_id,async()=>stopped.push(9))).idempotent,true);
  await t.gov.observe([],TOTAL,AVAIL,at(20));
  assert.equal(t.gov.snapshot().sessions.length,0);
  assert.equal((await t.gov.stop(2,s.budget_generation,s.stop_request_id,async()=>stopped.push(9))).idempotent,true,'retry after exit returns the completed outcome');
  assert.deepEqual(stopped,[2]);
  await assert.rejects(t.gov.rememberDefault(2,'x',1,512*MIB,false),/separate confirmation/);
 }finally{await t.done();}
});

test('a per-CLI maximum caps grants and survives alongside remembered defaults',async()=>{
 const t=await setup();
 try{
  await writeFile(t.file,JSON.stringify({maxima:{'bin:codex':GIB+512*MIB}}));
  assert.deepEqual(await t.gov.maxima(),[{cli_key:'bin:codex',max_allowance_bytes:GIB+512*MIB}]);
  await t.gov.observe([{id:1,bytes:100*MIB,cliKey:'bin:codex'}],TOTAL,AVAIL,at(0));
  for(let i=1;i<=3;i++)await t.gov.observe([{id:1,bytes:960*MIB}],TOTAL,AVAIL,at(i*2));
  assert.deepEqual(t.gov.snapshot().sessions[0].grant_request.increments,[512*MIB]);
  const cursor=t.gov.drain(null).cursor;
  await t.gov.setMaximum('bin:codex',null);
  assert.deepEqual(t.gov.snapshot().sessions[0].grant_request.increments,[512*MIB,GIB]);
  assert.equal(t.gov.drain(cursor).events[0].kind,'maximum_changed');
  await assert.rejects(t.gov.setMaximum('codex',null),/invalid agent CLI identity/);
 }finally{await t.done();}
});

test('the sampler feeds the governor on a timer, and memory comes from the cgroup',async()=>{
 const t=await setup();
 try{
  const sampler=governorSampler({governor:t.gov,sample:async()=>[{id:7,bytes:5*MIB,cliKey:null}],memory:async()=>({total:TOTAL,available:AVAIL}),intervalMs:60_000});
  await sampler.tick();assert.equal(t.gov.snapshot().sessions[0].current_bytes,5*MIB);
  sampler.start();assert.ok(sampler.running);sampler.stop();
  assert.deepEqual(await workspaceMemory(async f=>f.endsWith('memory.max')?'4294967296\n':'1073741824\n'),{total:4*GIB,available:3*GIB});
  const fallback=await workspaceMemory(async()=>'max\n');assert.ok(fallback.total>0);
 }finally{await t.done();}
});

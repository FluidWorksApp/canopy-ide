import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {activityFromLines,sessionActivity} from './session-activity.mjs';

const L=v=>JSON.stringify(v);

test('a background agent from launch to report, and the context it left',()=>{
 const a=activityFromLines([
  L({type:'assistant',timestamp:'2026-10-26T06:50:00.000Z',message:{model:'claude-opus-5-5',usage:{input_tokens:2,cache_creation_input_tokens:17634,cache_read_input_tokens:27210},content:[{type:'tool_use',id:'toolu_1',name:'Agent',input:{description:'Reliability research',subagent_type:'general-purpose'}}]}}),
  L({type:'user',timestamp:'2026-10-26T06:50:01.000Z',message:{content:[{type:'tool_result',tool_use_id:'toolu_1',content:[{type:'text',text:'Async agent launched successfully.'}]}]},toolUseResult:{status:'async_launched',agentId:'a3fa'}}),
  L({type:'queue-operation',timestamp:'2026-10-26T06:58:57.780Z',content:'<agent-message from="a3fa"> [Subagent hand-back] The report follows:\n    Review is the bottleneck.\n</agent-message>'}),
  L({type:'user',timestamp:'2026-10-26T06:58:58.000Z',message:{content:'<task-notification> <task-id>a3fa</task-id> <tool-use-id>toolu_1</tool-use-id> <status>completed</status> <result>This agent\'s report was delivered to you as a message.</result> <usage><subagent_tokens>74476</subagent_tokens><tool_uses>22</tool_uses><duration_ms>206624</duration_ms></usage> </task-notification>'}}),
 ]);
 assert.equal(a.subagents.length,1);
 assert.deepEqual({...a.subagents[0],started_ms:0,ended_ms:0},{id:'toolu_1',agent_id:'a3fa',description:'Reliability research',kind:'general-purpose',status:'done',background:true,started_ms:0,ended_ms:0,duration_ms:206624,tokens:74476,tool_uses:22,result:'Review is the bottleneck.'});
 assert.deepEqual(a.context,{model:'claude-opus-5-5',tokens:44846,at_ms:Date.parse('2026-10-26T06:50:00.000Z')});
});

test('foreground results, errors, running agents and compactions',()=>{
 const a=activityFromLines([
  L({type:'assistant',message:{content:[{type:'tool_use',id:'ok',name:'Task',input:{description:'Find the bug'}},{type:'tool_use',id:'err',name:'Task',input:{description:'Too many'}},{type:'tool_use',id:'run',name:'Agent',input:{description:'Going',run_in_background:true}},{type:'tool_use',id:'b',name:'Bash',input:{}}]}}),
  L({type:'user',message:{content:[{type:'tool_result',tool_use_id:'ok',content:'x'}]},toolUseResult:{status:'completed',content:[{type:'text',text:'Off by one.'}],totalDurationMs:60000,totalTokens:1200,totalToolUseCount:4}}),
  L({type:'user',message:{content:[{type:'tool_result',tool_use_id:'err',is_error:true,content:'Concurrent subagent limit reached.'}]},toolUseResult:'Error: Concurrent subagent limit reached.'}),
  L({type:'assistant',message:{model:'m',usage:{input_tokens:100000}}}),
  L({type:'system',subtype:'compact_boundary',compactMetadata:{trigger:'manual',preTokens:109269,postTokens:11379}}),
 ]);
 const by=id=>a.subagents.find(s=>s.id===id);
 assert.equal(a.subagents.length,3);
 assert.equal(by('ok').status,'done');assert.equal(by('ok').result,'Off by one.');assert.equal(by('ok').duration_ms,60000);
 assert.equal(by('err').status,'failed');assert.equal(by('run').status,'running');
 assert.equal(a.context.tokens,11379);assert.equal(a.compactions[0].trigger,'manual');
});

test('found through the profile home, read incrementally, unknown CLIs answer nothing',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-activity-')));
 try{
  const dir=home+'/.claude/projects/app';await mkdir(dir,{recursive:true});
  const file=dir+'/abc-123.jsonl';
  await writeFile(file,L({type:'user',sessionId:'abc-123',cwd:'/workspace/app',message:{content:'go'}})+'\n'+L({type:'assistant',sessionId:'abc-123',message:{content:[{type:'tool_use',id:'t1',name:'Task',input:{description:'one'}}]}})+'\n');
  let a=await sessionActivity(home,{sessionId:'abc-123',agent:'claude'});
  assert.equal(a.subagents[0].status,'running');
  await appendFile(file,L({type:'user',sessionId:'abc-123',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'ok'}]},toolUseResult:{status:'completed'}})+'\n');
  a=await sessionActivity(home,{sessionId:'abc-123',agent:'claude'});
  assert.equal(a.subagents[0].status,'done');
  assert.equal(await sessionActivity(home,{sessionId:'abc-123',agent:'other'}),null);
  assert.equal(await sessionActivity(home,{sessionId:'../x',agent:'claude'}),null);
 }finally{await rm(home,{recursive:true,force:true});}
});

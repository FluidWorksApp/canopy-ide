import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generate} from './gen-agent-templates.mjs';
import {installGates,gatesInstalled,CURSOR_GATE_MATCHER,AGY_GATE_MATCHER,GATE_TOOLS_ANY_MATCHER} from './agent-gates.mjs';
import {AgentIntegrations,HOOKED_CLIS} from './agent-integrations.mjs';

const agentsRs=async()=>readFile(new URL('../../src-tauri/src/agents.rs',import.meta.url),'utf8');

test('the generated plugin sources are the desktop installers\' own',async()=>{
 assert.equal(await readFile(new URL('./agent-templates.mjs',import.meta.url),'utf8'),await generate(),'run node gen-agent-templates.mjs');
 const rs=await agentsRs();
 for(const [name,value] of [['CURSOR_GATE_MATCHER',CURSOR_GATE_MATCHER],['AGY_GATE_MATCHER',AGY_GATE_MATCHER],['GATE_TOOLS_ANY_MATCHER',GATE_TOOLS_ANY_MATCHER]])
  assert.match(rs,new RegExp(`const ${name}: &str =\\s*"${value.replace(/[|.*+?^$()[\]{}\\]/g,'\\$&')}";`),name);
});

test('each CLI gets its lifecycle hooks and the Rules gate, idempotently, keeping what the user wrote',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'agent-gates-'));const helper='/usr/local/bin/canopy-hook';
 try{
  await mkdir(path.join(home,'.cursor'),{recursive:true});
  await writeFile(path.join(home,'.cursor/hooks.json'),JSON.stringify({version:1,hooks:{preToolUse:[{command:'/mine/audit.sh'}],stop:[{command:"'/old/.canopy/bin/canopy-hook' --agent cursor --signal turn-end"}]}}));
  await mkdir(path.join(home,'.gemini/config'),{recursive:true});
  await writeFile(path.join(home,'.gemini/config/hooks.json'),JSON.stringify({mine:{Stop:[]},canopy:{enabled:false,Notification:[]}}));
  for(const agent of ['cursor','grok','opencode','omp','amp','agy']){
   assert.equal(await gatesInstalled(agent,home,home,helper),false,agent);
   assert.match(await installGates(agent,home,home,helper),/installed/,agent);
   assert.equal(await gatesInstalled(agent,home,home,helper),true,agent);
   assert.match(await installGates(agent,home,home,helper),/already set up/,agent);
  }
  const cursor=JSON.parse(await readFile(path.join(home,'.cursor/hooks.json'),'utf8'));
  assert.deepEqual(cursor.hooks.preToolUse,[{command:'/mine/audit.sh'},{command:"'/usr/local/bin/canopy-hook' --agent cursor --gate",matcher:CURSOR_GATE_MATCHER,timeout:10}]);
  assert.deepEqual(cursor.hooks.stop,[{command:"'/usr/local/bin/canopy-hook' --agent cursor --signal turn-end",timeout:10}],'an older Canopy entry is replaced, not stacked');
  const grok=JSON.parse(await readFile(path.join(home,'.grok/hooks/canopy.json'),'utf8'));
  assert.equal(grok.hooks.PreToolUse[0].hooks[0].command,"'/usr/local/bin/canopy-hook' --agent grok");
  const agy=JSON.parse(await readFile(path.join(home,'.gemini/config/hooks.json'),'utf8'));
  assert.deepEqual(agy.mine,{Stop:[]});assert.equal(agy.canopy.enabled,false,'the user switched it off');
  assert.equal(agy.canopy.PreToolUse[0].hooks[0].command,"'/usr/local/bin/canopy-hook' --agent agy --gate");
  assert.equal(agy.canopy.Notification,undefined,'an event an older Canopy registered is dropped');
  const opencode=await readFile(path.join(home,'.config/opencode/plugin/canopy.ts'),'utf8');
  assert.match(opencode,/const HELPER = "\/usr\/local\/bin\/canopy-hook"/);assert.match(opencode,/hook_event_name: "PreToolUse"/);
  const omp=await readFile(path.join(home,'.omp/agent/extensions/canopy.ts'),'utf8');
  assert.doesNotMatch(omp,/__CANOPY_CONTEXT__|__HELPER__/);assert.match(omp,/running inside the Canopy IDE/);
  assert.doesNotMatch(await readFile(path.join(home,'.config/amp/plugins/canopy.ts'),'utf8'),/__HELPER__/);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('the workspace integrations report and set up every hooked CLI the image ships',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'agent-gates-int-'));
 try{
  const bin=path.join(home,'bin');await mkdir(bin);
  const helper=path.join(bin,'canopy-hook');await writeFile(helper,'#!/bin/sh\n');await chmod(helper,0o755);
  await writeFile(path.join(bin,'cursor-agent'),'#!/bin/sh\n');await chmod(path.join(bin,'cursor-agent'),0o755);
  const integrations=new AgentIntegrations(home,helper,bin);
  assert.deepEqual(HOOKED_CLIS,['claude','codex','cursor','grok','opencode','omp','amp','agy']);
  assert.deepEqual(await integrations.health('cursor'),{agent:'cursor',cli_installed:true,hooks:'missing',mcp:'unsupported'});
  assert.equal((await integrations.health('grok')).cli_installed,false);
  const report=await integrations.setup('cursor');
  assert.equal(report.ok,true,report.summary);
  assert.equal((await integrations.health('cursor')).hooks,'ours');
  await access(path.join(home,'.cursor/hooks.json'));
 }finally{await rm(home,{recursive:true,force:true});}
});

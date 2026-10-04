import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,mkdir,rm,chmod} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {AgentIntegrations} from './agent-integrations.mjs';import {WorkspaceProfiles} from './profiles.mjs';
test('one-click hooks install across profiles, retain existing hooks, and verify the helper',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-hooks-')));
 try{
  const helper=home+'/helper';await writeFile(helper,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const work=await new WorkspaceProfiles(home).create('Work');await mkdir(home+'/.claude',{recursive:true});
  const settings=home+'/.claude/settings.json';await writeFile(settings,JSON.stringify({theme:'dark',hooks:{Stop:[{hooks:[{type:'command',command:'my-existing-hook'}]}]}}));
  const integrations=new AgentIntegrations(home,helper);assert.equal(await integrations.installed('claude'),false);
  await integrations.setup('claude');await integrations.setup('claude');
  assert.equal(await integrations.installed('claude'),true);
  const value=JSON.parse(await readFile(settings,'utf8'));assert.equal(value.theme,'dark');assert.equal(value.hooks.Stop.length,2);assert.equal(value.hooks.Stop[0].hooks[0].command,'my-existing-hook');
  assert.ok(JSON.parse(await readFile(work.root+'/.claude/settings.json','utf8')).hooks.SessionStart);
  await integrations.setup('codex');assert.equal(await integrations.installed('codex'),true);
  await chmod(helper,0o600);assert.equal(await integrations.installed('codex'),false);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('one broken account does not prevent other accounts from being integrated',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-hook-partial-')));
 try{const helper=home+'/helper';await writeFile(helper,'#!/bin/sh\n',{mode:0o700});const work=await new WorkspaceProfiles(home).create('Work');await mkdir(home+'/.claude');await writeFile(home+'/.claude/settings.json','invalid private content');const integrations=new AgentIntegrations(home,helper);const result=await integrations.setup('claude');assert.equal(result.ok,false);assert.ok(result.steps.some(step=>step.step==='work: MCP'&&step.ok));assert.equal(await readFile(home+'/.claude/settings.json','utf8'),'invalid private content');assert.ok(!JSON.stringify(result).includes('invalid private content'));assert.ok(JSON.parse(await readFile(work.root+'/.claude/settings.json','utf8')).hooks.Stop);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('health reports actual executable availability without treating directories or non-executable files as CLIs',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-hook-health-')));
 try{
  const bin=path.join(home,'bin');await mkdir(bin);
  const integrations=new AgentIntegrations(home,home+'/missing-helper',bin);
  assert.equal((await integrations.health('claude')).cli_installed,false);
  await writeFile(path.join(bin,'claude'),'#!/bin/sh\n',{mode:0o600});
  assert.equal(await integrations.cliInstalled('claude'),false);
  await chmod(path.join(bin,'claude'),0o700);
  const health=await integrations.health('claude');assert.equal(health.cli_installed,true);assert.equal(health.hooks,'missing');
  await mkdir(path.join(bin,'codex'));assert.equal(await integrations.cliInstalled('codex'),false);
  assert.equal(await integrations.cliInstalled('../claude'),false);
 }finally{await rm(home,{recursive:true,force:true});}
});

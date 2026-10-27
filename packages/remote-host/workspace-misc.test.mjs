import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workspaceMiscCommands} from './workspace-misc.mjs';
async function setup(){const home=await mkdtemp(join(tmpdir(),'misc-'));const pulses=[];return {home,pulses,commands:workspaceMiscCommands({home,pulse:(...a)=>pulses.push(a),setupAgent:async(agent,id)=>({agent,id})})};}
test('build operations are exclusive per resource and released only by their owner',async()=>{
 const {commands}=await setup();
 const token=await commands.build_operation_acquire({key:'android:assemble.debug'});assert.match(token,/^[0-9a-f]{32}$/);
 await assert.rejects(commands.build_operation_acquire({key:'android:assemble.debug'}),/already running/);
 await assert.rejects(commands.build_operation_acquire({key:'bad key'}),/Invalid build operation identity/);
 await assert.rejects(commands.build_operation_release({key:'android:assemble.debug',token:'x'}),/ownership changed/);
 await commands.build_operation_release({key:'android:assemble.debug',token});await commands.build_operation_acquire({key:'android:assemble.debug'});
});
test('forgetting a session removes its digest and journal and announces it',async()=>{
 const {home,pulses,commands}=await setup();const dir=join(home,'.canopy/sessions');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'s1.json'),'{}');await writeFile(join(dir,'s1.edits.jsonl'),'');
 await commands.session_forget({sessionId:'s1'});await assert.rejects(access(join(dir,'s1.json')));await assert.rejects(access(join(dir,'s1.edits.jsonl')));
 await commands.session_forget({sessionId:'s1'});assert.deepEqual(pulses,[['sessions','','s1'],['sessions','','s1']]);
 await assert.rejects(commands.session_forget({sessionId:'../x'}),/invalid session id/);
});
test('per-CLI memory maximums persist; per-terminal budgets answer as unmonitored',async()=>{
 const {home,commands}=await setup();
 assert.deepEqual(await commands.terminal_governor_memory_maxima(),[]);
 assert.deepEqual(await commands.terminal_governor_set_memory_maximum({cliKey:'pkg:codex',maxAllowanceBytes:1024**3}),[{cli_key:'pkg:codex',max_allowance_bytes:1024**3}]);
 await commands.terminal_governor_set_memory_maximum({cliKey:'bin:aider',maxAllowanceBytes:512*1024**2});
 const again=workspaceMiscCommands({home});assert.deepEqual((await again.terminal_governor_memory_maxima()).map(m=>m.cli_key),['bin:aider','pkg:codex']);
 assert.deepEqual(await commands.terminal_governor_set_memory_maximum({cliKey:'pkg:codex',maxAllowanceBytes:null}),[{cli_key:'bin:aider',max_allowance_bytes:512*1024**2}]);
 await assert.rejects(commands.terminal_governor_set_memory_maximum({cliKey:'codex',maxAllowanceBytes:null}),/invalid agent CLI identity/);
 await assert.rejects(commands.terminal_governor_set_memory_maximum({cliKey:'pkg:x',maxAllowanceBytes:100}),/must be between/);
 await assert.rejects(commands.terminal_governor_grant({id:3,budgetGeneration:1,requestId:'r',incrementBytes:1}),/no monitored terminal 3/);
 await assert.rejects(commands.terminal_governor_remember_default({id:3,confirmed:false}),/separate confirmation/);
 assert.deepEqual(await commands.terminal_governor_incidents(),[]);
 assert.deepEqual(await commands.profile_setup({agent:'claude',id:'p1'}),{agent:'claude',id:'p1'});
});

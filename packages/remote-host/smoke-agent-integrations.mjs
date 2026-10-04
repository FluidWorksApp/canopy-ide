// Disposable container, synthetic HOME, no user volumes, no provider credentials.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
const script=`
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {AgentIntegrations} from '/opt/canopy/agent-integrations.mjs';
import {readAgentEvents} from '/opt/canopy/agent-events.mjs';
const home='/tmp/integration-check';await mkdir(home+'/.claude',{recursive:true});await mkdir(home+'/.codex',{recursive:true});
await writeFile(home+'/.claude/settings.json',JSON.stringify({theme:'dark'}));
const integrations=new AgentIntegrations(home);
for(const agent of ['claude','codex']){
 assert.equal((await integrations.setup(agent)).ok,true);
 assert.deepEqual(await integrations.health(agent),{agent,cli_installed:true,hooks:'ours',mcp:'ours'});
 const before=await readAgentEvents(home+'/.canopy/agent-events.jsonl',null);
 const child=spawnSync('/usr/local/bin/canopy-hook',['--agent',agent],{env:{...process.env,HOME:home,CANOPY:'1',CANOPY_PTY:'42',CANOPY_INSTANCE:'remote-test'},input:JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'synthetic-'+agent,cwd:'/workspace',prompt:'synthetic integration check'}),encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,child.stderr);
 const batch=await readAgentEvents(home+'/.canopy/agent-events.jsonl',before.cursor);
 assert.ok(batch.lines.some(line=>{const event=JSON.parse(line);return event.agent===agent&&event.hook_event_name==='UserPromptSubmit';}));
}
assert.equal(JSON.parse(await readFile(home+'/.claude/settings.json','utf8')).theme,'dark');
console.log('Claude and Codex setup, health and compiled hook event delivery verified');
`;
const image=process.argv[2]??'canopy-workspace:integration-validation';
const result=await exec('docker',['run','--rm','--network','none','--entrypoint','node',image,'--input-type=module','-e',script],{timeout:60000,maxBuffer:1024*1024});
process.stdout.write(result.stdout);

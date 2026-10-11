import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ContainerCompanionRunner,launchArgs,companionLaunch,dockerExecArgs,companionEnv,BUILTIN_WRITERS} from './slack-companion-runner.mjs';
import {SlackCompanion,SlackCompanionHost} from './slack-companion.mjs';

const workspace={id:'ws-a',generation:3};
const running={State:{Running:true,Paused:false}};
const brief='BRIEF';

test('the launch argv is exactly the desktop companion argv (structuredRunners.ts)',()=>{
 const launch=companionLaunch({bin:'claude',sessionId:'11111111-2222-4333-8444-555555555555',systemPrompt:brief});
 assert.deepEqual(launch.policy,{systemPromptAppend:brief,permissionMode:'bypassPermissions',disallowedTools:['Edit','Write','NotebookEdit','Bash','KillShell'],model:'',sessionId:'11111111-2222-4333-8444-555555555555',cwd:'/workspace',authority:'read-only'});
 const tail=['--append-system-prompt',brief,'--add-dir','/workspace','--permission-mode','bypassPermissions','--disallowedTools','Edit','Write','NotebookEdit','Bash','KillShell'];
 const head=['-p','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--verbose'];
 assert.deepEqual(launchArgs('claude',launch),[...head,'--session-id','11111111-2222-4333-8444-555555555555',...tail]);
 assert.deepEqual(launchArgs('claude',launch,{resume:true}),[...head,'--resume','11111111-2222-4333-8444-555555555555',...tail]);
 assert.deepEqual(launchArgs('claude',companionLaunch({bin:'claude',sessionId:'s',systemPrompt:brief,model:'opus'})).slice(-10,-8),['--model','opus']);
 const codex=companionLaunch({bin:'codex',sessionId:'thread-1',systemPrompt:brief});
 assert.deepEqual(launchArgs('codex',codex),['exec','--json','--skip-git-repo-check','-C','/workspace','--add-dir','/workspace','-s','read-only']);
 assert.deepEqual(launchArgs('codex',codex,{resume:true}),['exec','resume','thread-1','--json','--skip-git-repo-check','-c','sandbox_mode="read-only"']);
 assert.throws(()=>launchArgs('amp',launch),/no verified companion runner/);
});

test('docker exec runs as the agent user in /workspace and never starts anything',()=>{
 const args=dockerExecArgs('canopy-ws-ws-a',{bin:'claude',args:['-p','$(rm -rf /)'],env:companionEnv('ws-a'),stdin:true});
 assert.deepEqual(args.slice(0,6),['exec','-i','-u','1000:1000','-w','/workspace']);
 assert.ok(!args.includes('start')&&!args.includes('root')&&!args.includes('0:0'));
 const at=args.indexOf('canopy-ws-ws-a');
 assert.deepEqual(args.slice(at+1,at+3),['/bin/bash','-lc']);
 assert.equal(args[at+3],'export PATH="/home/agent/.local/bin:$PATH"; exec "$0" "$@"');
 assert.deepEqual(args.slice(at+4),['claude','-p','$(rm -rf /)'],'binary and arguments are positionals, never shell text');
 for(const pair of ['HOME=/home/agent','CLAUDE_CONFIG_DIR=/home/agent/.claude','CODEX_HOME=/home/agent/.codex','CANOPY_COMPANION=1','CANOPY_COMPANION_AUTHORITY=read','CANOPY_COMPANION_POLICY=deny','CANOPY_WORKSPACE_ID=ws-a'])assert.ok(args.includes(pair),pair);
 assert.ok(!dockerExecArgs('c',{bin:'codex',args:[],env:{}}).includes('-i'),'codex never gets a stdin');
 assert.deepEqual(BUILTIN_WRITERS,['Edit','Write','NotebookEdit','Bash','KillShell']);
});

// A scripted `docker` binary: `command -v` probes answer from `installed`,
// everything else becomes a fake process the test drives.
function fakeDocker({installed=['claude']}={}){
 const procs=[];
 const spawn=(command,args,options)=>{
  assert.equal(command,'docker');
  const child=new EventEmitter();
  child.args=args;child.options=options;child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.written=[];
  child.stdin=options.stdio[0]==='pipe'?Object.assign(new PassThrough(),{}):null;
  child.stdin?.on('data',d=>child.written.push(...String(d).split('\n').filter(Boolean).map(l=>JSON.parse(l))));
  child.stdin?.on('finish',()=>{child.stdinEnded=true;});
  child.kill=()=>{child.killed=true;setImmediate(()=>{child.emit('exit',null);child.emit('close',null);});};
  child.say=obj=>child.stdout.write(JSON.stringify(obj)+'\n');
  child.end=(code=0)=>{child.stdout.end();child.stderr.end();setImmediate(()=>{child.emit('exit',code);child.emit('close',code);});};
  const probe=args.at(-1);
  if(args.at(-2)?.includes('command -v')){setImmediate(()=>child.emit('exit',installed.includes(probe)?0:1));return child;}
  procs.push(child);return child;
 };
 return {spawn,procs};
}
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}throw Error('timed out');}
async function stateFile(){const dir=await mkdtemp(path.join(tmpdir(),'slack-companion-'));return {dir,file:path.join(dir,'state',`${workspace.id}.json`)};}

test('claude: one long-lived process, one turn at a time, resumed after a restart',async t=>{
 const {dir,file}=await stateFile();t.after(()=>rm(dir,{recursive:true,force:true}));
 const docker=fakeDocker();
 const runner=new ContainerCompanionRunner({workspace,inspect:async()=>running,stateFile:file,spawn:docker.spawn});
 const first=runner.runTurn({prompt:'one'}),second=runner.runTurn({prompt:'two'});
 await until(()=>docker.procs[0]?.written.length===1);
 const proc=docker.procs[0];
 assert.ok(proc.args.includes('-i')&&proc.args.includes('--session-id'));
 assert.deepEqual(proc.written[0],{type:'user',message:{role:'user',content:[{type:'text',text:'one'}]}});
 await tick();
 assert.equal(proc.written.length,1,'the second turn waits for the first');
 proc.say({type:'system',subtype:'init'});
 proc.say({type:'assistant',message:{content:[{type:'text',text:'partial'}]}});
 proc.say({type:'result',result:'answer one'});
 assert.deepEqual(await first,{text:'answer one'});
 await until(()=>proc.written.length===2);
 proc.say({type:'result',is_error:true,result:'rate limited'});
 await assert.rejects(second,/rate limited/);
 assert.equal(docker.procs.length,1,'the process outlives its turns');
 const saved=JSON.parse(await readFile(file,'utf8'));
 assert.equal(saved.claude.ran,true);
 runner.close();await tick();
 assert.ok(proc.stdinEnded&&proc.killed,'closing ends stdin so claude exits inside the container');
 // A host restart resumes the same conversation.
 const again=new ContainerCompanionRunner({workspace,inspect:async()=>running,stateFile:file,spawn:docker.spawn});
 const third=again.runTurn({prompt:'three'});
 await until(()=>docker.procs[1]?.written.length===1);
 assert.equal(docker.procs[1].args[docker.procs[1].args.indexOf('--resume')+1],saved.claude.sessionId);
 docker.procs[1].say({type:'assistant',message:{content:[{type:'text',text:'from deltas'}]}});
 docker.procs[1].say({type:'result',result:''});
 assert.deepEqual(await third,{text:'from deltas'});
 again.close();
});

test('claude: a vanished conversation is forgotten and the turn re-run once',async t=>{
 const {dir,file}=await stateFile();t.after(()=>rm(dir,{recursive:true,force:true}));
 const docker=fakeDocker();
 const runner=new ContainerCompanionRunner({workspace,inspect:async()=>running,stateFile:file,spawn:docker.spawn});
 await runner.state.load();runner.state.value.claude={sessionId:'old',ran:true};
 const turn=runner.runTurn({prompt:'hi'});
 await until(()=>docker.procs[0]);
 docker.procs[0].stderr.write('No conversation found with session ID: old\n');await tick();
 docker.procs[0].end(1);
 await until(()=>docker.procs[1]?.written.length===1);
 assert.ok(docker.procs[1].args.includes('--session-id'));
 docker.procs[1].say({type:'result',result:'fresh'});
 assert.deepEqual(await turn,{text:'fresh'});
 runner.close();
});

test('codex: one process per turn without stdin, resumed by the thread id it reported',async t=>{
 const {dir,file}=await stateFile();t.after(()=>rm(dir,{recursive:true,force:true}));
 const docker=fakeDocker({installed:['codex']});
 const runner=new ContainerCompanionRunner({workspace,inspect:async()=>running,stateFile:file,spawn:docker.spawn});
 const first=runner.runTurn({prompt:'status?'});
 await until(()=>docker.procs[0]);
 const p=docker.procs[0];
 assert.equal(p.options.stdio[0],'ignore');
 assert.ok(!p.args.includes('-i'));
 assert.deepEqual(p.args.slice(p.args.indexOf('codex')+1,-1),['exec','--json','--skip-git-repo-check','-C','/workspace','--add-dir','/workspace','-s','read-only']);
 assert.match(p.args.at(-1),/^# You are Ash[\s\S]*\n\n---\n\nstatus\?$/);
 p.say({type:'thread.started',thread_id:'th-9'});p.say({type:'item.completed',item:{type:'error',message:'Skill descriptions were shortened'}});
 p.say({type:'item.completed',item:{type:'agent_message',text:'All green.'}});p.say({type:'turn.completed'});p.end();
 assert.deepEqual(await first,{text:'All green.'});
 const second=runner.runTurn({prompt:'and now?'});
 await until(()=>docker.procs[1]);
 const q=docker.procs[1];
 assert.deepEqual(q.args.slice(q.args.indexOf('codex')+1,-1),['exec','resume','th-9','--json','--skip-git-repo-check','-c','sandbox_mode="read-only"']);
 q.say({type:'turn.failed',error:{message:'usage limit'}});q.end(1);
 await assert.rejects(second,/usage limit/);
 const third=runner.runTurn({prompt:'?'});
 await until(()=>docker.procs[2]);
 docker.procs[2].stderr.write('error: unexpected argument\n');docker.procs[2].end(2);
 await assert.rejects(third,/unexpected argument/,'a launch that never spoke JSON reports its stderr');
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{codex:{threadId:'th-9'}});
});

test('a stopped or paused container refuses the turn and runs nothing',async t=>{
 const {dir,file}=await stateFile();t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const inspected of [null,{State:{Running:false}},{State:{Running:true,Paused:true}}]){
  const docker=fakeDocker();let probed=0;
  const runner=new ContainerCompanionRunner({workspace,inspect:async()=>inspected,stateFile:file,spawn:(...a)=>{probed++;return docker.spawn(...a);}});
  await assert.rejects(runner.runTurn({prompt:'x'}),/not running/);
  assert.equal(probed,0);
 }
});

// ---- the host gate ----

function hostHarness({enabled=true,inspected=running,managed=true}={}){
 const calls=[],created=[],closed=[];
 const config={workspaces:[{...workspace}],...(managed?{managedSession:{workspaceId:'ws-a',key:'k'.repeat(40)}}:{})};
 const controlPlane={slackHub:async(ws,action)=>{calls.push(action);if(action==='status')return {enabled:typeof enabled==='function'?enabled():enabled,desktopActive:false};return {};}};
 const host=new SlackCompanionHost({config,controlPlane,inspect:async()=>typeof inspected==='function'?inspected():inspected,log:()=>{},
  createRunner:ws=>({ws,runTurn:async()=>({text:'ok'}),close:()=>closed.push('runner')}),
  createCompanion:options=>{const c={options,started:0,start(){c.started++;},close(){closed.push('companion');}};created.push(c);return c;}});
 return {host,calls,created,closed,config};
}

test('the poller is not started without a managed session, the opt-in, or a running container',async()=>{
 const unmanaged=hostHarness({managed:false});
 assert.equal(await unmanaged.host.check(),'unmanaged');assert.deepEqual(unmanaged.calls,[]);assert.equal(unmanaged.created.length,0);
 const off=hostHarness({enabled:false});
 assert.equal(await off.host.check(),'off');assert.equal(off.created.length,0);
 const stopped=hostHarness({inspected:{State:{Running:false}}});
 assert.equal(await stopped.host.check(),'stopped');assert.equal(stopped.created.length,0);assert.deepEqual(stopped.calls,[],'a stopped workspace is not even asked about');
 const hibernated=hostHarness();hibernated.config.workspaces[0].desiredState='stopped';
 assert.equal(await hibernated.host.check(),'stopped');assert.equal(hibernated.created.length,0);
});

test('the poller starts once, stops when the opt-in or the container goes, restarts on a new generation',async()=>{
 let enabled=true,up=true;
 const h=hostHarness({enabled:()=>enabled,inspected:()=>up?running:{State:{Running:false}}});
 assert.equal(await h.host.check(),'on');assert.equal(await h.host.check(),'on');
 assert.equal(h.created.length,1);assert.equal(h.created[0].started,1);
 assert.equal(h.created[0].options.workspace.id,'ws-a');
 enabled=false;assert.equal(await h.host.check(),'off');assert.deepEqual(h.closed,['companion','runner']);
 enabled=true;await h.host.check();assert.equal(h.created.length,2);
 up=false;assert.equal(await h.host.check(),'stopped');assert.equal(h.closed.length,4);
 up=true;await h.host.check();assert.equal(h.created.length,3);
 h.config.workspaces[0]={...workspace,generation:4};
 await h.host.check();assert.equal(h.created.length,4);assert.equal(h.created[3].options.workspace.generation,4);
 h.host.close();assert.equal(h.closed.length,8);
});

test('end to end: a leased Slack message runs one turn in the container and is answered once',async t=>{
 const {dir,file}=await stateFile();t.after(()=>rm(dir,{recursive:true,force:true}));
 const docker=fakeDocker();
 const item={id:'itemitem01',kind:'message',senderLabel:'Olive',senderRole:'me',channelType:'im',text:'what is dirty?'};
 const polls=[{enabled:true,deferred:null,items:[item]},{enabled:true,deferred:null,items:[item]}];
 const calls=[];
 const controlPlane={slackHub:async(ws,action,input={})=>{calls.push({action,...input});if(action==='status')return {enabled:true};if(action==='poll')return polls.shift()??{enabled:true,deferred:null,items:[]};return {};}};
 let companion;
 const host=new SlackCompanionHost({config:{workspaces:[workspace],managedSession:{workspaceId:'ws-a'}},controlPlane,inspect:async()=>running,log:()=>{},
  createRunner:ws=>new ContainerCompanionRunner({workspace:ws,inspect:async()=>running,stateFile:file,spawn:docker.spawn}),
  createCompanion:options=>(companion=new SlackCompanion({...options,sleep:async()=>{}}),Object.assign(companion,{start(){}}))});
 assert.equal(await host.check(),'on');
 await companion.tick();await companion.tick();
 await until(()=>docker.procs[0]?.written.length===1);
 const sent=docker.procs[0].written[0].message.content[0].text;
 assert.match(sent,/^\[Slack: from Olive, the owner of this Canopy, in a direct message\.[^\n]*\]\n\nwhat is dirty\?$/);
 docker.procs[0].say({type:'result',result:'Two files on `main` in api.'});
 await companion.idle();
 assert.deepEqual(calls.filter(c=>c.action==='reply'),[{action:'reply',id:'itemitem01',text:'Two files on `main` in api.'}]);
 assert.equal(docker.procs[0].written.length,1,'a renewed lease never runs the turn twice');
 host.close();
});

test('only the owner pressing Approve approves; anything else is denial',async()=>{
 const statuses=[{resolution:'approved',accepted:false},{resolution:'denied',accepted:false},{resolution:'expired',accepted:false},{resolution:'approved',accepted:true}];
 const results=[];
 const controlPlane={slackHub:async(ws,action)=>{if(action==='poll')return {enabled:true,deferred:null,items:[{id:'itemitem01',kind:'message',senderLabel:'Sam',senderRole:'teammate',channelType:'channel',text:'deploy'}]};if(action==='approval-status')return statuses.shift();return {};}};
 const c=new SlackCompanion({controlPlane,workspace,log:()=>{},sleep:async()=>{},runTurn:async({requestApproval})=>{for(let i=0;i<4;i++)results.push((await requestApproval({summary:'Deploy'})).accepted);return {text:'done'};}});
 await c.tick();await c.idle();
 assert.deepEqual(results,[false,false,false,true]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRunner} from './runner.mjs';
import {ServiceHarness} from './service-harness.mjs';
import {SessionResume,resumePlan,keptFlags,foldEvents,editedPaths,parseProcesses,agentArgv,runnerCommand,PROCESS_SCRIPT,titleText,terminalDescription,agentActivity} from './session-resume.mjs';

const secret='s'.repeat(64);
const CONVERSATION='0fc2faf8-f255-43bf-8927-fcb18a615f3d';
const event=(pty,fields)=>JSON.stringify({agent:'claude',canopy_pty:pty,session_id:CONVERSATION,cwd:'/workspace/app',transcript_path:'/home/agent/.claude/projects/-workspace-app/'+CONVERSATION+'.jsonl',permission_mode:'auto',...fields});

test('only how the agent ran is kept; a positional prompt is never replayed',()=>{
 assert.deepEqual(keptFlags('claude',['claude','--permission-mode','auto','--dangerously-skip-permissions','fix the build','--resume','old','-p']),['--permission-mode','auto','--dangerously-skip-permissions']);
 assert.deepEqual(keptFlags('claude',['node','/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js','--model=opus','hello']),['--model=opus']);
 assert.deepEqual(keptFlags('codex',['codex','-m','gpt-5','--full-auto','do it']),['-m','gpt-5','--full-auto']);
 assert.deepEqual(keptFlags('claude',['/bin/sh','/home/agent/.local/bin/claude','--dangerously-skip-permissions']),['--dangerously-skip-permissions'],'a wrapper script');
 assert.deepEqual(keptFlags('claude',['/home/agent/.local/bin/claude','--model','opus']),['--model','opus']);
 assert.equal(keptFlags('claude',['python','claude','--model','x']),null);
 assert.equal(keptFlags('claude',['bash']),null);
 assert.equal(keptFlags('aider',['aider']),null);
});

test('resume plans: agents with a conversation come back, everything else is interrupted',()=>{
 const agent={agent:'claude',sessionId:CONVERSATION,cwd:'/workspace/app',argv:['claude','--permission-mode','auto','--dangerously-skip-permissions']};
 const plan=resumePlan({live:{kind:'terminal',accountId:null},agent,metadata:{cwd:'/workspace'}});
 assert.deepEqual(plan.resume.argv,['claude','--resume',CONVERSATION,'--permission-mode','auto','--dangerously-skip-permissions']);
 assert.equal(plan.resume.command,`claude --resume ${CONVERSATION} --permission-mode auto --dangerously-skip-permissions`);
 assert.equal(plan.resume.cwd,'/workspace/app','the agent directory, where its conversation is filed');
 assert.equal(runnerCommand(plan.resume,'resume-4-100'),`cd '/workspace/app' && env 'CANOPY_SESSION_REQUEST_ID=resume-4-100' claude --resume ${CONVERSATION} --permission-mode auto --dangerously-skip-permissions; exec /bin/bash -l`);
 assert.deepEqual(resumePlan({live:{},agent:{...agent,agent:'codex',argv:undefined}}).resume.argv,['codex','resume',CONVERSATION]);
 assert.deepEqual(resumePlan({live:{},agent:{...agent,argv:undefined,permissionMode:'bypassPermissions'}}).resume.argv.slice(3),['--dangerously-skip-permissions']);
 const profile=resumePlan({live:{},agent:{...agent,transcriptPath:'/home/agent/.canopy/profiles/work/.claude/projects/x/y.jsonl'}});
 assert.deepEqual(profile.resume.env,[['CLAUDE_CONFIG_DIR','/home/agent/.canopy/profiles/work/.claude']]);
 const reasons=[
  [{live:{kind:'build'},agent},'build'],
  [{live:{accountId:'pool'},agent},'account-pool'],
  [{live:{},agent,metadata:{projectId:'shared'},sharedProjects:new Set(['shared'])},'shared-project'],
  [{live:{}},'no-agent'],
  [{live:{},agent:{...agent,ended:true}},'agent-exited'],
  [{live:{},agent:{...agent,agent:'aider'}},'not-resumable'],
  [{live:{},agent:{...agent,sessionId:'claude-pty4'}},'no-conversation'],
  [{live:{},agent:{...agent,sessionId:'x; rm -rf /'}},'no-conversation'],
  [{live:{},agent:{...agent,cwd:'/etc'},metadata:{cwd:'/workspace/../etc'}},'no-directory'],
 ];
 for(const [input,reason] of reasons)assert.equal(resumePlan(input).interrupted,reason,reason);
});

test('hook events fold to the latest agent per terminal; a stop-time SessionEnd is not an exit',()=>{
 const agents={};
 foldEvents(agents,[event(4,{hook_event_name:'SessionStart'}),'not json',event(5,{hook_event_name:'SessionEnd',reason:'exit'})]);
 assert.equal(agents[4].sessionId,CONVERSATION);assert.equal(agents[4].ended,false);assert.equal(agents[5].ended,true);
 agents[4].argv=['claude'];
 foldEvents(agents,[event(4,{hook_event_name:'Stop'})]);assert.deepEqual(agents[4].argv,['claude'],'same conversation keeps its observed launch');
 foldEvents(agents,[event(4,{hook_event_name:'SessionEnd',reason:'other'})]);assert.equal(agents[4].ended,false);
 foldEvents(agents,[event(4,{hook_event_name:'SessionStart',session_id:'1111aaaa-0000-0000-0000-000000000000'})]);assert.equal(agents[4].argv,undefined,'a new conversation is observed afresh');
});

test('the agent process is found under its terminal and its full argv kept',()=>{
 const listing=['1\t0\tnode\x1f/opt/canopy/runner.mjs\x1f','40\t1\t/bin/bash\x1f-lc\x1fexport x\x1f','41\t40\tbash\x1f','42\t41\tclaude\x1f--permission-mode\x1fauto\x1f--dangerously-skip-permissions\x1f','43\t42\t/usr/local/bin/canopy-hook\x1f--mcp\x1f','junk'].join('\n');
 const processes=parseProcesses(listing);
 assert.equal(processes.length,5);
 assert.deepEqual(agentArgv(processes,40,'claude'),['claude','--permission-mode','auto','--dangerously-skip-permissions']);
 assert.equal(agentArgv(processes,40,'codex'),null);
 assert.match(PROCESS_SCRIPT,/\/proc\/\[0-9\]\*/);
});

function fakeAdmin({down=false}={}){
 const calls=[];const state={down};
 return {calls,state,
  async registerWorkspace(id,body){calls.push(['register',id]);if(state.down)throw Object.assign(Error('Canopy service is unavailable'),{code:'unavailable'});return {agentSocketDir:`/run/canopy-service/ws/${id}`};},
  async deregisterWorkspace(){return {};},
  async mintTerminal(id,body){calls.push(['mint',body.requestId,body.agent]);return {token:'credential-'+'t'.repeat(24)};},
  async bindTerminal(id,requestId,body){calls.push(['bind',requestId,body.sessionId]);return {};},
  async revokeTerminal(id,requestId){calls.push(['revoke',requestId]);return {};},
  async describeTerminal(id,requestId,body){calls.push(['describe',requestId,body]);return {};},
  async putAccess(){return {};},async device(){return {};},
 };
}

// A real runner (history on disk, as in the container) behind a fake native
// boundary, a fake Docker for inspect/exec and the real ServiceHarness.
async function fixture({down=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'session-resume-'));
 const historyFile=join(directory,'session-history.json');
 const launches=[];let pid=100;
 const spawnPty=(bin,args,options)=>{launches.push({command:args[1],env:options.env});return {pid:++pid,onData(){},onExit(){},kill(){},resize(){},write(){}};};
 let server,url;
 const startRunner=async()=>{server=createRunner({secret,spawnPty,historyFile,workspaceId:'alice'});server.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}`;runtime.url=url;};
 const stopRunner=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
 const runtime={url:null,nativeUrl:'http://native.test',token:secret,harness:true};
 const native={metadata:{},events:[]};
 const fetchImpl=async(target,options)=>{
  if(!String(target).startsWith('http://native.test'))return fetch(target,options);
  const {command,args}=JSON.parse(options.body);
  let result=null;
  if(command==='pty_metadata_get')result=structuredClone(native.metadata);
  else if(command==='pty_metadata_set')native.metadata[String(args.id)]=args.value;
  else if(command==='agent_events_poll'){const offset=Number(String(args.cursor).split(':')[0]==='ino'?String(args.cursor).split(':')[1]:0);result={cursor:`ino:${native.events.length}`,lines:native.events.slice(offset)};}
  else throw Error('unexpected native '+command);
  return new Response(JSON.stringify({result}),{status:200});
 };
 const docker={startedAt:'2026-10-12T08:00:00.000Z',processes:''};
 const workspace={id:'alice',name:'Alice'};
 const config={workspaces:[workspace],managedSession:{workspaceId:'alice',ownerUserId:'user-1'}};
 const host={runtimes:new Map([['alice',{workspace,runtime}]]),
  inspectRuntime:async()=>({Id:'c'.repeat(64),State:{Running:true,StartedAt:docker.startedAt}}),
  docker:async args=>{assert.equal(args[0],'exec');return {stdout:docker.processes};}};
 const admin=fakeAdmin({down});
 const harness=new ServiceHarness({admin,config,tokenFor:()=>secret,log:()=>{}});
 const logs=[];
 const resume=new SessionResume({directory:join(directory,'state'),host,harness,config,fetch:fetchImpl,log:message=>logs.push(message),serviceWaitMs:60000});
 await startRunner();
 const desktopSpawn=async(body,metadata)=>{const response=await fetch(url+'/sessions',{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(body)});const session=await response.json();native.metadata[String(session.id)]=metadata;return session;};
 return {directory,launches,native,docker,admin,resume,workspace,runtime,logs,startRunner,stopRunner,desktopSpawn,
  restart:async startedAt=>{await stopRunner();docker.startedAt=startedAt;await startRunner();},
  cleanup:async()=>{await stopRunner().catch(()=>{});await rm(directory,{recursive:true,force:true});}};
}

test('after a container restart the running agent comes back with its conversation and its Canopy tools',async()=>{
 const f=await fixture();
 try{
  const agentTerminal=await f.desktopSpawn({requestId:'desktop-1',command:"cd '/workspace/app' && env 'CANOPY_SESSION_REQUEST_ID=desktop-1' /bin/bash"},{cwd:'/workspace/app',projectId:'p1',title:'✳ Fix checkout',name:'checkout',command:'/bin/bash',requestId:'desktop-1',run:false});
  const shell=await f.desktopSpawn({requestId:'desktop-2',command:'/bin/bash'},{cwd:'/workspace',projectId:'p1',title:'shell',command:'/bin/bash',requestId:'desktop-2',run:false});
  f.native.events.push(event(agentTerminal.id,{hook_event_name:'UserPromptSubmit'}));
  f.docker.processes=[`${agentTerminal.pid}\t1\t/bin/bash\x1f-lc\x1fx\x1f`,`900\t${agentTerminal.pid}\tclaude\x1f--permission-mode\x1fauto\x1f--dangerously-skip-permissions\x1f`].join('\n');
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'watching','the first observation only records');
  assert.equal(f.launches.length,2);

  await f.restart('2026-10-12T08:37:50.000Z');
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'resumed');
  assert.equal(f.launches.length,3,'one agent resumed, the plain shell is not re-run');
  const resumed=f.launches[2];
  assert.match(resumed.command,new RegExp(`cd '/workspace/app' && env 'CANOPY_SESSION_REQUEST_ID=resume-${agentTerminal.id}-\\d+' claude --resume ${CONVERSATION} --permission-mode auto --dangerously-skip-permissions; exec /bin/bash -l$`));
  assert.equal(resumed.env.CANOPY_CTX_SOCKET,'/run/canopy-ctx/ctx.sock','the resumed agent is inside a Canopy terminal');
  assert.equal(resumed.env.CANOPY_CTX_TOKEN,'credential-'+'t'.repeat(24));
  const order=f.admin.calls.filter(c=>['mint','bind','revoke'].includes(c[0])).map(c=>c[0]);
  assert.deepEqual(order,['mint','bind'],'minted before the spawn, bound after it');
  const newId=f.admin.calls.find(c=>c[0]==='bind')[2];
  assert.deepEqual(f.native.metadata[String(newId)],{cwd:'/workspace/app',projectId:'p1',title:'✳ Fix checkout',name:'checkout',command:`claude --resume ${CONVERSATION} --permission-mode auto --dangerously-skip-permissions`,requestId:`resume-${agentTerminal.id}-1791794270`,run:false,resumedFrom:agentTerminal.id});
  assert.equal(f.native.metadata[String(agentTerminal.id)].resumedAs,newId);
  assert.equal(f.native.metadata[String(shell.id)].interrupted.reason,'no-agent','the shell is shown as interrupted');

  assert.equal(await f.resume.observe(f.workspace,f.runtime),'watching');
  assert.equal(f.launches.length,3,'resumed once');
  const state=JSON.parse(await readFile(join(f.directory,'state','alice.json'),'utf8'));
  assert.deepEqual(state.lastRecovery.resumed,[{from:agentTerminal.id,to:newId,agent:'claude'}]);
  assert.deepEqual(state.lastRecovery.interrupted,[{id:shell.id,reason:'no-agent'}]);
 }finally{await f.cleanup();}
});

test('nothing respawns while the Canopy service is unavailable, then the agent resumes with its tools',async()=>{
 const f=await fixture({down:true});
 try{
  const terminal=await f.desktopSpawn({requestId:'desktop-1',command:'/bin/bash'},{cwd:'/workspace/app',projectId:'p1',command:'/bin/bash',requestId:'desktop-1'});
  f.native.events.push(event(terminal.id,{hook_event_name:'Stop'}));
  await f.resume.observe(f.workspace,f.runtime);
  await f.restart('2026-10-12T09:00:00.000Z');
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'waiting-for-service');
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'waiting-for-service');
  assert.equal(f.launches.length,1,'no agent starts without its Canopy credential');
  f.admin.state.down=false;
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'resumed');
  assert.equal(f.launches.length,2);
  assert.ok(f.launches[1].env.CANOPY_CTX_TOKEN);
  assert.match(f.launches[1].command,/claude --resume 0fc2faf8-f255-43bf-8927-fcb18a615f3d --permission-mode auto; exec/,'without an observed launch the hook permission mode is used');
 }finally{await f.cleanup();}
});

test('a service that never returns leaves agents interrupted instead of tool-less',async()=>{
 const f=await fixture({down:true});
 try{
  const terminal=await f.desktopSpawn({requestId:'desktop-1',command:'/bin/bash'},{cwd:'/workspace/app',command:'/bin/bash',requestId:'desktop-1'});
  f.native.events.push(event(terminal.id,{hook_event_name:'Stop'}));
  await f.resume.observe(f.workspace,f.runtime);
  await f.restart('2026-10-12T09:00:00.000Z');
  let clock=Date.now();f.resume.now=()=>clock;
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'waiting-for-service');
  clock+=61000;
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'resumed');
  assert.equal(f.launches.length,1);
  assert.equal(f.native.metadata[String(terminal.id)].interrupted.reason,'service-unavailable');
 }finally{await f.cleanup();}
});

test('interrupted sessions from before the host first watched are never resumed',async()=>{
 const f=await fixture();
 try{
  const terminal=await f.desktopSpawn({requestId:'desktop-1',command:'/bin/bash'},{cwd:'/workspace/app',command:'/bin/bash',requestId:'desktop-1'});
  f.native.events.push(event(terminal.id,{hook_event_name:'Stop'}));
  await f.restart('2026-10-12T09:00:00.000Z');
  assert.equal((await (await fetch(f.runtime.url+'/sessions',{headers:{authorization:`Bearer ${secret}`}})).json())[0].exitCode,-1);
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'watching');
  await f.resume.observe(f.workspace,f.runtime);
  assert.equal(f.launches.length,1,'an old -1 record is history, not a running agent');
 }finally{await f.cleanup();}
});

test('members and stopped workspaces are left alone',async()=>{
 const f=await fixture();
 try{
  assert.equal(await f.resume.observe({id:'member-x',memberId:'m',parentWorkspaceId:'alice'},f.runtime),'ineligible');
  f.resume.config.workspaces[0].desiredState='stopped';
  assert.equal(await f.resume.observe(f.workspace,f.runtime),'ineligible');
 }finally{await f.cleanup();}
});

test('tab titles become the roster task; shells and agent names do not',()=>{
 assert.equal(titleText('✳ Fix checkout','/bin/bash'),'Fix checkout');
 assert.equal(titleText('◑ SignImplementation'),'SignImplementation');
 for(const shell of ['/bin/bash','bash','~/w','claude','✳ codex','',undefined])assert.equal(titleText(shell,'/bin/bash'),undefined,String(shell));
 assert.deepEqual(terminalDescription({agent:'claude',ended:false},{name:'XLs',title:'✳ Classify ledgers',command:'/bin/bash'}),{agent:'claude',name:'XLs',task:'Classify ledgers'});
 assert.deepEqual(terminalDescription(undefined,{title:'✳ Fix checkout'}),{agent:'',name:'Fix checkout',task:''});
 assert.deepEqual(terminalDescription({agent:'codex',ended:true},{}),{agent:'',name:'',task:''});
});

test('live terminals are described to the Canopy service once per change',async()=>{
 const f=await fixture();
 try{
  const terminal=await f.desktopSpawn({requestId:'desktop-1',command:'/bin/bash'},{cwd:'/workspace/app',projectId:'p1',title:'✳ Fix checkout',name:'checkout',command:'/bin/bash',requestId:'desktop-1'});
  f.native.events.push(event(terminal.id,{hook_event_name:'UserPromptSubmit'}));
  await f.resume.observe(f.workspace,f.runtime);
  const described=()=>f.admin.calls.filter(c=>c[0]==='describe');
  assert.deepEqual(described(),[['describe','desktop-1',{agent:'claude',name:'checkout',task:'Fix checkout',activity:{title:'working',description:''}}]]);
  await f.resume.observe(f.workspace,f.runtime);
  assert.equal(described().length,1,'unchanged, not sent again');
  f.native.metadata[String(terminal.id)].title='✳ Ship refunds';
  await f.resume.observe(f.workspace,f.runtime);
  assert.deepEqual(described().at(-1)[2],{agent:'claude',name:'checkout',task:'Ship refunds',activity:{title:'working',description:''}});
  f.native.events.push(event(terminal.id,{hook_event_name:'UserPromptSubmit',prompt:'fix the totals'}),event(terminal.id,{hook_event_name:'PreToolUse',tool_name:'Bash'}));
  await f.resume.observe(f.workspace,f.runtime);
  assert.deepEqual(described().at(-1)[2].activity,{title:'working · Bash',description:'Last asked: fix the totals'});
  f.native.events.push(event(terminal.id,{hook_event_name:'Stop'}));
  await f.resume.observe(f.workspace,f.runtime);
  assert.deepEqual(described().at(-1)[2].activity,{title:'idle, waiting for you',description:'Last asked: fix the totals'});
 }finally{await f.cleanup();}
});

test('event reading starts within the recent tail and catches up when far behind',async()=>{
 const asked=[];const native={agent_events_poll:args=>{asked.push(args.cursor);return args.cursor==null?{cursor:'7:100000000',lines:[]}:{cursor:args.cursor,lines:[]};}};
 const resume=new SessionResume({directory:'/nonexistent',host:{},config:{workspaces:[]},log:()=>{}});
 resume.native=async(runtime,command,args)=>native[command](args);
 const state={cursor:null,agents:{}};
 await resume.readEvents({},state);
 assert.equal(state.cursor,`7:${100000000-8*1024*1024}`);
 state.cursor='7:99999000';await resume.readEvents({},state);
 assert.equal(state.cursor,'7:99999000','a near cursor is kept');
 state.cursor='3:50';await resume.readEvents({},state);
 assert.equal(state.cursor,`7:${100000000-8*1024*1024}`,'a rotated file restarts within the tail');
});

test('activity reads the last hook event; injected notices are not prompts',()=>{
 const agents={};
 foldEvents(agents,[event(7,{hook_event_name:'UserPromptSubmit',prompt:'ship it'}),event(7,{hook_event_name:'UserPromptSubmit',prompt:'<task-notification>x'}),event(7,{hook_event_name:'Notification'})]);
 assert.deepEqual(agentActivity(agents[7]),{title:'waiting for input',description:'Last asked: ship it'});
 foldEvents(agents,[event(7,{hook_event_name:'SessionEnd',reason:'exit'})]);
 assert.equal(agentActivity(agents[7]).title,'ended');
 assert.deepEqual(agentActivity(undefined),{title:'',description:''});
});

test('the roster learns which files each agent wrote, relative to its checkout, and its repository',async()=>{
 assert.deepEqual(editedPaths({hook_event_name:'PostToolUse',tool_name:'Edit',cwd:'/workspace/api',tool_input:{file_path:'src/a.ts'}}),['/workspace/api/src/a.ts']);
 assert.deepEqual(editedPaths({hook_event_name:'PostToolUse',tool_name:'apply_patch',cwd:'/workspace/api',tool_input:{command:['apply_patch','*** Begin Patch\n*** Update File: src/b.ts\n*** Add File: /workspace/api/c.ts\n*** End Patch']}}),['/workspace/api/src/b.ts','/workspace/api/c.ts']);
 assert.deepEqual(editedPaths({hook_event_name:'PreToolUse',tool_name:'Edit',tool_input:{file_path:'/x'}}),[]);
 assert.deepEqual(editedPaths({hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'rm x'}}),[]);
 const agents={};
 const ev=(file,extra={})=>JSON.stringify({canopy_pty:3,hook_event_name:'PostToolUse',tool_name:'Write',session_id:'s1',cwd:'/workspace/api',tool_input:{file_path:file},...extra});
 foldEvents(agents,[ev('/workspace/api/a.ts'),ev('/workspace/api/b.ts')],1000);
 foldEvents(agents,[ev('/workspace/api/a.ts')],2000);
 assert.deepEqual(agents[3].edited,[{path:'/workspace/api/a.ts',ts:2000},{path:'/workspace/api/b.ts',ts:1000}]);
 const natives=[];
 const resume=new SessionResume({directory:'/tmp/none',host:{},harness:null,config:{},now:()=>5000});
 resume.native=async(_runtime,command,args)=>{natives.push(command);return command==='git_repos'?[{path:'/workspace/api'}]:command==='git_remote_url'?'git@github.com:acme/api.git':null;};
 assert.deepEqual(await resume.workInfo({},agents[3]),{repo:'git@github.com:acme/api.git',root:'/workspace/api',files:[{path:'a.ts',ts:2000},{path:'b.ts',ts:1000}]});
 await resume.workInfo({},agents[3]);
 assert.deepEqual(natives,['git_repos','git_remote_url'],'the repository is looked up once, then cached');
 // A service from before the work fields: described without them, once refused.
 const sent=[];
 resume.harness={admin:{async describeTerminal(_id,_rid,body){sent.push(body);if('files' in body){const e=new Error('invalid request body: unknown field `files`');e.status=400;throw e;}return {};}}};
 await resume.describeOne('w','req-12345678',{agent:'x',files:[],repo:null,root:'/workspace/api'});
 await resume.describeOne('w','req-12345678',{agent:'x',files:[],repo:null,root:'/workspace/api'});
 assert.deepEqual(sent,[{agent:'x',files:[],repo:null,root:'/workspace/api'},{agent:'x'},{agent:'x'}]);
});

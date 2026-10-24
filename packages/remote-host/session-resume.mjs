import {mkdir,open,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Brings a workspace's agents back after its container restarts (hang recovery,
// a crash the owner resumed, a VM reboot). Host-owned state, never mounted into
// developer containers, and built only from live observation: the set of
// terminals that were running, the agent each was running and its conversation.
//
// Agents with a known conversation and a CLI that reopens by id are resumed
// through the same mint -> spawn -> bind sequence as a desktop spawn, so they
// keep their Canopy tools. Everything else is marked interrupted on its terminal
// record and never re-run: a build or a typed command may not be safe twice.
const STATE_VERSION=1;
const ROOT='/workspace',HOME='/home/agent';
const MAX_LIVE=64,MAX_AGENTS=256,MAX_ARGS=64,MAX_ARG=4096,EVENT_PAGES=40,EVENT_TAIL=8*1024*1024;
const SESSION_ID=/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const quote=value=>`'${String(value).replaceAll("'",`'\\''`)}'`;
const plainPath=value=>typeof value==='string'&&value.length<=4096&&!/[\0-\x1f\x7f]/.test(value)&&!value.split('/').includes('..');
const inside=(value,root)=>plainPath(value)&&(value===root||value.startsWith(root+'/'));

// Flags that describe how the agent was running, never what it was asked. A
// positional prompt or a one-shot flag must not be replayed into the resumed
// conversation, so anything not listed is dropped. Arity 1 takes a value.
const CLIS={
 claude:{
  // Mirrors src/projects.ts: `${bin} --resume ${id}`.
  resume:id=>['claude','--resume',id],
  flags:{'--permission-mode':1,'--model':1,'--fallback-model':1,'--add-dir':1,'--effort':1,'--dangerously-skip-permissions':0,'--allow-dangerously-skip-permissions':0},
  fallback:mode=>mode==='bypassPermissions'?['--dangerously-skip-permissions']:typeof mode==='string'&&/^[A-Za-z]{1,32}$/.test(mode)&&mode!=='default'?['--permission-mode',mode]:[],
  configDir:transcript=>{const at=transcript?.indexOf('/projects/');return at>0?transcript.slice(0,at):null;},
  configEnv:'CLAUDE_CONFIG_DIR',defaultConfig:HOME+'/.claude',
  bin:'claude',pkg:'/node_modules/@anthropic-ai/claude-code/',
 },
 codex:{
  // Mirrors src/projects.ts: `${bin} resume ${id}`.
  resume:id=>['codex','resume',id],
  flags:{'--model':1,'-m':1,'--sandbox':1,'-s':1,'--ask-for-approval':1,'-a':1,'--profile':1,'-p':1,'--full-auto':0,'--dangerously-bypass-approvals-and-sandbox':0,'--search':0},
  fallback:()=>[],
  configDir:transcript=>{const at=transcript?.indexOf('/sessions/');return at>0?transcript.slice(0,at):null;},
  configEnv:'CODEX_HOME',defaultConfig:HOME+'/.codex',
  bin:'codex',pkg:'/node_modules/@openai/codex/',
 },
};
export const RESUMABLE_AGENTS=Object.keys(CLIS);
const INTERPRETERS=/^(node|sh|bash|dash|zsh)$/;
const base=value=>String(value??'').split('/').pop();
/** Where an agent's own arguments start in a process argv, or -1: the CLI run
 *  directly, or through node or a wrapper script. */
function agentStart(cli,argv){
 if(base(argv[0])===cli.bin)return 1;
 if(INTERPRETERS.test(base(argv[0]))&&(base(argv[1])===cli.bin||String(argv[1]??'').includes(cli.pkg)))return 2;
 return -1;
}

/** The flags of an observed launch worth keeping, in their original order. */
export function keptFlags(agent,argv){
 const cli=CLIS[agent];if(!cli||!Array.isArray(argv))return null;
 const start=agentStart(cli,argv);
 if(start<0)return null;
 const kept=[];
 for(let i=start;i<argv.length;i++){
  const arg=argv[i],eq=arg.indexOf('='),name=arg.startsWith('--')&&eq>0?arg.slice(0,eq):arg;
  if(!Object.hasOwn(cli.flags,name))continue;
  if(cli.flags[name]===0){if(name===arg)kept.push(arg);continue;}
  if(name!==arg){kept.push(arg);continue;}
  if(i+1<argv.length){kept.push(arg,argv[i+1]);i++;}
 }
 return kept;
}

/** How an interrupted terminal comes back: a resume command, or why not. */
export function resumePlan({live,agent,metadata,sharedProjects=new Set()}){
 if(live.kind&&live.kind!=='terminal')return {interrupted:'build'};
 if(live.accountId)return {interrupted:'account-pool'};
 if(metadata?.projectId&&sharedProjects.has(metadata.projectId))return {interrupted:'shared-project'};
 if(!agent)return {interrupted:'no-agent'};
 if(agent.ended)return {interrupted:'agent-exited'};
 const cli=CLIS[agent.agent];
 if(!cli)return {interrupted:'not-resumable'};
 if(typeof agent.sessionId!=='string'||!SESSION_ID.test(agent.sessionId)||/-pty\d*$/.test(agent.sessionId))return {interrupted:'no-conversation'};
 const cwd=inside(agent.cwd,ROOT)?agent.cwd:inside(metadata?.cwd,ROOT)?metadata.cwd:null;
 if(!cwd)return {interrupted:'no-directory'};
 const flags=keptFlags(agent.agent,agent.argv)??cli.fallback(agent.permissionMode);
 const argv=[...cli.resume(agent.sessionId),...flags];
 const env=[];
 const config=cli.configDir(agent.transcriptPath);
 if(config&&config!==cli.defaultConfig&&inside(config,HOME))env.push([cli.configEnv,config]);
 return {resume:{agent:agent.agent,sessionId:agent.sessionId,cwd,argv,env,command:argv.map(arg=>/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)?arg:quote(arg)).join(' ')}};
}

/** The runner command: the agent in its directory, then a shell, as a desktop
 *  terminal is a shell the agent was typed into. */
export function runnerCommand(plan,requestId){
 const env=[...plan.env,['CANOPY_SESSION_REQUEST_ID',requestId]].map(([key,value])=>quote(key+'='+value)).join(' ');
 return `cd ${quote(plan.cwd)} && env ${env} ${plan.command}; exec /bin/bash -l`;
}

/** A prompt the user typed, not an injected notice (those start with '<'). */
const humanPrompt=text=>typeof text==='string'&&text.trim()&&!text.trimStart().startsWith('<')?text.replace(/\s+/g,' ').trim():undefined;
/** What the agent is doing, from its last hook event: the roster's status
 *  until the agent names its own. */
export function agentActivity(agent){
 if(!agent)return {title:'',description:''};
 const event=agent.lastEvent;
 const title=agent.ended||event==='SessionEnd'?'ended'
  :event==='Stop'||event==='SubagentStop'?'idle, waiting for you'
  :event==='Notification'?'waiting for input'
  :event==='PreToolUse'||event==='PostToolUse'?`working${agent.lastTool?` · ${agent.lastTool}`:''}`
  :event==='UserPromptSubmit'||event==='SessionStart'?'working':'';
 return {title,description:agent.prompt?`Last asked: ${agent.prompt}`:''};
}
/** Latest agent state per terminal from hook events (agent-events.jsonl lines). */
export function foldEvents(agents,lines){
 for(const line of lines){
  let event;try{event=JSON.parse(line);}catch{continue;}
  const pty=Number(event?.canopy_pty);
  if(!Number.isSafeInteger(pty)||pty<1||typeof event.hook_event_name!=='string')continue;
  const agent=typeof event.agent==='string'?event.agent:typeof event.session_id==='string'?'claude':null;
  if(!agent)continue;
  const previous=agents[pty];
  const sessionId=typeof event.session_id==='string'?event.session_id:previous?.agent===agent?previous.sessionId:undefined;
  const changed=!previous||previous.agent!==agent||previous.sessionId!==sessionId;
  agents[pty]={agent,sessionId,
   cwd:typeof event.cwd==='string'?event.cwd:previous?.cwd,
   transcriptPath:typeof event.transcript_path==='string'?event.transcript_path:changed?undefined:previous?.transcriptPath,
   permissionMode:typeof event.permission_mode==='string'?event.permission_mode:changed?undefined:previous?.permissionMode,
   argv:changed?undefined:previous?.argv,
   lastEvent:event.hook_event_name,
   lastTool:typeof event.tool_name==='string'?event.tool_name:['PreToolUse','PostToolUse'].includes(event.hook_event_name)?previous?.lastTool:undefined,
   prompt:humanPrompt(event.prompt)??(changed?undefined:previous?.prompt),
   // A container stop can end the CLI with reason "other"; only a session the
   // user closed (exit, /clear, logout) is finished.
   ended:event.hook_event_name==='SessionEnd'&&event.reason!=='other'};
 }
 const keys=Object.keys(agents).map(Number).sort((a,b)=>a-b);
 for(const key of keys.slice(0,Math.max(0,keys.length-MAX_AGENTS)))delete agents[key];
 return agents;
}

/** /proc listing inside the container, one process per line: pid, ppid, argv. */
export const PROCESS_SCRIPT='for d in /proc/[0-9]*; do p=${d#/proc/}; s=$(cat $d/stat 2>/dev/null) || continue; s=${s##*) }; set -- $s; printf "%s\\t%s\\t" "$p" "$2"; tr "\\000" "\\037" < $d/cmdline 2>/dev/null; echo; done';
export function parseProcesses(text){
 const processes=[];
 for(const line of String(text).split('\n')){
  const [pid,ppid,raw]=line.split('\t');
  if(!/^\d+$/.test(pid??'')||!/^\d+$/.test(ppid??''))continue;
  const argv=(raw??'').split('\x1f').filter((arg,index,all)=>index<all.length-1||arg);
  processes.push({pid:Number(pid),ppid:Number(ppid),argv:argv.slice(0,MAX_ARGS).map(arg=>arg.slice(0,MAX_ARG))});
 }
 return processes;
}
/** The agent process each live terminal is running, found under its PTY root. */
export function agentArgv(processes,rootPid,agent){
 const cli=CLIS[agent];if(!cli||!Number.isSafeInteger(rootPid))return null;
 const children=new Map();for(const proc of processes){if(!children.has(proc.ppid))children.set(proc.ppid,[]);children.get(proc.ppid).push(proc);}
 let level=children.get(rootPid)??[];
 const root=processes.find(proc=>proc.pid===rootPid);if(root&&agentStart(cli,root.argv)>0)return root.argv;
 for(let depth=0;level.length&&depth<16;depth++){
  const found=level.find(proc=>agentStart(cli,proc.argv)>0);if(found)return found.argv;
  level=level.flatMap(proc=>children.get(proc.pid)??[]);
 }
 return null;
}

/** A tab title as the agent's task: the CLI's working glyph dropped, a bare
 *  shell or command name ignored. */
export function titleText(title,command){
 if(typeof title!=='string'||/^\s*(\/|~)/.test(title))return undefined;
 const text=title.replace(/^[^\p{L}\p{N}]+/u,'').trim();
 if(!text||text===command||/^(bash|zsh|sh|fish|login)$/i.test(text)||RESUMABLE_AGENTS.includes(text.toLowerCase()))return undefined;
 return text;
}
/** What the Canopy service's roster should say about one live terminal. */
export function terminalDescription(agent,metadata){
 const task=titleText(metadata?.title,metadata?.command);
 const name=typeof metadata?.name==='string'&&metadata.name.trim()?metadata.name.trim():task;
 return {agent:agent&&!agent.ended?agent.agent:'',name:name??'',task:task&&task!==name?task:''};
}

export class SessionResume{
 constructor({directory,host,harness,config,fetch:fetchImpl=fetch,now=Date.now,log=message=>console.warn(message),intervalMs=15000,serviceWaitMs=300000}){
  Object.assign(this,{directory,host,harness,config,fetch:fetchImpl,now,log,intervalMs,serviceWaitMs});
 }
 file(id){return join(this.directory,id+'.json');}
 async load(id){
  let file;
  try{
   file=await open(this.file(id),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();
   if(!info.isFile()||info.size>1024*1024)throw Error('Invalid session resume state');
   const value=JSON.parse(await file.readFile('utf8'));
   if(value?.version!==STATE_VERSION||value.workspaceId!==id)throw Error('Invalid session resume state');
   return value;
  }catch(error){if(error.code==='ENOENT')return {version:STATE_VERSION,workspaceId:id,startedAt:null,live:{},agents:{},cursor:null,pending:null};throw error;}
  finally{await file?.close();}
 }
 async save(state){
  await mkdir(this.directory,{recursive:true,mode:0o700});
  const destination=this.file(state.workspaceId),temporary=destination+'.'+randomUUID()+'.next';
  let file;
  try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(state));await file.sync();await file.close();file=undefined;await rename(temporary,destination);}
  finally{await file?.close();await rm(temporary,{force:true});}
 }
 async runner(runtime,path,{method='GET',body,timeoutMs=10000,native=false}={}){
  const response=await this.fetch(`${native&&runtime.nativeUrl?runtime.nativeUrl:runtime.url}${path}`,{method,redirect:'error',headers:{authorization:`Bearer ${runtime.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  const text=await response.text();
  if(text.length>4*1024*1024)throw Error('Workspace response too large');
  const value=text?JSON.parse(text):null;
  if(!response.ok)throw Error(value?.error??`Workspace answered ${response.status}`);
  return value;
 }
 native(runtime,command,args={}){return this.runner(runtime,'/native',{method:'POST',body:{command,args},native:true}).then(value=>value?.result??null);}
 eligible(workspace){
  if(!workspace||workspace.memberId||workspace.parentWorkspaceId)return false;
  const current=this.config.workspaces.find(w=>w.id===workspace.id);
  return !!current&&!['stopped','deleted'].includes(current.desiredState??current.desired_state);
 }
 async readEvents(runtime,state){
  // Only recent history matters: start (or catch up) within the last
  // EVENT_TAIL bytes. A cursor-less poll reads nothing and reports the end.
  const end=await this.native(runtime,'agent_events_poll',{cursor:null});
  const [ino,size]=String(end?.cursor??'').split(':');
  if(/^\d+$/.test(size??'')){
   const [at,offset]=String(state.cursor??'').split(':');
   if(at!==ino||!/^\d+$/.test(offset??'')||Number(size)-Number(offset)>EVENT_TAIL)state.cursor=`${ino}:${Math.max(0,Number(size)-EVENT_TAIL)}`;
  }
  for(let page=0;page<EVENT_PAGES;page++){
   const result=await this.native(runtime,'agent_events_poll',{cursor:state.cursor??'start:0'});
   if(!result||typeof result.cursor!=='string'||!Array.isArray(result.lines))return;
   const advanced=result.cursor!==state.cursor;
   state.cursor=result.cursor;foldEvents(state.agents,result.lines);
   if(!advanced||!result.lines.length)return;
  }
 }
 async observeArgv(workspace,state,sessions){
  const wanted=sessions.filter(s=>s.exitCode==null&&Number.isSafeInteger(s.pid)&&state.agents[s.id]&&!state.agents[s.id].ended&&CLIS[state.agents[s.id].agent]&&!state.agents[s.id].argv);
  if(!wanted.length||!this.host.docker)return;
  const result=await this.host.docker(['exec','-u','1000:1000',`canopy-ws-${workspace.id}`,'/bin/sh','-c',PROCESS_SCRIPT]);
  const processes=parseProcesses(result.stdout);
  for(const session of wanted){const argv=agentArgv(processes,session.pid,state.agents[session.id].agent);if(argv)state.agents[session.id].argv=argv;}
 }
 serviceReady(workspace,runtime){
  if(!this.harness||!runtime.harness)return Promise.resolve(true);
  return this.harness.attach(workspace,runtime).then(state=>state?.available===true).catch(()=>false);
 }
 /** Mint -> runner spawn -> bind: the order a desktop spawn takes through the gateway. */
 async spawn(workspace,runtime,payload){
  let minted=null;
  if(this.harness&&runtime.harness){
   const result=await this.harness.mint(workspace,runtime,payload);
   if(!result.harness)throw Error(result.state?.message??'The Canopy service minted no credential');
   minted=result.harness;
  }
  let session;
  try{
   session=await this.runner(runtime,'/sessions',{method:'POST',body:{...payload,...(minted?{harness:minted}:{})},timeoutMs:15000});
   if(!Number.isSafeInteger(session?.id)||session.id<1)throw Error('Invalid session startup result');
  }catch(error){if(minted)await this.harness.revoke(workspace.id,payload.requestId);throw error;}
  if(minted)await this.harness.bind(workspace.id,payload.requestId,session);
  return session;
 }
 async resume(workspace,runtime,state){
  const pending=state.pending;
  if(!await this.serviceReady(workspace,runtime)){
   if(this.now()-pending.detectedAt<this.serviceWaitMs)return;
   pending.serviceUnavailable=true;
  }
  const metadata=await this.native(runtime,'pty_metadata_get')??{};
  const sharedProjects=new Set((workspace.projectMounts??[]).map(p=>p.id));
  const sessions=await this.runner(runtime,'/sessions');
  const report={at:new Date(this.now()).toISOString(),resumed:[],interrupted:[]};
  for(const [key,live] of Object.entries(pending.live)){
   const id=Number(key),old=metadata[key]??{};
   const current=sessions.find(s=>s.id===id);
   // Still running, or finished with a real exit code: nothing was interrupted.
   if(current&&current.exitCode!==-1)continue;
   let plan=resumePlan({live,agent:pending.agents[key],metadata:old,sharedProjects});
   if(plan.resume&&pending.serviceUnavailable)plan={interrupted:'service-unavailable'};
   if(plan.resume){
    const requestId=`resume-${id}-${pending.epoch}`;
    try{
     const session=await this.spawn(workspace,runtime,{command:runnerCommand(plan.resume,requestId),kind:'terminal',requestId,projectId:old.projectId,agent:plan.resume.agent,name:typeof old.name==='string'?old.name:undefined,title:typeof old.title==='string'?old.title:undefined});
     await this.native(runtime,'pty_metadata_set',{id:session.id,value:{...old,cwd:plan.resume.cwd,command:plan.resume.command,requestId,run:false,resumedFrom:id}});
     await this.native(runtime,'pty_metadata_set',{id,value:{...old,resumedAs:session.id}});
     report.resumed.push({from:id,to:session.id,agent:plan.resume.agent});
     continue;
    }catch(error){this.log(`Agent resume failed for ${workspace.id} terminal ${id}: ${error.message}`);plan={interrupted:'resume-failed'};}
   }
   await this.native(runtime,'pty_metadata_set',{id,value:{...old,interrupted:{at:report.at,reason:plan.interrupted}}}).catch(()=>{});
   report.interrupted.push({id,reason:plan.interrupted});
  }
  state.pending=null;state.lastRecovery=report;
  this.log(`Workspace ${workspace.id} restarted: resumed ${report.resumed.length} agent(s), ${report.interrupted.length} terminal(s) interrupted`);
 }
 async observe(workspace,runtime){
  if(!this.eligible(workspace))return 'ineligible';
  const inspected=await this.host.inspectRuntime(workspace);
  if(!inspected?.State?.Running||inspected.State.Paused||inspected.State.Restarting)return 'stopped';
  const startedAt=inspected.State.StartedAt;
  if(typeof startedAt!=='string'||!startedAt)return 'unknown';
  const state=await this.load(workspace.id);
  let sessions;
  try{sessions=await this.runner(runtime,'/sessions');}catch{return 'unresponsive';}
  if(!Array.isArray(sessions))return 'unresponsive';
  // Events the hook wrote just before the restart name the conversation to reopen.
  await this.readEvents(runtime,state).catch(error=>this.log(`Agent events unavailable for ${workspace.id}: ${error.message}`));
  if(state.startedAt&&state.startedAt!==startedAt&&!state.pending){
   // The last observation before the restart is the record of what was running.
   state.pending={startedAt,epoch:Math.max(0,Math.floor(Date.parse(startedAt)/1000)||0),detectedAt:this.now(),live:state.live,agents:structuredClone(state.agents)};
   state.live={};
  }
  state.startedAt=startedAt;
  await this.save(state);
  let outcome='watching';
  if(state.pending){
   await this.resume(workspace,runtime,state);
   if(state.pending){await this.save(state);return 'waiting-for-service';}
   outcome='resumed';
   sessions=await this.runner(runtime,'/sessions');
  }
  await this.observeArgv(workspace,state,sessions).catch(()=>{});
  state.live=Object.fromEntries(sessions.filter(s=>s.exitCode==null&&Number.isSafeInteger(s.id)).slice(-MAX_LIVE).map(s=>[s.id,{kind:s.kind??'terminal',accountId:s.accountId??null}]));
  await this.describe(workspace,runtime,state).catch(error=>this.log(`Agent roster update failed for ${workspace.id}: ${error.message}`));
  await this.save(state);
  return outcome;
 }
 /** Tell the Canopy service which agent each live terminal runs and what it is
  *  called: a desktop terminal is minted as a shell before the agent starts. */
 async describe(workspace,runtime,state){
  if(!this.harness?.admin?.describeTerminal||!runtime.harness||!Object.keys(state.live).length)return;
  const metadata=await this.native(runtime,'pty_metadata_get')??{};
  const sent=state.described??{};
  for(const id of Object.keys(state.live)){
   const requestId=metadata[id]?.requestId;
   if(typeof requestId!=='string'||!/^[a-zA-Z0-9:-]{8,128}$/.test(requestId))continue;
   const next={...terminalDescription(state.agents[id],metadata[id]),activity:agentActivity(state.agents[id])},key=JSON.stringify([requestId,next]);
   if(sent[id]===key)continue;
   try{await this.harness.admin.describeTerminal(workspace.id,requestId,next);sent[id]=key;}
   catch(error){if(error.status===404||error.status===409)sent[id]=key;else throw error;}
  }
  for(const id of Object.keys(sent))if(!state.live[id])delete sent[id];
  state.described=sent;
 }
 async checkAll(){
  if(this.checking)return this.checking;
  this.checking=(async()=>{
   for(const {workspace,runtime} of [...this.host.runtimes.values()]){
    try{await this.observe(workspace,runtime);}catch(error){this.log(`Agent resume check failed for ${workspace?.id}: ${error.message}`);}
   }
  })();
  try{await this.checking;}finally{this.checking=undefined;}
 }
 start(){if(!this.timer){this.timer=setInterval(()=>void this.checkAll(),this.intervalMs);this.timer.unref?.();}}
 close(){clearInterval(this.timer);this.timer=undefined;}
}

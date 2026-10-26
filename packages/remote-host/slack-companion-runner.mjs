import {spawn as childSpawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {validId} from './policy.mjs';
// The companion's turns on the workspace VM, run the way the desktop runs them
// (src/companion.ts companionRunnerLaunch + src/structuredRunners.ts), inside
// the owner's RUNNING workspace container as the agent user:
//
//  - Claude (`structured`): one long-lived `claude -p --input-format
//    stream-json` process, one user line per turn, the `result` line ends it.
//  - Codex (`oneshot`): one `codex exec --json` per turn, resumed by the thread
//    id Codex reports on `thread.started`.
//
// Same read-only policy as the desktop: bypassPermissions with the built-in
// writers disallowed (Claude), `-s read-only` (Codex). Never starts or wakes a
// container, never runs as root.
export const BUILTIN_WRITERS=['Edit','Write','NotebookEdit','Bash','KillShell'];
export const COMPANION_CLIS=['claude','codex'];
export const WORKSPACE_ROOT='/workspace';
export const AGENT_HOME='/home/agent';
export const TURN_CEILING_MS=5*60_000;
const STDERR_KEEP=2000,LINE_MAX=8*1024*1024;
const CONVERSATION_GONE=/no rollout found|no conversation found|thread .{0,40}not found|session .{0,40}not found/i;
const ID_IN_USE=/already in use/i;
const message=error=>String(error?.message??error).slice(0,300);
// Killing the docker client alone can leave the CLI running in the container;
// closing its stdin is what ends a stream-json Claude.
const stop=child=>{try{child.stdin?.end();}catch{}child.kill('SIGKILL');};

// ---- launch arguments: a port of companionRunnerLaunch and the runners ----

export function companionLaunch({bin,sessionId,systemPrompt,roots=[WORKSPACE_ROOT],model='',cwd=WORKSPACE_ROOT}){
 return {bin,policy:{systemPromptAppend:systemPrompt,permissionMode:'bypassPermissions',disallowedTools:BUILTIN_WRITERS,model,sessionId,cwd,authority:'read-only'},additionalDirectories:roots};
}
const permissionArgs=p=>['--permission-mode',p.permissionMode||'manual',...(p.allowedTools?.length?['--allowedTools',...p.allowedTools]:[]),...(p.disallowedTools.length?['--disallowedTools',...p.disallowedTools]:[])];
const claudeArgs=(o,resume)=>['-p','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--verbose','--replay-user-messages',resume?'--resume':'--session-id',o.policy.sessionId,'--append-system-prompt',o.policy.systemPromptAppend,...(o.additionalDirectories??[]).flatMap(d=>['--add-dir',d]),...(o.policy.model?['--model',o.policy.model]:[]),...permissionArgs(o.policy)];
// Read-only authority only: the workspace-write config keys never apply here.
const codexArgs=(o,resume)=>resume
 ?['exec','resume',o.policy.sessionId,'--json','--skip-git-repo-check',...(o.policy.model?['-m',o.policy.model]:[]),'-c','sandbox_mode="read-only"']
 :['exec','--json','--skip-git-repo-check',...(o.policy.cwd?['-C',o.policy.cwd]:[]),...(o.additionalDirectories??[]).flatMap(d=>['--add-dir',d]),...(o.policy.model?['-m',o.policy.model]:[]),'-s','read-only'];
/** The argv after the binary, exactly as the desktop builds it for `cli`. */
export function launchArgs(cli,launch,{resume=false}={}){
 if(cli==='claude')return claudeArgs(launch,resume);
 if(cli==='codex')return codexArgs(launch,resume);
 throw Error(`${cli} has no verified companion runner`);
}

/** The process environment, as runner.mjs gives the owner's own sessions,
 *  plus the companion markers companionSession.ts sets. Answer-only: the VM
 *  has no write gate to put a question through. */
export function companionEnv(workspaceId){
 return {HOME:AGENT_HOME,USER:'agent',LANG:'C.UTF-8',NPM_CONFIG_PREFIX:`${AGENT_HOME}/.local`,CLAUDE_CONFIG_DIR:`${AGENT_HOME}/.claude`,CODEX_HOME:`${AGENT_HOME}/.codex`,
  CANOPY_WORKSPACE_ID:workspaceId,CANOPY_COMPANION:'1',CANOPY_COMPANION_AUTHORITY:'read',CANOPY_COMPANION_POLICY:'deny'};
}
export const containerName=workspace=>{if(!validId(workspace?.id))throw Error('Invalid workspace');return `canopy-ws-${workspace.id}`;};
/** `docker exec` as uid 1000 in the workspace root. The binary and its
 *  arguments ride as bash positionals, so nothing here is shell-interpreted. */
export function dockerExecArgs(container,{bin,args,env,cwd=WORKSPACE_ROOT,stdin=false}){
 return ['exec',...(stdin?['-i']:[]),'-u','1000:1000','-w',cwd,...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),container,
  '/bin/bash','-lc',`export PATH="${AGENT_HOME}/.local/bin:$PATH"; exec "$0" "$@"`,bin,...args];
}

export function companionBrief({name='Ash',roots=[WORKSPACE_ROOT]}={}){
 return [
  `# You are ${name}`,'',
  `You are ${name}, the user's personal specialist for Canopy. You are not a coding agent working a ticket in a checkout: you are the one assistant that sits above all of their projects.`,'',
  `Right now their desktop is offline, so you are running in their Canopy cloud workspace and answering them (or a teammate) in Slack. Their projects are here:`,
  ...roots.map(r=>`- \`${r}\``),'',
  '## How to work','',
  'You are in ANSWER-ONLY mode. Every tool that would change something is switched off for this session — you cannot start servers, create worktrees, edit files or run commands that write. Do not offer to; say what you would do and give the user the command, so they can run it themselves.','',
  '**You do not edit files.** `Edit`, `Write` and the shell are not in your hands. You read everything: `Read`, `Grep` and `Glob` reach every project. When the answer is a change to the code, say precisely what should change and where.','',
  '**Say which project.** Every path you mention names the project it belongs to.','',
  '**Never report an action you have not seen succeed.**','',
  '## How to answer','',
  'Your reply is posted to Slack as text. Two or three sentences, answer first, no preamble, no summing up. If you do not know, say so in one line and say what would settle it.',
 ].join('\n');
}

// ---- the process side ----

function lines(stream,onLine){
 let buffer='';
 stream.setEncoding('utf8');
 stream.on('data',chunk=>{buffer+=chunk;if(buffer.length>LINE_MAX)buffer=buffer.slice(-LINE_MAX);let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(line)onLine(line);}});
}
const parse=line=>{try{return JSON.parse(line);}catch{return null;}};

/** The companion's state that must outlive a host restart: Claude's session
 *  id (and whether it has run, which decides --session-id vs --resume) and
 *  Codex's thread id. Same rule as companionSessionId on the desktop. */
export class CompanionState{
 constructor(file){this.file=file;this.value=null;}
 async load(){
  if(this.value)return this.value;
  try{const v=JSON.parse(await readFile(this.file,'utf8'));this.value=v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
  catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;this.value={};}
  return this.value;
 }
 async save(){
  await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
  const temp=`${this.file}.${randomBytes(6).toString('hex')}`;
  try{await writeFile(temp,JSON.stringify(this.value),{mode:0o600,flag:'wx'});await rename(temp,this.file);}
  catch(error){await rm(temp,{force:true});throw error;}
 }
}

export class ContainerCompanionRunner{
 constructor({workspace,inspect,stateFile,cli=null,name,spawn=childSpawn,ceilingMs=TURN_CEILING_MS,log=text=>console.warn(text)}){
  if(!validId(workspace?.id)||typeof inspect!=='function'||!stateFile)throw Error('Companion runner needs a workspace, an inspector and a state file');
  if(cli!=null&&!COMPANION_CLIS.includes(cli))throw Error(`${cli} has no verified companion runner`);
  Object.assign(this,{workspace,inspect,cli,spawn,ceilingMs,log});
  this.state=new CompanionState(stateFile);this.systemPrompt=companionBrief({name});
  this.proc=null;this.chain=Promise.resolve();this.saves=Promise.resolve();this.closed=false;
 }
 /** Saves run one after another, so two never race on the file; never throws. */
 persist(){
  this.saves=this.saves.then(()=>this.state.save()).catch(error=>this.log(`Slack companion state save failed: ${message(error)}`));
  return this.saves;
 }
 container(){return containerName(this.workspace);}
 /** Running and unpaused, or the turn is refused. Never starts it. */
 async requireRunning(){
  const inspected=await this.inspect(this.workspace);
  if(inspected?.State?.Running!==true||inspected.State.Paused)throw Error('your workspace is not running');
 }
 exec(bin,args,{stdin=false}={}){
  return this.spawn('docker',dockerExecArgs(this.container(),{bin,args,env:companionEnv(this.workspace.id),stdin}),{stdio:[stdin?'pipe':'ignore','pipe','pipe']});
 }
 /** The owner's chosen CLI when configured, else the first one installed in
 *  the workspace (claude, then codex). */
 async chooseCli(){
  if(this.cli)return this.cli;
  for(const cli of COMPANION_CLIS){
   const found=await new Promise(resolve=>{const child=this.spawn('docker',['exec','-u','1000:1000',this.container(),'/bin/bash','-lc',`export PATH="${AGENT_HOME}/.local/bin:$PATH"; command -v "$0"`,cli],{stdio:['ignore','ignore','ignore']});child.on('error',()=>resolve(false));child.on('exit',code=>resolve(code===0));});
   if(found){this.cli=cli;return cli;}
  }
  throw Error('neither claude nor codex is installed in your workspace');
 }
 /** One turn, one at a time. Resolves {text}. */
 runTurn({prompt}){
  const run=this.chain.then(()=>this.turn(prompt));
  this.chain=run.catch(()=>{});
  return run;
 }
 async turn(prompt){
  if(this.closed)throw Error('the workspace companion stopped');
  await this.requireRunning();
  const cli=await this.chooseCli(),state=await this.state.load();
  return cli==='claude'?this.claudeTurn(prompt,state,true):this.codexTurn(prompt,state,true);
 }

 // Claude: one long-lived process.
 startClaude(state){
  const s=state.claude??={sessionId:randomUUID(),ran:false};
  const launch=companionLaunch({bin:'claude',sessionId:s.sessionId,systemPrompt:this.systemPrompt});
  const child=this.exec('claude',launchArgs('claude',launch,{resume:s.ran}),{stdin:true});
  const proc={child,resumed:s.ran,turn:null,stderr:'',exited:false};
  child.stderr.setEncoding('utf8');child.stderr.on('data',t=>{if(proc.stderr.length<STDERR_KEEP)proc.stderr+=t;});
  lines(child.stdout,line=>{
   const msg=parse(line);
   // Marked on init, as companionSession.ts marks it on `ready`: the session
   // exists from here, so the next launch must resume rather than re-create it.
   if(msg?.type==='system'&&msg.subtype==='init'&&!s.ran){s.ran=true;this.persist();}
   const turn=proc.turn;if(!msg||!turn)return;
   if(msg.type==='assistant')for(const b of msg.message?.content??[])if(b?.type==='text'&&b.text)turn.text+=b.text;
   if(msg.type==='result'){proc.turn=null;if(msg.is_error)turn.fail(Error(msg.result||'The agent ended the turn with an error.'));else turn.done(typeof msg.result==='string'&&msg.result.trim()?msg.result:turn.text);}
  });
  const gone=error=>{if(proc.exited)return;proc.exited=true;if(this.proc===proc)this.proc=null;const turn=proc.turn;proc.turn=null;turn?.fail(error??Error(proc.stderr.trim().slice(0,STDERR_KEEP)||'claude exited'));};
  child.on('error',gone);child.on('exit',()=>gone());
  child.stdin.on('error',()=>{});
  return this.proc=proc;
 }
 async claudeTurn(prompt,state,heal){
  const proc=this.proc??this.startClaude(state);
  try{
   const text=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{proc.turn=null;stop(proc.child);reject(Error('the companion did not finish within 5 minutes'));},this.ceilingMs);timer.unref?.();
    proc.turn={text:'',done:v=>{clearTimeout(timer);resolve(v);},fail:e=>{clearTimeout(timer);reject(e);}};
    proc.child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:prompt}]}})+'\n');
   });
   await this.saves;
   return {text};
  }catch(error){
   // The transcript behind the id is gone: forget it and meet again, once.
   const why=message(error)+proc.stderr;
   if(heal&&(proc.resumed?CONVERSATION_GONE.test(why):ID_IN_USE.test(why))){
    stop(proc.child);if(this.proc===proc)this.proc=null;
    state.claude={sessionId:randomUUID(),ran:false};await this.persist();
    return this.claudeTurn(prompt,state,false);
   }
   throw error;
  }
 }

 // Codex: one process per turn.
 async codexTurn(prompt,state,heal){
  const threadId=state.codex?.threadId??null;
  const launch=companionLaunch({bin:'codex',sessionId:threadId??'',systemPrompt:this.systemPrompt});
  // The brief rides on every turn: Codex has no system-prompt flag.
  const args=[...launchArgs('codex',launch,{resume:!!threadId}),`${this.systemPrompt}\n\n---\n\n${prompt}`];
  const child=this.exec('codex',args);
  const replies=[];let failed=null,completed=false,stderr='',minted=null;
  child.stderr.setEncoding('utf8');child.stderr.on('data',t=>{if(stderr.length<STDERR_KEEP)stderr+=t;});
  lines(child.stdout,line=>{
   const msg=parse(line);if(!msg)return;
   if(msg.type==='thread.started'&&typeof msg.thread_id==='string'&&msg.thread_id!==threadId)minted=msg.thread_id;
   else if(msg.type==='item.completed'&&msg.item?.type==='agent_message'&&msg.item.text)replies.push(msg.item.text);
   else if(msg.type==='turn.failed')failed=msg.error?.message||'The agent ended the turn with an error.';
   else if(msg.type==='turn.completed')completed=true;
  });
  await new Promise(resolve=>{
   const timer=setTimeout(()=>{failed??='the companion did not finish within 5 minutes';child.kill('SIGKILL');},this.ceilingMs);timer.unref?.();
   child.on('error',error=>{failed??=message(error);});
   child.on('close',()=>{clearTimeout(timer);resolve();});
  });
  if(minted){state.codex={threadId:minted};await this.persist();}
  if(failed||!completed){
   const reason=failed??(stderr.trim().slice(0,STDERR_KEEP)||'codex exited without starting the turn');
   if(heal&&threadId&&CONVERSATION_GONE.test(reason+stderr)){delete state.codex;await this.persist();return this.codexTurn(prompt,state,false);}
   throw Error(reason);
  }
  return {text:replies.join('\n\n')};
 }
 close(){
  this.closed=true;
  const proc=this.proc;this.proc=null;
  if(proc&&!proc.exited){proc.turn?.fail(Error('the workspace companion stopped'));proc.turn=null;stop(proc.child);}
  return this.saves;
 }
}

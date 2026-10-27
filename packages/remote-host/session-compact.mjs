// Compact a session that is not open in a terminal, inside the workspace
// where the session lives — the cloud half of src/contextCompaction.ts
// compactHeadless (which runs the desktop's CLI for local sessions).
//
// The argv is the one structuredRunners.ts `compactArgs` documents, verified
// against Claude Code 2.1.311 on 2026-10-27: `-p --resume <id>` with
// `/compact <instructions>` as the final value and stdin closed compacts the
// session (stream-json shows system/compact_boundary with pre/post tokens,
// then a result) and exits. Read-only authority, no MCP servers, and no
// CANOPY* variables, so hooks do not fire: it is not a Canopy agent turn.
// The session's account is honoured through its profile's environment.
import {spawn} from 'node:child_process';
import {realpath,stat} from 'node:fs/promises';

/** The compaction command per CLI, where verified (harness.ts mirrors it). */
export const COMPACT_COMMANDS={claude:'/compact'};
const DISALLOWED=['Edit','Write','NotebookEdit','Bash','KillShell'];
const TIMEOUT_MS=5*60*1000,MAX_INSTRUCTIONS=4000;

export function compactArgv(agent,sessionId,instructions){
 const cmd=COMPACT_COMMANDS[agent];if(!cmd)return null;
 const text=String(instructions??'').replace(/[\r\n]+/g,' ').trim();
 return ['-p','--output-format','stream-json','--verbose','--strict-mcp-config','--resume',sessionId,'--permission-mode','plan','--disallowedTools',...DISALLOWED,'--',text?`${cmd} ${text}`:cmd];
}

/** Fold the run's stdout into an answer. */
export function compactOutcome(lines){
 let compacted=null,result=null;const windows={};
 for(const line of lines){
  let v;try{v=JSON.parse(line);}catch{continue;}
  if(v?.type==='system'&&v.subtype==='compact_boundary'){const m=v.compact_metadata??{};compacted={preTokens:Number.isFinite(m.pre_tokens)?m.pre_tokens:null,postTokens:Number.isFinite(m.post_tokens)?m.post_tokens:null};}
  if(v?.type==='result'){result=v;for(const [model,use] of Object.entries(v.modelUsage??{}))if(Number.isFinite(use?.contextWindow)&&use.contextWindow>0)windows[model]=use.contextWindow;}
 }
 if(result&&(result.is_error||(result.subtype??'success')!=='success'))return {ok:false,message:typeof result.result==='string'&&result.result?result.result:'The compaction failed.',contextWindows:windows};
 if(!compacted)return {ok:false,message:result?'The CLI finished without compacting.':'The CLI exited before compacting.',contextWindows:windows};
 return {ok:true,...compacted,contextWindows:windows};
}

export function sessionCompactCommand({home,scoped,profileEnv,run=spawn}){
 return async function sessionCompact(args={}){
  const agent=String(args.agent??''),sessionId=String(args.sessionId??''),profile=typeof args.profile==='string'&&args.profile?args.profile:'default';
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))throw Error('Invalid session id');
  const instructions=String(args.instructions??'');
  if(instructions.length>MAX_INSTRUCTIONS||instructions.includes('\0'))throw Error('Invalid compaction instructions');
  const argv=compactArgv(agent,sessionId,instructions);
  if(!argv)return {ok:false,message:"This agent's CLI cannot compact a session headlessly."};
  let cwd;try{cwd=await realpath(await scoped(String(args.cwd??'')));if(!(await stat(cwd)).isDirectory())throw Error();}catch{return {ok:false,message:"The session's folder is not in this workspace."};}
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CANOPY')));
  for(const [k,v] of await profileEnv(agent,profile).catch(()=>[]))if(!k.startsWith('CANOPY'))env[k]=v;
  env.HOME=home;
  return await new Promise(resolve=>{
   const lines=[];let buffered='',done=false;
   const child=run(agent,argv,{cwd,env,stdio:['ignore','pipe','pipe'],detached:true});
   const finish=r=>{if(done)return;done=true;clearTimeout(timer);try{process.kill(-child.pid,'SIGKILL');}catch{}resolve(r);};
   const timer=setTimeout(()=>finish({ok:false,message:'The compaction took too long.'}),TIMEOUT_MS);
   child.stdout?.on('data',chunk=>{buffered+=chunk.toString('utf8');const parts=buffered.split('\n');buffered=parts.pop();for(const l of parts){lines.push(l);let v;try{v=JSON.parse(l);}catch{continue;}if(v?.type==='result')finish(compactOutcome(lines));}});
   child.stderr?.on('data',()=>{});
   child.once('error',e=>finish({ok:false,message:`could not start \`${agent}\`: ${e.message}`}));
   child.once('close',()=>{if(buffered)lines.push(buffered);finish(compactOutcome(lines));});
  });
 };
}

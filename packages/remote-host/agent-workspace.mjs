// An agent session's workspace and change journal, as git.rs's agent_workspace,
// agent_workspace_at and agent_edits report them. Hook data lives where
// canopy_hook writes it in the VM too: ~/.canopy/sessions/<id>.json (digest)
// and <id>.edits.jsonl (journal). A hookless session has neither, and gets the
// git-derived view with no invented agent state.
import path from 'node:path';
import {open,realpath,stat,constants} from 'node:fs/promises';
import {gitTools,isProtectedBranch} from './git-ops.mjs';
import {checkedRef} from './git-history.mjs';

export const AGENT_WORKSPACE_READ_ONLY=['agent_workspace','agent_workspace_at','agent_edits'];
const MAX_EDITS=400,JOURNAL_TAIL=16*1024*1024,FILE_MAX=4*1024*1024;

export const validSessionId=s=>typeof s==='string'&&!!s&&s.length<=256&&/^[A-Za-z0-9._-]+$/.test(s)&&!s.includes('..');
const u64=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const str=v=>typeof v==='string'?v:null;
// The last `limit` bytes of a regular file, never through a symlink.
async function readTail(file,limit){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await handle.stat();if(!info.isFile())throw Error('not a file');const length=Math.min(info.size,limit),buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,info.size-length);return {text:buffer.subarray(0,bytesRead).toString('utf8'),cut:info.size>limit};}
 finally{await handle.close();}
}
async function readDigest(home,id){
 if(!home)return null;
 try{const {text,cut}=await readTail(`${home}/.canopy/sessions/${id}.json`,1024*1024);if(cut)return null;const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}
}
const digestFields=d=>({state:str(d?.state),state_via:str(d?.state_via),updated:u64(d?.updated),touched:Array.isArray(d?.files)?d.files.filter(f=>typeof f==='string'):[],branch:str(d?.branch),active_secs:u64(d?.active_secs),run_secs:u64(d?.run_secs)});

// The git half shared by both entry points: resolve the cwd to a workdir this
// repo owns (its own worktree list is the authority), then branch, counts and
// the base..branch commit list. A cwd that is gone or elsewhere degrades the
// view (workdir null) rather than failing it.
async function workspaceJoin(ctx,t,top,base,{session_id,agent,cwd,digest}){
 let workdir=null,cwdMissing=false;
 if(cwd!=null){
  let dir=null;
  try{dir=await ctx.scoped(cwd);if(!(await stat(dir)).isDirectory()){dir=null;cwdMissing=true;}}
  catch(error){if(error.code==='ENOENT')cwdMissing=true;}
  const wtTop=dir&&await t.opt(dir,['rev-parse','--show-toplevel']);
  if(wtTop){
   const want=await t.canon(wtTop);let owned=want===await t.canon(top);
   if(!owned)for(const w of await t.scanWorktrees(top))if(await t.canon(w.path)===want){owned=true;break;}
   if(owned)workdir=wtTop;
  }
 }
 const isolated=!!workdir&&await t.canon(workdir)!==await t.canon(top);
 let branch=null,detached=false;
 if(workdir)({branch,detached}=await t.headBranch(workdir));
 if(branch==null&&!detached)branch=digest.branch;
 const onBase=!detached&&!!branch&&isProtectedBranch(branch,base);
 let dirty=0;if(workdir){const s=await t.opt(workdir,['status','--porcelain']);if(s)dirty=s.split('\n').filter(l=>l.trim()).length;}
 let ahead=0,behind=0,merged=false,unpushed=null,commits=[];
 if(!detached&&!onBase&&branch){
  let b=null;try{b=checkedRef(branch);}catch{}
  if(b){
   const counts=await t.opt(top,['rev-list','--left-right','--count',`${base}...${b}`]);
   if(counts){const [l,r]=counts.split(/\s+/).map(Number);behind=Number.isInteger(l)?l:0;ahead=Number.isInteger(r)?r:0;}
   merged=await t.ok(top,['merge-base','--is-ancestor',b,base]);
   // Fails when there is no upstream: never pushed, as opposed to 0 to push.
   const n=Number(await t.opt(top,['rev-list','--count',`${b}@{upstream}..${b}`])??NaN);unpushed=Number.isInteger(n)?n:null;
   commits=await t.branchCommitsOf(top,base,b);
  }
 }
 return {session_id,agent,state:digest.state,state_via:digest.state_via,cwd,updated:digest.updated,active_secs:digest.active_secs,run_secs:digest.run_secs,touched:digest.touched,branch,detached,base,on_base:onBase,workdir,isolated,cwd_missing:cwdMissing,dirty,ahead,behind,unpushed,merged,commits};
}

export async function agentWorkspace(args,ctx){
 const id=args.sessionId;
 if(!validSessionId(id))throw Error('invalid session id');
 const raw=await readDigest(ctx.home,id);
 if(!raw)throw Error('no digest for this session');
 const t=gitTools(ctx),top=await t.repoPath(args.repo),base=await t.defaultBase(top);
 return workspaceJoin(ctx,t,top,base,{session_id:id,agent:str(raw.agent),cwd:str(raw.cwd),digest:digestFields(raw)});
}

// Keyed on a live terminal's cwd, so a hookless CLI gets the same view; the
// session id is optional enrichment and identity comes from the caller.
export async function agentWorkspaceAt(args,ctx){
 const t=gitTools(ctx),top=await t.repoPath(args.repo),base=await t.defaultBase(top);
 const cwd=args.cwd??args.repo;if(typeof cwd!=='string')throw Error('Invalid workspace path');
 const id=validSessionId(args.sessionId)?args.sessionId:null;
 const raw=id?await readDigest(ctx.home,id):null;
 return workspaceJoin(ctx,t,top,base,{session_id:id??'',agent:str(args.agent),cwd,digest:digestFields(raw)});
}

// What this agent changed, newest last. The present-check reads files only
// inside the opened repo, so a tampered journal can't become an arbitrary read.
export async function agentEdits(args,ctx){
 const id=args.sessionId;
 if(!validSessionId(id))throw Error('invalid session id');
 let text;
 try{({text}=await readTail(`${ctx.home}/.canopy/sessions/${id}.edits.jsonl`,JOURNAL_TAIL));}catch{return [];}
 let top=null;if(typeof args.repo==='string'&&args.repo){try{top=await realpath(await gitTools(ctx).repoPath(args.repo));}catch{}}
 const cache=new Map(),out=[];
 for(const line of text.split('\n').filter(l=>l.trim()).slice(-MAX_EDITS)){
  let v;try{v=JSON.parse(line);}catch{continue;}
  const abs=str(v?.path);if(!abs)continue;
  const next=str(v.new),old=str(v.old);
  let real=null;if(top&&path.isAbsolute(abs)){try{real=await realpath(abs);}catch{}}
  const under=!!real&&real.startsWith(top+'/');
  let present=false;
  if(under&&next!=null){
   if(!cache.has(abs)){let content=null;try{const r=await readTail(real,FILE_MAX);content=r.cut?null:r.text;}catch{}cache.set(abs,content);}
   const content=cache.get(abs),needle=next.replace(/\n…\(truncated\)$/,'');
   present=content!=null&&!!needle&&content.includes(needle);
  }
  out.push({ts:u64(v.ts)??0,path:under?real.slice(top.length+1):abs,tool:str(v.tool)??'',old,new:next,present});
 }
 return out;
}

export function agentWorkspaceCommands(ctx){
 return {agent_workspace:args=>agentWorkspace(args,ctx),agent_workspace_at:args=>agentWorkspaceAt(args,ctx),agent_edits:args=>agentEdits(args,ctx)};
}

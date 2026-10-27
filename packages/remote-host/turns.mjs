// Turn snapshots ("instant rollback") for the Linux workspace, mirroring the
// desktop's src-tauri/src/turn_rollback.rs (turn_snapshot, turn_list,
// turn_preview, turn_restore, turn_native_checkpoint) ref for ref, so a repo
// snapshotted in the VM reads the same from either side:
//   refs/canopy/turns/<session>/<n>       turn n, as it started
//   refs/canopy/turn-ends/<session>/<n>   turn n, as it ended
//   refs/canopy/restores/<session>/<ms>   the tree just before a restore (redo)
// The whole working tree (tracked + untracked, not ignored) is written through
// a TEMPORARY index (GIT_INDEX_FILE) seeded from a copy of the user's index, so
// the user's index, HEAD, branches and files are never touched by a snapshot.
// Per-session inputs come from ~/.canopy/sessions (digests and edit journals
// the canopy-hook binary writes in the VM exactly as on the desktop) and native
// checkpoint ids live in ~/.canopy/turns/<session>.native.jsonl.
import {spawn} from 'node:child_process';
import {copyFile,readFile,readdir,realpath,rm,lstat,rmdir,unlink,mkdir,appendFile,symlink,chmod,rename,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {safeGitRead} from './git-read.mjs';

export const MAX_TURNS=200,MAX_AGE_SECS=30*24*60*60,MAX_RESTORES=50;
const TURNS='refs/canopy/turns',ENDS='refs/canopy/turn-ends',RESTORES='refs/canopy/restores';
const PEER_ACTIVE_SECS=2*60*60,PATCH_MAX=1024*1024,STREAM_MAX=8*1024*1024;
// Identity so commit-tree never fails on an unconfigured VM; no signing, no
// fsmonitor or split index (the temp index must not spill into .git), and no
// hooks (update-ref would otherwise run reference-transaction).
const CONFIG=['-c','user.name=Canopy','-c','user.email=canopy@localhost','-c','commit.gpgSign=false','-c','core.fsmonitor=false','-c','core.splitIndex=false','-c','core.hooksPath=/dev/null'];
const SCRUB=['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_COMMON_DIR','GIT_PREFIX'];
// Agent CLIs whose native rewind we know how to drive (harness.ts supportsTurnRollback).
const NATIVE_BINS=new Set(['claude']);

const nowMs=()=>Date.now();
export const validSession=id=>typeof id==='string'&&id.length>0&&id.length<=128&&/^[A-Za-z0-9_-]+$/.test(id);
const validUuid=id=>typeof id==='string'&&id.length>0&&id.length<=64&&/^[0-9A-Fa-f-]+$/.test(id);
const canon=async p=>{try{return await realpath(p);}catch{return p;}};
const under=(p,root)=>p===root||p.startsWith(root+'/');
const refN=(name,prefix)=>name.startsWith(prefix)&&/^\d+$/.test(name.slice(prefix.length))?Number(name.slice(prefix.length)):null;

// One snapshot or restore at a time, process-wide (keeps a session's start and
// end in order); the same hook line delivered to two windows collapses into one.
let LOCK=Promise.resolve();
const locked=fn=>{const next=LOCK.then(fn,fn);LOCK=next.catch(()=>{});return next;};
const RECENT=new Map();
/** Test seam: clear the duplicate-delivery window for one repo. */
export const forgetDeliveries=root=>{for(const key of RECENT.keys())if(key.startsWith(root+'\0'))RECENT.delete(key);};

/** Pair each turn with the checkpoint uuid recorded closest to its start,
 *  order-preserving: a uuid is used at most once, and only within windowMs. */
export function pairNative(turnStarts,uuids,windowMs){
 const sorted=[...uuids].sort((a,b)=>a.ts_ms-b.ts_ms),out=new Map();let next=0;
 for(const [n,ts] of turnStarts){
  let best=null;
  for(let i=next;i<sorted.length;i++){const d=Math.abs(sorted[i].ts_ms-ts);if(d<=windowMs&&(!best||d<best[1]))best=[i,d];if(sorted[i].ts_ms>ts+windowMs)break;}
  if(best){out.set(n,sorted[best[0]].uuid);next=best[0]+1;}
 }
 return out;
}
export const parseScope=s=>s==='session'?'session':s==='all'?'all':'auto';

export function turnsCommands(ctx){
 const env=extra=>{const e={...process.env,HOME:ctx.home,GIT_TERMINAL_PROMPT:'0',...extra};for(const k of SCRUB)if(!(k in(extra??{})))delete e[k];return e;};
 // Plain git for the writing plumbing (filters must run for add/cat-file, as on
 // the desktop); optional stdin; bounded output.
 const git=(root,argv,{extra,input,timeout=30000,maxBuffer=STREAM_MAX}={})=>{
  const p=ctx.execute('git',[...CONFIG,...argv],{cwd:root,timeout,maxBuffer,env:env(extra)});
  if(p.child?.stdin){p.child.stdin.on('error',()=>{});p.child.stdin.end(input??'');}
  return p.then(r=>String(r.stdout).trim(),e=>{throw Error(String(e.stderr||e.message||'git failed').trim().slice(0,4096));});
 };
 // Reads go through the host's hardened inspection.
 const read=async(root,argv,{maxBuffer=STREAM_MAX,partial=false}={})=>{
  try{const {stdout}=await safeGitRead(ctx.execute,argv,{allowedRoot:ctx.root,cwd:root,timeout:30000,maxBuffer,env:env()});return partial?{stdout,truncated:false}:stdout;}
  catch(e){if(partial&&e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'&&typeof e.stdout==='string')return {stdout:e.stdout,truncated:true};throw Error(String(e.stderr||e.message||'git failed').trim().slice(0,4096));}
 };
 const toplevel=async dir=>{try{return (await read(dir,['rev-parse','--show-toplevel'])).trim()||null;}catch{return null;}};
 const headCommit=async root=>{try{return (await read(root,['rev-parse','--verify','-q','HEAD^{commit}'])).trim()||null;}catch{return null;}};
 const sessionsDir=()=>path.join(ctx.home,'.canopy','sessions');
 const nativePath=s=>path.join(ctx.home,'.canopy','turns',`${s}.native.jsonl`);

 async function writeWorktreeTree(root){
  const tmp=path.join(tmpdir(),`canopy-turn-index-${process.pid}-${nowMs()}-${Math.random().toString(36).slice(2)}`);
  try{
   let userIndex=(await read(root,['rev-parse','--git-path','index'])).trim();
   if(!path.isAbsolute(userIndex))userIndex=path.join(root,userIndex);
   let seeded=false;
   try{if((await lstat(userIndex)).isFile()){await copyFile(userIndex,tmp);seeded=true;}}catch{}
   if(!seeded){const head=await headCommit(root);if(head)await git(root,['read-tree',head],{extra:{GIT_INDEX_FILE:tmp}});}
   await git(root,['add','-A','--',':/'],{extra:{GIT_INDEX_FILE:tmp},timeout:300000});
   return await git(root,['write-tree'],{extra:{GIT_INDEX_FILE:tmp}});
  }finally{await rm(tmp,{force:true});await rm(tmp+'.lock',{force:true});}
 }
 async function commitTree(root,tree,message){
  const head=await headCommit(root);
  return git(root,['commit-tree',tree,'--no-gpg-sign',...(head?['-p',head]:[]),'-F','-'],{input:message});
 }
 const createRef=(root,name,commit)=>git(root,['update-ref','--no-deref',name,commit,'']);

 async function listRefs(root,prefixes){
  const out=await read(root,['for-each-ref','--format=%(refname)%1f%(objectname)%1f%(tree)%1f%(committerdate:unix)%1f%(contents:body)%1e',...prefixes]);
  const refs=[];
  for(let rec of out.split('\x1e')){
   rec=rec.replace(/^\n+/,'');if(!rec.trim())continue;
   const f=rec.split('\x1f');if(f.length<5)continue;
   const body=f.slice(4).join('\x1f');let meta=null;
   const line=body.split('\n').find(l=>l.trimStart().startsWith('{'));
   if(line)try{const m=JSON.parse(line.trim());if(m&&typeof m.kind==='string'&&typeof m.session==='string'&&Number.isFinite(m.ts_ms))meta=m;}catch{}
   refs.push({refname:f[0],commit:f[1],tree:f[2],time:Number(f[3].trim())||0,meta});
  }
  return refs;
 }

 async function journalEditBetween(session,from,to){
  let raw;try{raw=await readFile(path.join(sessionsDir(),`${session}.edits.jsonl`),'utf8');}catch{return false;}
  return raw.split('\n').filter(Boolean).reverse().slice(0,400).some(l=>{try{const ts=JSON.parse(l).ts;return Number.isInteger(ts)&&ts>=0&&ts>=from&&ts<=to;}catch{return false;}});
 }
 // `p` relative to root lexically (the file may be gone), via the canonical root too.
 async function relToRoot(p,root,canonRoot){
  let rel=null;
  for(const r of [root,canonRoot])if(p.startsWith(r+'/')){rel=p.slice(r.length+1);break;}
  if(rel===null){try{const parent=await realpath(path.dirname(p));if(!under(parent,canonRoot))return null;rel=path.join(path.relative(canonRoot,parent),path.basename(p));}catch{return null;}}
  rel=rel.replace(/\\/g,'/').replace(/\/+$/,'');
  if(!rel||rel.split('/').includes('..'))return null;
  return rel;
 }
 async function sessionPaths(session,root){
  const canonRoot=await canon(root),out=new Set(),dir=sessionsDir();
  try{for(const l of (await readFile(path.join(dir,`${session}.edits.jsonl`),'utf8')).split('\n')){let v;try{v=JSON.parse(l);}catch{continue;}if(typeof v?.path!=='string')continue;const abs=path.isAbsolute(v.path)?v.path:root+'/'+v.path;const r=await relToRoot(abs,root,canonRoot);if(r)out.add(r);}}catch{}
  // The digest's files list survives the journal's size cap.
  try{const d=JSON.parse(await readFile(path.join(dir,`${session}.json`),'utf8'));const cwd=typeof d.cwd==='string'?d.cwd:'';for(const f of Array.isArray(d.files)?d.files:[]){if(typeof f!=='string')continue;const abs=path.isAbsolute(f)?f:cwd+'/'+f;const r=await relToRoot(abs,root,canonRoot);if(r)out.add(r);}}catch{}
  return out;
 }
 /** Other live sessions in the same checkout (same work-tree root). */
 async function otherActiveSessions(session,root,nowSecs){
  const canonRoot=await canon(root),tops=new Map(),out=[];
  let entries;try{entries=await readdir(sessionsDir(),{withFileTypes:true});}catch{return out;}
  for(const e of entries){
   if(!e.name.endsWith('.json'))continue;const sid=e.name.slice(0,-5);
   if(sid===session||sid.endsWith('.edits')||!e.isFile())continue;
   let d;try{d=JSON.parse(await readFile(path.join(sessionsDir(),e.name),'utf8'));}catch{continue;}
   if(!d||typeof d!=='object'||d.state==='ended'||d.micro===true)continue;
   const updated=Number.isInteger(d.updated)&&d.updated>=0?d.updated:0;
   if(Math.max(0,nowSecs-updated)>PEER_ACTIVE_SECS)continue;
   const cwd=typeof d.cwd==='string'?d.cwd:'';if(!cwd)continue;
   if(!tops.has(cwd)){
    // A cwd's work-tree root is one of its ancestors, so only a cwd inside this
    // root (and inside the workspace) can share it; that skips git for the rest.
    let top=null;const c=await canon(cwd);
    if(under(c,canonRoot)){try{top=await toplevel(await ctx.scoped(cwd));}catch{}}
    tops.set(cwd,top);
   }
   const top=tops.get(cwd);
   if(top&&await canon(top)===canonRoot)out.push(sid);
  }
  return out.sort();
 }

 async function prune(root,session,nowSecs){
  const all=await listRefs(root,['refs/canopy/']);
  const doomed=new Set(all.filter(r=>Math.max(0,nowSecs-r.time)>MAX_AGE_SECS).map(r=>r.refname));
  const sp=`${TURNS}/${session}/`,ep=`${ENDS}/${session}/`,rp=`${RESTORES}/${session}/`;
  const turns=[...new Set(all.map(r=>refN(r.refname,sp)??refN(r.refname,ep)).filter(n=>n!==null))].sort((a,b)=>a-b);
  if(turns.length>MAX_TURNS)for(const n of turns.slice(0,turns.length-MAX_TURNS)){doomed.add(sp+n);doomed.add(ep+n);}
  const restores=all.map(r=>refN(r.refname,rp)).filter(n=>n!==null).sort((a,b)=>a-b);
  if(restores.length>MAX_RESTORES)for(const ms of restores.slice(0,restores.length-MAX_RESTORES))doomed.add(rp+ms);
  const existing=new Set(all.map(r=>r.refname));
  const gone=[...doomed].filter(r=>existing.has(r)).sort();
  if(gone.length)await git(root,['update-ref','--stdin'],{input:gone.map(r=>`delete ${r}\n`).join('')});
  return gone;
 }

 const skipped=note=>({taken:false,ref:null,n:null,late:false,note});
 async function snapshot(root,session,kind,prompt,observedMs){
  if(!validSession(session))throw Error('invalid session id');
  if(kind!=='start'&&kind!=='end')throw Error(`unknown snapshot kind ${kind}`);
  return locked(async()=>{
   const key=[root,session,kind].join('\0'),seen=RECENT.get(key);
   if(seen!==undefined&&nowMs()-seen<1500)return skipped('duplicate delivery');
   RECENT.set(key,nowMs());
   if(RECENT.size>1024)RECENT.delete(RECENT.keys().next().value);
   const sp=`${TURNS}/${session}/`,ep=`${ENDS}/${session}/`;
   const max=list=>list.length?Math.max(...list):null;
   const maxStart=max((await listRefs(root,[sp])).map(r=>refN(r.refname,sp)).filter(n=>n!==null));
   const maxEnd=max((await listRefs(root,[ep])).map(r=>refN(r.refname,ep)).filter(n=>n!==null));
   const latest=maxStart===null?maxEnd:maxEnd===null?maxStart:Math.max(maxStart,maxEnd);
   // A Stop closes the newest turn if still open; a Stop with no open turn
   // becomes an end-only turn of its own, so "Back to here" still works.
   const n=kind==='end'&&maxStart!==null&&(maxEnd===null||maxEnd<maxStart)?maxStart:latest===null?1:latest+1;
   const tree=await writeWorktreeTree(root),ts_ms=nowMs();
   const late=kind==='start'&&await journalEditBetween(session,Math.max(0,Math.floor(observedMs/1000)-1),Math.floor(ts_ms/1000));
   const flat=typeof prompt==='string'?[...prompt.trim().split(/\s+/).filter(Boolean).join(' ')].slice(0,200).join(''):null;
   const meta={v:1,kind,session,n,ts_ms,observed_ms:observedMs,prompt:flat,late,root,target:null};
   const commit=await commitTree(root,tree,`canopy turn ${n} ${kind}\n\n${JSON.stringify(meta)}\n`);
   const ref=`${kind==='start'?TURNS:ENDS}/${session}/${n}`;
   await createRef(root,ref,commit);
   await prune(root,session,Math.floor(ts_ms/1000)).catch(()=>{});
   return {taken:true,ref,n,late,note:null};
  });
 }

 async function readNative(session){
  try{return (await readFile(nativePath(session),'utf8')).split('\n').flatMap(l=>{try{const v=JSON.parse(l);return typeof v?.uuid==='string'&&Number.isFinite(v.ts_ms)?[{uuid:v.uuid,ts_ms:v.ts_ms}]:[];}catch{return [];}});}catch{return [];}
 }
 async function list(root,session,nowSecs){
  if(!validSession(session))throw Error('invalid session id');
  const sp=`${TURNS}/${session}/`,ep=`${ENDS}/${session}/`,rp=`${RESTORES}/${session}/`;
  const refs=await listRefs(root,[sp,ep,rp]),turns=new Map(),restores=[];
  const snap=r=>({ref:r.refname,commit:r.commit,tree:r.tree,ts_ms:r.meta?r.meta.ts_ms:r.time*1000});
  const turn=n=>{if(!turns.has(n))turns.set(n,{n,start:null,end:null,prompt:null,late:false,native_uuid:null});return turns.get(n);};
  for(const r of refs){
   let n;
   if((n=refN(r.refname,sp))!==null){const t=turn(n);t.start=snap(r);if(r.meta){t.prompt=r.meta.prompt??null;t.late=r.meta.late===true;}}
   else if((n=refN(r.refname,ep))!==null)turn(n).end=snap(r);
   else if(refN(r.refname,rp)!==null)restores.push({ref:r.refname,ts_ms:r.meta?r.meta.ts_ms:r.time*1000,target:r.meta?.target??null});
  }
  const ordered=[...turns.values()].sort((a,b)=>a.n-b.n);
  // Pair on when the prompt was observed: the snapshot can finish seconds later.
  const starts=ordered.filter(t=>t.start).map(t=>{const m=refs.find(r=>r.refname===t.start.ref)?.meta;return [t.n,Number.isFinite(m?.observed_ms)?m.observed_ms:t.start.ts_ms];});
  for(const [n,uuid] of pairNative(starts,await readNative(session),60000))turns.get(n).native_uuid=uuid;
  restores.sort((a,b)=>a.ts_ms-b.ts_ms);
  const peers=await otherActiveSessions(session,root,nowSecs);
  return {git:true,root,shared:peers.length>0,peers,turns:ordered,restores};
 }

 async function resolveTarget(root,session,target){
  if(!validSession(session))throw Error('invalid session id');
  const ok=typeof target==='string'&&[TURNS,ENDS,RESTORES].some(p=>refN(target,`${p}/${session}/`)!==null);
  if(!ok)throw Error('not a snapshot of this session');
  const r=(await listRefs(root,[target])).find(r=>r.refname===target);
  if(!r)throw Error('that snapshot no longer exists (pruned?)');
  if(r.meta&&typeof r.meta.root==='string'&&r.meta.root&&await canon(r.meta.root)!==await canon(root))throw Error(`that snapshot was taken in ${r.meta.root}, not this checkout`);
  return r.tree;
 }
 async function diffTrees(root,from,to){
  const parts=(await git(root,['diff-tree','-r','-z','--no-renames','--raw',from,to])).split('\0').filter(Boolean),changes=[];
  for(let i=0;i+1<parts.length;i+=2){
   const f=parts[i].replace(/^:/,'').split(' '),p=parts[i+1];if(f.length<5)continue;
   const [oldMode,newMode,,newSha,st]=f;
   // Gitlinks would mean moving another repository's HEAD. Out of scope.
   if(oldMode==='160000'||newMode==='160000')continue;
   changes.push({path:p,status:st[0]==='A'?'add':st[0]==='D'?'delete':'modify',newMode,newSha});
  }
  return changes;
 }
 async function planAgainst(root,session,currentTree,targetTree,scope,nowSecs){
  const shared=(await otherActiveSessions(session,root,nowSecs)).length>0;
  const scoped=scope==='all'?false:scope==='session'?true:shared;
  const set=scoped?await sessionPaths(session,root):null;
  const all=await diffTrees(root,currentTree,targetTree);
  const changes=set?all.filter(c=>set.has(c.path)):all,excluded=set?all.filter(c=>!set.has(c.path)).map(c=>c.path):[];
  return {changes,excluded,scoped,shared,currentTree,targetTree};
 }
 const publicChanges=changes=>changes.map(({path,status})=>({path,status}));

 async function preview(root,session,target,scope,nowSecs){
  const targetTree=await resolveTarget(root,session,target);
  const plan=await planAgainst(root,session,await writeWorktreeTree(root),targetTree,scope,nowSecs);
  const raw=await read(root,['diff','--no-color','--no-ext-diff','--no-textconv','--no-renames',plan.currentTree,plan.targetTree],{partial:true});
  let truncated=raw.truncated,patch='',size=0;
  const wanted=plan.changes.map(c=>c.path);
  // Section on line starts only, so content mentioning "diff --git" can't split a file.
  for(const section of ('\n'+raw.stdout).split('\ndiff --git ').filter(Boolean)){
   const first=section.split('\n')[0];
   if(!wanted.some(p=>first===`a/${p} b/${p}`||first.endsWith(` b/${p}`)))continue;
   const bytes=Buffer.byteLength(section);
   if(size+bytes>PATCH_MAX){truncated=true;break;}
   patch+='diff --git '+section+'\n';size+=bytes+12;
  }
  return {changes:publicChanges(plan.changes),excluded:plan.excluded,scoped:plan.scoped,shared:plan.shared,patch,truncated};
 }

 // Claude's own file rewind (`claude -p --resume <id> --rewind-files <uuid>` with
 // SDK file checkpointing on). Bounded and never fatal: the snapshot pass covers it.
 async function nativeRewind(root,bin,session,uuid){
  if(!validUuid(uuid)||!validSession(session))return {attempted:false,ok:false,message:'invalid checkpoint id'};
  if(typeof bin!=='string'||!NATIVE_BINS.has(bin))return {attempted:false,ok:false,message:`unsupported agent CLI ${String(bin).slice(0,64)}`};
  const e={...process.env,HOME:ctx.home,CLAUDE_CONFIG_DIR:ctx.home+'/.claude',CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING:'true'};delete e.CANOPY;
  const text=(out,err)=>`${String(out??'').trim()} ${String(err??'').trim()}`.trim().slice(0,400);
  try{const p=ctx.execute(bin,['-p','--resume',session,'--rewind-files',uuid,'--permission-mode','dontAsk'],{cwd:root,timeout:90000,maxBuffer:1024*1024,env:e});p.child?.stdin?.end();const r=await p;return {attempted:true,ok:true,message:text(r.stdout,r.stderr)};}
  catch(err){
   if(err.killed||err.signal==='SIGTERM')return {attempted:true,ok:false,message:'native rewind timed out'};
   if(typeof err.code==='string'&&err.code!=='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return {attempted:true,ok:false,message:`could not start ${bin}: ${err.message}`};
   return {attempted:true,ok:false,message:text(err.stdout,err.stderr)};
  }
 }

 // Stream a blob (through smudge filters, as checkout would) into a file.
 const catFileTo=(root,rel,sha,file)=>new Promise(async(resolve,reject)=>{
  let handle;try{handle=await open(file,'w',0o644);}catch(e){return reject(e);}
  const child=spawn('git',[...CONFIG,'cat-file','--filters',`--path=${rel}`,sha],{cwd:root,env:env(),stdio:['ignore',handle.fd,'ignore']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),300000);
  const done=async ok=>{clearTimeout(timer);await handle.close().catch(()=>{});ok?resolve():reject(Error(`could not read ${rel} from the snapshot`));};
  child.on('error',()=>done(false));child.on('close',code=>done(code===0));
 });
 async function writeBlob(root,canonRoot,rel,sha,mode){
  if(rel.split('/').some(c=>c===''||c==='..')||path.isAbsolute(rel))throw Error(`refusing path ${rel}`);
  const dest=path.join(root,rel),parent=path.dirname(dest);
  await mkdir(parent,{recursive:true});
  // Never write through a symlinked directory that leads out of the repo.
  if(!under(await realpath(parent),canonRoot))throw Error(`${rel} resolves outside the repository`);
  const st=await lstat(dest).catch(()=>null);
  if(st?.isDirectory())await rmdir(dest).catch(()=>{throw Error(`${rel} is a non-empty directory now`);});
  if(mode==='120000'){
   const target=await ctx.execute('git',[...CONFIG,'cat-file','blob',sha],{cwd:root,timeout:30000,maxBuffer:1024*1024,encoding:'buffer',env:env()}).then(r=>r.stdout);
   await unlink(dest).catch(()=>{});await symlink(target,dest);return;
  }
  const tmp=path.join(parent,`.${path.basename(dest)}.canopy-restore-${process.pid}`);
  try{await catFileTo(root,rel,sha,tmp);}catch(e){await rm(tmp,{force:true});throw e;}
  await chmod(tmp,mode==='100755'?0o755:0o644).catch(()=>{});
  if(st?.isSymbolicLink())await unlink(dest).catch(()=>{});
  try{await rename(tmp,dest);}catch(e){await rm(tmp,{force:true});throw e;}
 }
 async function deletePath(root,rel){
  if(rel.split('/').some(c=>c===''||c==='..'))throw Error(`refusing path ${rel}`);
  const dest=path.join(root,rel);
  try{await unlink(dest);}catch(e){if(e.code!=='ENOENT')throw e;}
  // Tidy directories this left empty, never above the root.
  for(let d=path.dirname(dest);d!==root&&d.startsWith(root+'/');d=path.dirname(d)){try{await rmdir(d);}catch{break;}}
 }
 async function apply(root,plan){
  const canonRoot=await canon(root),written=[],deleted=[],failed=[];
  // Deletions first: a file replacing a directory needs the directory emptied.
  for(const c of plan.changes.filter(c=>c.status==='delete')){try{await deletePath(root,c.path);deleted.push(c.path);}catch(e){failed.push(`${c.path}: ${e.message}`);}}
  for(const c of plan.changes.filter(c=>c.status!=='delete')){try{await writeBlob(root,canonRoot,c.path,c.newSha,c.newMode);written.push(c.path);}catch(e){failed.push(`${c.path}: ${e.message}`);}}
  return {written,deleted,failed};
 }
 async function restore(root,session,target,scope,native,nowSecs){
  const targetTree=await resolveTarget(root,session,target);
  return locked(async()=>{
   const before=await writeWorktreeTree(root),ts_ms=nowMs();
   const meta={v:1,kind:'restore-point',session,n:null,ts_ms,observed_ms:null,prompt:null,late:false,root,target};
   const commit=await commitTree(root,before,`canopy restore point\n\n${JSON.stringify(meta)}\n`);
   let redo_ref=`${RESTORES}/${session}/${ts_ms}`;
   try{await createRef(root,redo_ref,commit);}catch{redo_ref=`${RESTORES}/${session}/${ts_ms+1}`;await createRef(root,redo_ref,commit);}
   const nativeOut=native?await nativeRewind(root,native.bin,session,native.uuid):{attempted:false,ok:false,message:''};
   const current=nativeOut.attempted?await writeWorktreeTree(root):before;
   const plan=await planAgainst(root,session,current,targetTree,scope,nowSecs);
   const {written,deleted,failed}=await apply(root,plan);
   await prune(root,session,nowSecs).catch(()=>{});
   return {written,deleted,excluded:plan.excluded,failed,redo_ref,native:nativeOut};
  });
 }

 async function recordNative(session,uuid,ts_ms){
  if(!validSession(session)||!validUuid(uuid))throw Error('invalid session or checkpoint id');
  const file=nativePath(session);
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await appendFile(file,JSON.stringify({uuid,ts_ms})+'\n',{mode:0o600});
 }

 // Resolve cwd to its work-tree root inside the workspace; null = not a git work tree.
 async function scopedRoot(cwd){
  if(typeof cwd!=='string'||!cwd||cwd.length>4096)throw Error('Invalid workspace path');
  const dir=await ctx.scoped(cwd),top=await toplevel(dir);
  return top?ctx.scoped(top):null;
 }
 const str=(v,name,max=4096)=>{if(v==null)return null;if(typeof v!=='string'||v.length>max)throw Error(`invalid ${name}`);return v;};
 const nowSecs=()=>Math.floor(nowMs()/1000);

 return {
  async turn_snapshot({cwd,sessionId,kind,prompt,observedMs}={}){
   const root=await scopedRoot(cwd);if(!root)return skipped('rollback needs git');
   const observed=observedMs==null?nowMs():Number.isSafeInteger(observedMs)&&observedMs>=0?observedMs:(()=>{throw Error('invalid observedMs');})();
   return snapshot(root,sessionId,kind,str(prompt,'prompt',65536),observed);
  },
  async turn_list({cwd,sessionId}={}){
   const root=await scopedRoot(cwd);
   if(!root)return {git:false,root:null,shared:false,peers:[],turns:[],restores:[]};
   return list(root,sessionId,nowSecs());
  },
  async turn_preview({cwd,sessionId,target,scope}={}){
   const root=await scopedRoot(cwd);if(!root)throw Error('rollback needs git');
   return preview(root,sessionId,target,parseScope(scope),nowSecs());
  },
  async turn_restore({cwd,sessionId,target,scope,claudeBin,nativeUuid}={}){
   const root=await scopedRoot(cwd);if(!root)throw Error('rollback needs git');
   const native=typeof claudeBin==='string'&&claudeBin&&typeof nativeUuid==='string'&&nativeUuid?{bin:claudeBin,uuid:nativeUuid}:null;
   return restore(root,sessionId,target,parseScope(scope),native,nowSecs());
  },
  async turn_native_checkpoint({sessionId,uuid}={}){await recordNative(sessionId,uuid,nowMs());return null;},
 };
}

export const TURNS_READ_ONLY=['turn_list'];

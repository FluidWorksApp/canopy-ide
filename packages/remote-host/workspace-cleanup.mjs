import {readdir,lstat,stat,statfs,readFile,realpath,rm,rename,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
// Mirrors src-tauri/src/cleanup.rs (cleanup_scan / cleanup_run / cleanup_disk)
// for a Linux workspace: the same allowlist-plus-marker table, the same "git
// must ignore it" net and the same recommendation rules, confined to
// /workspace. Desktop's table has no home-cache or macOS-only targets, so
// nothing is dropped; only the process monitor's busy cwds and the
// `cleanup:progress` event have no host-side equivalent.

const A=(name,category,markers,regenerate)=>({name,category,markers,regenerate});
const PY=['pyproject.toml','requirements.txt','setup.py','setup.cfg'],GRADLE=['build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts'];
const ARTIFACTS=[
 A('node_modules','deps',['package.json'],'npm install'),
 A('.venv','deps',PY,'python -m venv .venv && pip install -r requirements.txt'),
 A('venv','deps',PY,'python -m venv venv && pip install -r requirements.txt'),
 A('Pods','deps',['Podfile'],'pod install'),
 A('vendor/bundle','deps',['Gemfile'],'bundle install'),
 A('target','build',['Cargo.toml'],'cargo build'),
 A('target','build',['pom.xml'],'mvn package'),
 A('dist','build',['package.json'],'npm run build'),
 A('build','build',['pubspec.yaml','build.gradle','build.gradle.kts','CMakeLists.txt'],'rebuild the project'),
 A('.next','build',['package.json'],'next build'),
 A('.nuxt','build',['package.json'],'nuxt build'),
 A('.svelte-kit','build',['package.json'],'vite build'),
 A('.turbo','cache',['package.json'],'rebuilt on the next turbo run'),
 A('.parcel-cache','cache',[],'rebuilt on the next parcel run'),
 A('.gradle','cache',GRADLE,'rebuilt on the next gradle run'),
 A('.dart_tool','cache',['pubspec.yaml'],'rebuilt by flutter pub get'),
 A('__pycache__','cache',[],'rebuilt on the next import'),
 A('.mypy_cache','cache',[],'rebuilt on the next mypy run'),
 A('.pytest_cache','cache',[],'rebuilt on the next pytest run'),
 A('.ruff_cache','cache',[],'rebuilt on the next ruff run'),
];
const MAX_DEPTH=8,DIR_BUDGET=60000,FILE_BUDGET=400000,RECENT_BUILD_DAYS=3,IDLE_DAYS=30,DIRTY_IDLE_DAYS=90,NEVER=0xffffffff;
const PROTECTED=['main','master','develop','development','trunk','staging','production'];
const GIT_SAFETY=['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null'];

const under=(p,root)=>p===root||p.startsWith(root+'/');
const underAny=(p,roots)=>roots.some(r=>under(p,r));
const exists=p=>stat(p).then(()=>true,()=>false);
const entries=d=>readdir(d,{withFileTypes:true}).catch(()=>null);
const daysSince=ms=>Math.max(0,Math.floor((Date.now()-ms)/86400000));
const strArray=(v,label)=>{if(!Array.isArray(v)||v.length>4096||v.some(s=>typeof s!=='string'||s.includes('\0')))throw Error(`invalid ${label}`);return v;};
const tailMatches=(p,name)=>{const want=name.split('/'),have=p.split('/');return have.length>=want.length&&want.every((w,i)=>have[have.length-want.length+i]===w);};

export async function classify(p){
 for(const a of ARTIFACTS){
  if(!tailMatches(p,a.name))continue;
  if(!a.markers.length)return a;
  // The marker sits beside the artifact or one level up (vendor/bundle ← Gemfile).
  const parent=path.dirname(p),grand=path.dirname(parent);
  for(const m of a.markers)if(await exists(path.join(parent,m))||await exists(path.join(grand,m)))return a;
 }
 return null;
}
const walkable=name=>name!=='.git'&&name!=='node_modules'&&(!name.startsWith('.')||ARTIFACTS.some(a=>a.name.split('/')[0]===name));

// Recursive du that never follows a symlink.
async function measure(dir){
 const out={bytes:0,files:0,newest:null,partial:false},stack=[dir];
 while(stack.length){
  const d=stack.pop(),list=await entries(d);if(!list)continue;
  const files=[];
  for(const e of list){if(e.isSymbolicLink())continue;if(e.isDirectory()){stack.push(path.join(d,e.name));continue;}if(++out.files>FILE_BUDGET){out.partial=true;return out;}files.push(path.join(d,e.name));}
  for(const s of await Promise.all(files.map(f=>lstat(f).catch(()=>null))))if(s){out.bytes+=s.size;if(out.newest===null||s.mtimeMs>out.newest)out.newest=s.mtimeMs;}
 }
 return out;
}

export function verdict(act,category,built){
 if(act.busy)return [false,'a terminal or agent is live in this workspace'];
 if(act.asleep)return [false,'this project is hibernating — waking it expects this back'];
 if(act.dirty>0&&(act.idle_days??0)<DIRTY_IDLE_DAYS)return [false,`${act.dirty} uncommitted file${act.dirty===1?'':'s'} here`];
 if(act.landed)return [true,null];
 if(built<RECENT_BUILD_DAYS)return [false,built===0?'written today':built===1?'written yesterday':`written ${built} days ago`];
 if(category==='cache')return [true,null];
 if(act.idle_days===null)return [false,'not a git checkout — no history to judge by'];
 return act.idle_days>=IDLE_DAYS?[true,null]:[false,`last commit ${act.idle_days} day${act.idle_days===1?'':'s'} ago`];
}

export const WORKSPACE_CLEANUP_READ_ONLY=['cleanup_scan','cleanup_disk'];

export function workspaceCleanupCommands(ctx){
 // Inspection subcommands go through ctx.run (safeGitRead); the few that need an
 // exit code run with hooks/fsmonitor off and never touch the worktree.
 const read=(argv,cwd)=>ctx.run('git',argv,cwd,30000).then(s=>s,()=>null);
 const raw=async(argv,cwd,timeout=30000)=>{try{const {stdout}=await ctx.execute('git',[...GIT_SAFETY,...argv],{cwd,timeout,maxBuffer:4*1024*1024,env:{...process.env,HOME:ctx.home,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}});return {code:0,stdout};}catch(error){return {code:typeof error.code==='number'?error.code:-1,stdout:String(error.stdout??'')};}};
 const workspaceRoot=async()=>realpath(ctx.root);

 const toplevel=async dir=>{const s=(await read(['rev-parse','--show-toplevel'],dir))?.trim();return s&&await stat(s).then(x=>x.isDirectory(),()=>false)?s:null;};
 async function defaultBase(top){
  const sym=(await raw(['symbolic-ref','--short','refs/remotes/origin/HEAD'],top)).stdout.trim();if(sym)return sym;
  for(const c of ['origin/main','origin/master','main','master'])if(await read(['rev-parse','--verify','--quiet',c],top)!==null)return c;
  return (await read(['rev-parse','--abbrev-ref','HEAD'],top))?.trim()||'HEAD';
 }
 async function worktrees(top){
  const text=await read(['worktree','list','--porcelain'],top);if(text===null)return [];
  const list=[];let cur=null;
  for(const line of text.split('\n')){
   if(!line.trim()){if(cur)list.push(cur);cur=null;continue;}
   const i=line.indexOf(' '),key=i<0?line:line.slice(0,i),value=i<0?'':line.slice(i+1);
   if(key==='worktree'){if(cur)list.push(cur);cur={path:value,branch:null,bare:false,locked:false,prunable:false};}
   else if(cur&&key==='branch')cur.branch=value.replace(/^refs\/heads\//,'');
   else if(cur&&key==='bare')cur.bare=true;else if(cur&&key==='locked')cur.locked=true;else if(cur&&key==='prunable')cur.prunable=true;
  }
  if(cur)list.push(cur);
  return list.map((w,i)=>({...w,main:i===0}));
 }
 async function addRepo(top,roots,state){
  if(state.repos.has(top))return;state.repos.add(top);
  const base=await defaultBase(top);
  for(const w of await worktrees(top)){
   if(w.bare||w.prunable||!(await stat(w.path).then(x=>x.isDirectory(),()=>false)))continue;
   if(!underAny(w.path,roots)){state.skipped.push(`${w.path} — a workspace of ${path.basename(top)} that lives outside your open projects`);continue;}
   if(!state.seen.has(w.path)){state.seen.add(w.path);state.out.push({path:w.path,branch:w.branch,main:w.main,base});}
  }
 }
 async function nestedRepos(root,depth,out){
  if(!depth)return;const list=await entries(root);if(!list)return;
  for(const e of list){if(e.isSymbolicLink()||!e.isDirectory())continue;const p=path.join(root,e.name);if(await exists(path.join(p,'.git'))){out.push(p);continue;}if(walkable(e.name))await nestedRepos(p,depth-1,out);}
 }
 async function checkouts(roots,skipped){
  const state={out:[],seen:new Set(),repos:new Set(),skipped};
  for(const root of roots){
   const top=await toplevel(root);
   if(top&&underAny(top,roots))await addRepo(top,roots,state);
   else{
    if(!state.seen.has(root)){state.seen.add(root);state.out.push({path:root,branch:null,main:true,base:null});}
    const nested=[];await nestedRepos(root,3,nested);
    for(const repo of nested){const t=(await toplevel(repo))||repo;if(underAny(t,roots))await addRepo(t,roots,state);}
   }
  }
  return state.out;
 }
 async function candidates(root,stop,budget){
  const found=[],stack=[[root,0]];
  while(stack.length){
   const [dir,depth]=stack.pop();if(depth>=MAX_DEPTH||budget.left===0)continue;
   const list=await entries(dir);if(!list)continue;
   for(const e of list){
    if(e.isSymbolicLink()||!e.isDirectory())continue;
    const p=path.join(dir,e.name);if(stop.includes(p))continue;
    if(budget.left===0)break;budget.left--;
    if(await classify(p)){found.push(p);continue;}
    if(walkable(e.name))stack.push([p,depth+1]);
   }
  }
  return found.sort();
 }
 // check-ignore exits 1 for "none ignored"; anything above that refuses the checkout.
 // Paths go as argv (-z needs stdin, which ctx cannot feed); one git would quote a
 // name with a newline or quote, so such a name never matches and is never offered.
 async function ignoredSet(dir,paths){
  const set=new Set();
  for(let i=0;i<paths.length;i+=200){
   const {code,stdout}=await raw(['-c','core.quotePath=false','check-ignore','--',...paths.slice(i,i+200)],dir);
   if(code!==0&&code!==1)return null;
   for(const s of stdout.split('\n').filter(Boolean))set.add(path.isAbsolute(s)?s:path.join(dir,s));
  }
  return set;
 }
 async function landed(dir,base,branch,main){
  if(main)return null;
  const leaf=base.split('/').pop();
  if(branch&&(branch===leaf||PROTECTED.includes(branch)))return null;
  if((await raw(['merge-base','--is-ancestor','HEAD',base],dir)).code===0)return `already merged into ${base}`;
  if(!branch)return null;
  const upstream=(await read(['for-each-ref','--format=%(upstream)',`refs/heads/${branch}`],dir))?.trim();
  if(!upstream)return null;
  return await read(['rev-parse','--verify','--quiet',upstream],dir)===null?'its remote branch is gone — the work landed':null;
 }

 async function scan(roots,busy,asleep){
  const out={workspaces:[],targets:[],bytes:0,recommended_bytes:0,skipped:[],truncated:false};
  const found=await checkouts(roots,out.skipped),all=found.map(c=>c.path),budget={left:DIR_BUDGET};
  for(const checkout of found){
   const p=checkout.path;
   let cands=await candidates(p,all.filter(x=>x!==p),budget);
   const isRepo=checkout.base!==null||await exists(path.join(p,'.git'));
   if(isRepo){const ignored=await ignoredSet(p,cands);if(ignored)cands=cands.filter(c=>ignored.has(c));else{out.skipped.push(`${p} — couldn't ask git what it ignores here`);cands=[];}}
   const commit=isRepo?Number((await read(['log','-1','--format=%ct'],p))?.trim()):NaN;
   const act={
    busy:busy.some(b=>under(b,p)),asleep:asleep.some(a=>under(p,a)||under(a,p)),
    dirty:isRepo?((await read(['status','--porcelain'],p))??'').split('\n').filter(l=>l.trim()).length:0,
    idle_days:Number.isFinite(commit)&&commit>0?daysSince(commit*1000):null,
    landed:checkout.base!==null?await landed(p,checkout.base,checkout.branch,checkout.main):null,
   };
   const ws={path:p,name:path.basename(p),branch:checkout.branch,main:checkout.main,dirty:act.dirty,busy:act.busy,asleep:act.asleep,idle_days:act.idle_days,landed:act.landed,bytes:0,recommended_bytes:0};
   for(const cand of cands){
    const artifact=await classify(cand);if(!artifact)continue;
    const size=await measure(cand);if(size.bytes===0)continue;
    const built=size.newest===null?NEVER:daysSince(size.newest),[recommended,hold]=verdict(act,artifact.category,built);
    ws.bytes+=size.bytes;if(recommended)ws.recommended_bytes+=size.bytes;
    out.targets.push({path:cand,name:artifact.name,rel:path.relative(p,cand),category:artifact.category,bytes:size.bytes,files:size.files,idle_days:built===NEVER?0:built,regenerate:artifact.regenerate,workspace:p,recommended,hold,partial:size.partial});
   }
   out.bytes+=ws.bytes;out.recommended_bytes+=ws.recommended_bytes;out.workspaces.push(ws);
  }
  out.truncated=budget.left===0;
  out.targets.sort((a,b)=>a.workspace<b.workspace?-1:a.workspace>b.workspace?1:b.bytes-a.bytes);
  return out;
 }

 // cleanup.rs `deletable`, re-checked from scratch. The VM has no list of project
 // folders, so a direct child of /workspace (where projects live) stands in for one.
 async function deletable(p,root){
  if(!under(p,root))return 'outside your open projects';
  if(!(await classify(p)))return 'not something a build can make again';
  let meta;try{meta=await lstat(p);}catch(error){return error.message;}
  if(meta.isSymbolicLink())return 'a symlink — the real directory is somewhere else';
  if(!meta.isDirectory())return 'not a directory';
  if(await exists(path.join(p,'.git')))return 'a git checkout, not a build directory';
  if(p===root||path.dirname(p)===root)return 'one of your project folders';
  return null;
 }
 // The freedesktop "topdir" trash the desktop `trash` crate uses off the home
 // volume: <mount>/.Trash-<uid>, never above /workspace, so it is a rename.
 async function toTrash(p,root){
  const dev=(await lstat(p)).dev;let top=path.dirname(p);
  while(top!==root&&under(path.dirname(top),root)&&(await lstat(path.dirname(top))).dev===dev)top=path.dirname(top);
  const bin=path.join(top,`.Trash-${process.getuid()}`);
  await mkdir(path.join(bin,'files'),{recursive:true,mode:0o700});await mkdir(path.join(bin,'info'),{recursive:true,mode:0o700});
  let name=path.basename(p);for(let n=2;await lstat(path.join(bin,'files',name)).then(()=>true,()=>false)||await lstat(path.join(bin,'info',name+'.trashinfo')).then(()=>true,()=>false);n++)name=`${path.basename(p)}.${n}`;
  const date=new Date(),pad=v=>String(v).padStart(2,'0');
  const stamp=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  await writeFile(path.join(bin,'info',name+'.trashinfo'),`[Trash Info]\nPath=${p.split('/').map(encodeURIComponent).join('/')}\nDeletionDate=${stamp}\n`,{mode:0o600,flag:'wx'});
  await rename(p,path.join(bin,'files',name));
 }

 return {
  cleanup_scan:async({roots,busy=[],asleep=[]}={})=>{
   strArray(roots,'roots');strArray(busy,'busy');strArray(asleep,'asleep');
   const resolved=[],outOfScope=[];
   for(const r of roots){try{resolved.push(await ctx.scoped(r));}catch{outOfScope.push(`${r} — not in this window's scope; a sleeping project releases its folders, so wake it to include it`);}}
   if(!resolved.length)throw Error(roots.length?'nothing to scan — the open projects are all hibernating, and a sleeping project keeps what it expects to wake up to':'no project folders to scan');
   const out=await scan(resolved,busy,asleep);
   out.skipped=[...outOfScope,...out.skipped];
   return out;
  },
  cleanup_run:async({paths,trash}={})=>{
   strArray(paths,'paths');if(typeof trash!=='boolean')throw Error('invalid trash');
   const resolved=[];for(const p of paths)resolved.push(await ctx.scoped(p));
   const root=await workspaceRoot(),out={removed:[],bytes:0,failed:[],refused:[],trashed:trash};
   for(const p of resolved){
    const why=await deletable(p,root);if(why){out.refused.push(`${p} — ${why}`);continue;}
    const bytes=(await measure(p)).bytes;
    try{if(trash)await toTrash(p,root);else await rm(p,{recursive:true,force:false});out.removed.push(p);out.bytes+=bytes;}
    catch(error){out.failed.push([p,String(error.message||error)]);}
   }
   return out;
  },
  cleanup_disk:async({roots}={})=>{
   strArray(roots,'roots');
   const mounts=(await readFile('/proc/self/mounts','utf8').catch(()=>'')).split('\n').map(l=>l.split(' ')).filter(f=>f.length>=2).map(([device,mount])=>({device,mount:mount.replace(/\\(\d{3})/g,(_,o)=>String.fromCharCode(parseInt(o,8)))}));
   const out=[];
   for(const r of roots){
    let p;try{p=await ctx.scoped(r);}catch{continue;}
    // Longest matching mount wins, as on desktop.
    const best=mounts.filter(m=>m.mount==='/'||under(p,m.mount)).sort((a,b)=>b.mount.length-a.mount.length)[0];
    const mount=best?.mount??'/';if(out.some(d=>d.mount===mount))continue;
    const s=await statfs(p).catch(()=>null);if(!s)continue;
    out.push({mount,label:best?.device??'',total_bytes:s.blocks*s.bsize,free_bytes:s.bavail*s.bsize});
   }
   return out;
  },
 };
}

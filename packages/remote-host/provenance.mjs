// Which agent session produced which pull request, for the Linux workspace —
// the desktop's src-tauri/src/provenance.rs (provenance_record,
// provenance_for_pr, provenance_for_session, provenance_backfill) with the same
// store: one append-only JSONL file at ~/.canopy/provenance.jsonl, rows never
// updated in place (recording twice is a no-op, keyed repo + PR + session),
// compacted to the newest MAX_EDGES only past the cap. It sits beside
// ~/.canopy/sessions, never inside it, so forgetting a session never reaches it.
// `ctx.changed(store, scope, id)`, when the host provides it, is called after
// every write — the desktop's change::pulse(Provenance, repo, pr_number).
import {readFile,readdir,stat,mkdir,appendFile,writeFile,rename,realpath} from 'node:fs/promises';
import path from 'node:path';

export const MAX_EDGES=5000,HISTORY_LIMIT=200;
const VIA={job_done:'declared',pr_watch:'observed',backfill:'inferred'};
const MAX_DIGEST_BYTES=1024*1024,MAX_SEEDS=2000;

export const validSessionId=id=>typeof id==='string'&&id.length>0&&/^[A-Za-z0-9._-]+$/.test(id)&&!id.includes('..');
export function checkEdge(e){
 if(!validSessionId(e.session_id))throw Error('invalid session id');
 if(e.pr_number===0)throw Error('a pull request number is required');
 if(!e.branch.trim())throw Error('a branch is required — it is what the edge was joined on');
 if(!e.repo.trim())throw Error('a repo is required');
}
const out=e=>({...e,confidence:VIA[e.via]});
const keyOf=e=>`${e.repo}\0${e.pr_number}\0${e.session_id}`;
// Field order matches the Rust struct, so both sides write identical lines.
const edge=e=>({repo:e.repo,pr_number:e.pr_number,pr_url:e.pr_url,branch:e.branch,session_id:e.session_id,agent:e.agent??null,profile:e.profile??null,cwd:e.cwd,via:e.via,at:e.at});
const parseEdge=line=>{
 try{const v=JSON.parse(line);
  if(!v||typeof v!=='object')return null;
  for(const k of ['repo','pr_url','branch','session_id','cwd'])if(typeof v[k]!=='string')return null;
  if(!Number.isSafeInteger(v.pr_number)||v.pr_number<0||!Number.isSafeInteger(v.at)||v.at<0||!(v.via in VIA))return null;
  if(v.agent!=null&&typeof v.agent!=='string'||v.profile!=null&&typeof v.profile!=='string')return null;
  return edge(v);
 }catch{return null;}
};
const canon=async p=>{try{return await realpath(p);}catch{return p;}};
const belongs=(owned,want)=>owned.some(d=>want===d||want.startsWith(d+'/'));

export function provenanceCommands(ctx){
 const file=path.join(ctx.home,'.canopy','provenance.jsonl');
 // Loaded once and revalidated by stat: another writer may have appended.
 const cache={stamp:null,edges:[],keys:new Set()};
 const stampOf=async()=>{try{const s=await stat(file);return `${s.size}:${s.mtimeMs}`;}catch{return null;}};
 async function sync(){
  const stamp=await stampOf();
  if(stamp!==null&&stamp===cache.stamp)return;
  let raw='';try{raw=await readFile(file,'utf8');}catch{}
  cache.edges=raw.split('\n').filter(l=>l.trim()).map(parseEdge).filter(Boolean);
  cache.keys=new Set(cache.edges.map(keyOf));cache.stamp=stamp;
 }
 let lock=Promise.resolve();
 const locked=fn=>{const next=lock.then(fn,fn);lock=next.catch(()=>{});return next;};
 // The write boundary: whether anything was written.
 async function append(e){
  const key=keyOf(e);if(cache.keys.has(key))return false;
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  if(cache.edges.length+1>MAX_EDGES){
   cache.edges=[...cache.edges.slice(cache.edges.length+1-MAX_EDGES),e];cache.keys=new Set(cache.edges.map(keyOf));
   const tmp=`${file}.tmp${process.pid}`;
   await writeFile(tmp,cache.edges.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});await rename(tmp,file);
  }else{
   await appendFile(file,JSON.stringify(e)+'\n',{mode:0o600});
   cache.edges.push(e);cache.keys.add(key);
  }
  cache.stamp=await stampOf();
  try{ctx.changed?.('provenance',e.repo,String(e.pr_number));}catch{}
  return true;
 }

 // The one name a repository has: its main checkout, from whichever worktree
 // you arrived. A path git can't speak for (or outside the workspace) keys to itself.
 const keys=new Map();
 async function repoKey(p){
  if(keys.has(p))return keys.get(p);
  let key=p.replace(/\/+$/,'');
  try{
   const dir=await ctx.scoped(p);
   const raw=(await ctx.run('git',['rev-parse','--git-common-dir'],dir)).trim();
   if(raw)key=path.dirname(await realpath(path.resolve(dir,raw)));
  }catch{}
  if(keys.size>=1024)keys.delete(keys.keys().next().value);
  keys.set(p,key);return key;
 }
 async function query(keep){
  return locked(async()=>{await sync();return cache.edges.filter(keep).sort((a,b)=>b.at-a.at).slice(0,MAX_EDGES).map(out);});
 }
 const str=(v,name,{max=4096,optional=false}={})=>{if(optional&&v==null)return null;if(typeof v!=='string'||v.length>max||v.includes('\0'))throw Error(`invalid ${name}`);return v;};
 const checkedPr=v=>{if(!Number.isSafeInteger(v)||v<0)throw Error('invalid pull request number');return v;};

 // Every directory this repo can speak for: its toplevel plus every worktree
 // git lists (a removed one still lists — unresumable, still attributable).
 async function ownedDirs(top){
  const dirs=[await canon(top)];
  try{for(const line of (await ctx.run('git',['worktree','list','--porcelain'],top)).split('\n'))if(line.startsWith('worktree '))dirs.push(await canon(line.slice(9)));}catch{}
  return dirs;
 }
 async function ghPrRefs(top){
  try{
   const rows=JSON.parse(await ctx.run('gh',['pr','list','--limit',String(HISTORY_LIMIT),'--state','all','--json','number,url,headRefName'],top,300000,{GH_PROMPT_DISABLED:'1'}));
   return Array.isArray(rows)?rows.filter(r=>Number.isSafeInteger(r?.number)&&r.number>=0&&typeof r.url==='string'&&typeof r.headRefName==='string').map(r=>({number:r.number,url:r.url,branch:r.headRefName})):[];
  }catch{return [];}
 }
 /** The join: digests whose branch is a PR's head and whose cwd belongs to this repo. */
 async function sweep(sessions,prs,owned,key,via){
  const byBranch=new Map(prs.map(p=>[p.branch,p])),report={scanned:0,matched:0,recorded:0,unattributable:0},edges=[];
  let entries;try{entries=await readdir(sessions,{withFileTypes:true});}catch{return {edges,report};}
  for(const entry of entries){
   if(path.extname(entry.name)!=='.json'||!entry.isFile())continue;
   let d;try{const p=path.join(sessions,entry.name);if((await stat(p)).size>MAX_DIGEST_BYTES)continue;d=JSON.parse(await readFile(p,'utf8'));}catch{continue;}
   report.scanned++;
   const s=k=>d&&typeof d[k]==='string'?d[k]:null;
   const branch=s('branch'),session_id=s('session_id'),cwd=s('cwd');
   if(branch===null||session_id===null||cwd===null)continue;
   const seed=byBranch.get(branch);if(!seed||!validSessionId(session_id))continue;
   if(!belongs(owned,await canon(cwd))){report.unattributable++;continue;}
   // The digest's clock, not the sweep's.
   const e=edge({repo:key,pr_number:seed.number,pr_url:seed.url,branch,session_id,agent:s('agent'),profile:s('profile'),cwd,via,at:Number.isSafeInteger(d.updated)&&d.updated>=0?d.updated:0});
   try{checkEdge(e);}catch{continue;}
   report.matched++;edges.push(e);
  }
  return {edges,report};
 }

 return {
  async provenance_record({repo,prNumber,prUrl,branch,sessionId,agent,profile,cwd,via}={}){
   str(repo,'repo');if(!repo.trim())throw Error('a repo is required');
   if(typeof via!=='string'||!(via in VIA))throw Error(`unknown variant \`${String(via).slice(0,64)}\`, expected one of \`job_done\`, \`pr_watch\`, \`backfill\``);
   const e=edge({repo:await repoKey(repo),pr_number:checkedPr(prNumber),pr_url:str(prUrl,'prUrl'),branch:str(branch,'branch',{max:1024}),session_id:str(sessionId,'sessionId',{max:256}),agent:str(agent,'agent',{max:256,optional:true}),profile:str(profile,'profile',{max:256,optional:true}),cwd:str(cwd,'cwd'),via,at:Math.floor(Date.now()/1000)});
   checkEdge(e);
   return locked(async()=>{await sync();return append(e);});
  },
  async provenance_for_pr({repo,prNumber:n}={}){
   const key=await repoKey(str(repo,'repo')),number=checkedPr(n);
   return query(e=>e.repo===key&&e.pr_number===number);
  },
  async provenance_for_session({sessionId}={}){
   const id=str(sessionId,'sessionId',{max:256});
   return query(e=>e.session_id===id);
  },
  /** The workspace's PR watcher pass (prwatch.rs attribute_observed): every PR
   *  on GitHub for this repository, with when it opened and merged, and an
   *  edge for each new one a session's branch produced (via pr_watch). */
  async provenance_observe({repo}={}){
   const dir=await ctx.scoped(str(repo,'repo'));
   const top=await ctx.scoped((await ctx.run('git',['rev-parse','--show-toplevel'],dir)).trim());
   const key=await repoKey(top);
   let rows;
   try{rows=JSON.parse(await ctx.run('gh',['pr','list','--limit',String(HISTORY_LIMIT),'--state','all','--json','number,url,headRefName,createdAt,mergedAt'],top,120000,{GH_PROMPT_DISABLED:'1'}));}
   catch(error){throw Error(`GitHub pull requests are unavailable here: ${String(error?.message??error).split('\n')[0]}`);}
   const ms=v=>{const t=typeof v==='string'&&v?Date.parse(v):NaN;return Number.isFinite(t)?t:null;};
   const prs=(Array.isArray(rows)?rows:[]).filter(r=>Number.isSafeInteger(r?.number)&&r.number>0&&typeof r.url==='string'&&typeof r.headRefName==='string')
    .map(r=>({number:r.number,url:r.url,branch:r.headRefName,createdAt:ms(r.createdAt),mergedAt:ms(r.mergedAt)}));
   const fresh=await locked(async()=>{await sync();return prs.filter(p=>!cache.edges.some(e=>e.repo===key&&e.pr_number===p.number));});
   let recorded=0;
   if(fresh.length){
    const {edges}=await sweep(path.join(ctx.home,'.canopy','sessions'),fresh,await ownedDirs(top),key,'pr_watch');
    recorded=await locked(async()=>{await sync();let n=0;for(const e of edges)if(await append(e))n++;return n;});
   }
   return {repo:key,prs,recorded};
  },
  async provenance_backfill({repo,prs}={}){
   const dir=await ctx.scoped(str(repo,'repo'));
   const top=await ctx.scoped((await ctx.run('git',['rev-parse','--show-toplevel'],dir)).trim());
   const key=await repoKey(top),owned=await ownedDirs(top);
   if(!Array.isArray(prs)||prs.length>MAX_SEEDS)throw Error('invalid pull request list');
   let seeds=prs.map(p=>({number:checkedPr(p?.number),url:str(p?.url,'pull request url'),branch:str(p?.branch,'pull request branch',{max:1024})}));
   // No seeds means "go and find them": the merged PRs the watcher never lists.
   if(!seeds.length)seeds=await ghPrRefs(top);
   if(!seeds.length)return {scanned:0,matched:0,recorded:0,unattributable:0};
   const {edges,report}=await sweep(path.join(ctx.home,'.canopy','sessions'),seeds,owned,key,'backfill');
   return locked(async()=>{await sync();for(const e of edges)if(await append(e))report.recorded++;return report;});
  },
 };
}

export const PROVENANCE_READ_ONLY=['provenance_for_pr','provenance_for_session'];

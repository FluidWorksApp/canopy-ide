import {accountHomes} from './account-homes.mjs';
import {readFile,writeFile,appendFile,rename,mkdir,readdir,stat,lstat,rm,open,readlink,truncate} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {WorkspaceProfiles} from './profiles.mjs';

// SpotSearch's persistent index (src-tauri/src/spot.rs + the readers in
// stores.rs), for the Linux workspace. The desktop keeps an SQLite FTS5 table;
// node:sqlite is experimental (and absent on older 22.x), so this keeps the
// same rows in plain files and searches them with an in-memory inverted index:
//   <home>/.canopy/spot/sources.json   per-file bookmarks (offset / stamp) like spot.rs's `sources`
//   <home>/.canopy/spot/docs/*.jsonl   the rows, one shard per source file / terminal / store
// Ranking reproduces FTS5's bm25 (k1 1.2, b 0.75, title+body weight 1, unicode61
// tokens, quoted-prefix query terms) plus spot.rs's age penalty; snippets
// approximate snippet(docs,5,'','',' … ',14). Everything is derived, so a shard
// that disagrees with its bookmark is dropped and re-read, never repaired.

export const SPOT_INDEX_READ_ONLY=['spot_search','spot_index_stats'];

export const STORE_AGENTS=['claude','codex','omp','gemini','agy','opencode','aider'];
const INGEST_BUDGET=4*1024*1024, MAX_SCROLLBACK=256*1024, MAX_WHOLE_BODIES=4000, MAX_BODY=4000, MAX_BRIEF=16*1024*1024;
const RUNNER='http://127.0.0.1:8080';

// ---------- text helpers (stores.rs / spot.rs) ----------
const takeChars=(s,n)=>{if(s.length<=n)return s;let out='',i=0;for(const c of s){if(i++>=n)break;out+=c;}return out;};
const clip=s=>takeChars(s,MAX_BODY);
const isInjected=t=>t.trimStart().startsWith('<');
const isControl=c=>{const n=c.codePointAt(0);return n<0x20||(n>=0x7f&&n<0xa0);};
const lines=s=>{const out=s.split('\n');if(out.at(-1)==='')out.pop();return out.map(l=>l.endsWith('\r')?l.slice(0,-1):l);};
const json=s=>{try{return JSON.parse(s);}catch{return undefined;}};
const nowSecs=()=>Math.floor(Date.now()/1000);
const mtimeSecs=info=>Math.floor(info.mtimeMs/1000);

export function stripAnsi(s){
 let out='';const it=s[Symbol.iterator]();
 for(let r=it.next();!r.done;r=it.next()){
  const c=r.value;
  if(c==='\x1b'){const n=it.next();if(n.done)break;
   if(n.value==='['){for(let x=it.next();!x.done;x=it.next())if(x.value>='@'&&x.value<='~')break;}
   else if(n.value===']'){for(let x=it.next();!x.done;x=it.next()){if(x.value==='\x07')break;if(x.value==='\x1b'){it.next();break;}}}
  }else if(c==='\r')out+='\n';
  else if(c==='\n'||c==='\t'||!isControl(c))out+=c;
 }
 return out;
}

// Same stamp as spot.rs tail_stamp: length in the high bits, FNV-1a of the last 4 KB below.
export function tailStamp(buf){let h=0xcbf29ce484222325n;for(const b of buf.subarray(Math.max(0,buf.length-4096))){h^=BigInt(b);h=(h*0x100000001b3n)&0xffffffffffffffffn;}return buf.length*1048576+Number(h&0xfffffn);}

export function underRoots(cwd,roots){if(!roots.length)return true;return roots.some(r=>{r=r.replace(/\/+$/,'');return cwd===r||cwd.startsWith(r+'/');});}
export function agePenalty(ts,now){if(ts<=0)return 0;return Math.log(1+Math.max(0,now-ts)/86400)*0.35;}

// unicode61 with remove_diacritics: runs of letters/numbers/private-use, folded.
const TOKEN=/[\p{L}\p{N}\p{Co}]+/gu;
const fold=t=>t.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const tokens=s=>{const out=[];for(const m of s.matchAll(TOKEN))out.push(fold(m[0]));return out;};
const tokenSpans=s=>{const out=[];for(const m of s.matchAll(TOKEN))out.push({t:fold(m[0]),start:m.index,end:m.index+m[0].length});return out;};
// fts_query: each whitespace word a quoted prefix phrase.
export const parseQuery=q=>q.split(/\s+/).filter(Boolean).map(tokens).filter(p=>p.length);

// ---------- store readers (stores.rs) ----------
async function walk(root,depth,pred,out){let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return;}for(const e of entries){const p=path.join(root,e.name);let dir=e.isDirectory();if(e.isSymbolicLink()){try{dir=(await stat(p)).isDirectory();}catch{continue;}}if(dir){if(depth>0)await walk(p,depth-1,pred,out);}else if(pred(p))out.push(p);}}
const hasExt=(p,x)=>path.extname(p)==='.'+x;
const exists=async p=>{try{await stat(p);return true;}catch{return false;}};
const sha256=s=>createHash('sha256').update(s).digest('hex');

async function configRoots(home){
 let roots;try{roots=(await new WorkspaceProfiles(home).list()).map(p=>[p.id,p.root]);}catch{roots=[['default',home]];}
 // Shared-account sessions keep their transcripts in their own home.
 return [...roots,...(await accountHomes(home)).map(root=>['account',root])];
}

export async function sourceFiles(home,roots,wanted,scopedRoot){
 const out=[],push=(agent,file,layout)=>out.push({agent,path:file,layout});
 const cfg=await configRoots(home);
 for(const [agent,sub,depth] of [['claude','.claude/projects',1],['codex','.codex/sessions',3]])
  if(wanted(agent))for(const [,root] of cfg){const files=[];await walk(path.join(root,sub),depth,p=>hasExt(p,'jsonl'),files);for(const f of files)push(agent,f,'append');}
 if(wanted('omp')){const files=[];await walk(path.join(home,'.omp/agent/sessions'),2,p=>hasExt(p,'jsonl'),files);for(const f of files)push('omp',f,'append');}
 if(wanted('gemini'))for(const r of roots){const bucket=path.join(home,'.gemini/tmp',sha256(r.replace(/\/+$/,'')));const files=[];await walk(path.join(bucket,'chats'),0,p=>hasExt(p,'json'),files);if(await exists(path.join(bucket,'logs.json')))files.push(path.join(bucket,'logs.json'));for(const f of files)push('gemini',f,'whole');}
 if(wanted('agy')){const files=[];await walk(path.join(home,'.gemini/antigravity-cli/conversations'),0,p=>hasExt(p,'db'),files);for(const f of files)push('agy',f,'whole');}
 if(wanted('opencode'))for(const [,root] of cfg){const db=path.join(root,'.local/share/opencode/opencode.db');if(await exists(db))push('opencode',db,'whole');}
 // aider writes into the repo itself, so these are caller-named paths: workspace only.
 if(wanted('aider'))for(const r of roots){let dir;try{dir=await scopedRoot(r);}catch{continue;}const p=path.join(dir,'.aider.chat.history.md');if(await exists(p))push('aider',p,'whole');}
 return out;
}

function uuidTail(name){const tail=name.split(/[_/]/).at(-1);return tail.length>=32&&/^[0-9a-fA-F-]+$/.test(tail)&&tail.includes('-')?tail:null;}

export async function appendMeta(agent,file){
 let head=Buffer.alloc(0);try{const fh=await open(file,'r');try{const b=Buffer.alloc(64*1024);const {bytesRead}=await fh.read(b,0,b.length,0);head=b.subarray(0,bytesRead);}finally{await fh.close();}}catch{}
 const stem=path.basename(file,path.extname(file));let id='',cwd='';
 for(const line of lines(head.toString('utf8'))){
  const v=json(line);if(v===undefined)continue;
  if(agent==='claude'){if(typeof v?.cwd==='string')cwd=v.cwd;id=stem;}
  else if(agent==='codex'){if(v?.type==='session_meta'){id=typeof v.payload?.session_id==='string'?v.payload.session_id:'';cwd=typeof v.payload?.cwd==='string'?v.payload.cwd:'';}}
  else if(agent==='omp'){if(v?.type==='session'){id=typeof v.id==='string'?v.id:'';cwd=typeof v.cwd==='string'?v.cwd:'';}}
  if(id&&cwd)break;
 }
 if(!id){
  // A sub-agent transcript sits in a directory named for the conversation that spawned it.
  const parent=path.dirname(file);id=uuidTail(path.basename(parent))??uuidTail(stem)??stem;
  if(!cwd){const base=path.basename(parent),ext=path.extname(base);const sibling=path.join(path.dirname(parent),(ext?base.slice(0,-ext.length):base)+'.jsonl');if(await exists(sibling))cwd=(await appendMeta(agent,sibling))[1];}
 }
 return [id,cwd];
}

function contentText(content){if(typeof content==='string')return content;if(!Array.isArray(content))return null;const joined=content.filter(i=>['text','input_text','output_text'].includes(i?.type)&&typeof i.text==='string').map(i=>i.text).join('\n');return joined||null;}

export function appendLineText(agent,line){
 const v=json(line);if(v===undefined||v===null)return null;let text;
 if(agent==='claude'||agent==='omp'){
  const ty=v.type;if(typeof ty!=='string'||!['user','assistant','message'].includes(ty))return null;
  if(ty==='message'&&!['user','assistant'].includes(v.message?.role))return null;
  text=contentText(v.message?.content);
 }else if(agent==='codex'){
  if(v.type!=='response_item'||v.payload?.type!=='message'||!['user','assistant'].includes(v.payload?.role))return null;
  text=contentText(v.payload.content);
 }else return null;
 if(text==null)return null;const t=text.trim();if(!t||isInjected(t))return null;return clip(t);
}

async function geminiSessions(file,roots,mtime){
 const v=json(await readFile(file,'utf8').catch(()=>''));if(v===undefined)return [];
 const isLog=path.basename(file)==='logs.json';
 const bucket=path.basename(isLog?path.dirname(file):path.dirname(path.dirname(file)));
 const cwd=roots.find(r=>sha256(r.replace(/\/+$/,''))===bucket)??'';
 if(isLog){const by=new Map();for(const e of Array.isArray(v)?v:[]){if(e?.type!=='user'||typeof e.sessionId!=='string'||typeof e.message!=='string')continue;const t=e.message.trim();if(!t||isInjected(t))continue;const s=by.get(e.sessionId);if(s){s.bodies.push(clip(t));s.roles.push('user');}else by.set(e.sessionId,{session_id:e.sessionId,cwd,updated:mtime,bodies:[clip(t)],roles:['user']});}return [...by.values()];}
 const s={session_id:typeof v?.sessionId==='string'?v.sessionId:'',cwd,updated:mtime,bodies:[],roles:[]};
 for(const m of Array.isArray(v?.messages)?v.messages:[]){if(m?.type!=='user'&&m?.type!=='gemini')continue;if(typeof m.content!=='string')continue;const t=m.content.trim();if(!t||isInjected(t))continue;s.bodies.push(clip(t));s.roles.push(m.type==='user'?'user':'assistant');}
 return s.session_id&&s.bodies.length?[s]:[];
}

async function aiderSessions(file,mtime){
 const raw=await readFile(file,'utf8').catch(()=>null);if(raw==null)return [];
 const cwd=path.dirname(file),out=[];let cur=null;
 for(const line of lines(raw)){
  if(line.startsWith('# aider chat started at ')){if(cur?.bodies.length)out.push(cur);cur={session_id:file+'#'+line.slice(24).trim().replaceAll(' ','T'),cwd,updated:mtime,bodies:[],roles:[]};continue;}
  if(!cur||line.startsWith('>')||!line.trim())continue;
  const asked=line.startsWith('#### '),text=(asked?line.slice(5):line).trim();if(text){cur.bodies.push(clip(text));cur.roles.push(asked?'user':'assistant');}
 }
 if(cur?.bodies.length)out.push(cur);return out;
}

// SQLite stores are read with node:sqlite when this Node has it; without it they are skipped.
let sqlite;const loadSqlite=async()=>sqlite??=await import('node:sqlite').catch(()=>null);
async function readonlyDb(file){const m=await loadSqlite();if(!m)return null;try{return new m.DatabaseSync(file,{readOnly:true});}catch{return null;}}

async function opencodeSessions(file){
 const db=await readonlyDb(file);if(!db)return [];const out=[];
 try{
  // Who wrote a part is on its message; a store without that join still yields the text.
  let parts;try{parts=db.prepare("SELECT p.data AS data, COALESCE(json_extract(m.data,'$.role'),'') AS role FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE p.session_id = ? ORDER BY p.time_created LIMIT 2000");}catch{parts=db.prepare("SELECT data, '' AS role FROM part WHERE session_id = ? ORDER BY time_created LIMIT 2000");}
  for(const r of db.prepare("SELECT id, directory, COALESCE(title,'') AS title, COALESCE(time_updated,0) AS updated FROM session").all()){
   const s={session_id:String(r.id),cwd:r.directory??'',updated:Math.trunc(Number(r.updated)/1000),bodies:[],roles:[]};
   for(const p of parts.all(r.id)){const v=json(p.data);if(typeof v?.text!=='string')continue;const t=v.text.trim();if(t&&!isInjected(t)){s.bodies.push(clip(t));s.roles.push(p.role==='user'||p.role==='assistant'?p.role:'message');}}
   if(s.bodies.length)out.push(s);
  }
 }catch{}finally{try{db.close();}catch{}}
 return out;
}

const decode=b=>new TextDecoder('utf-8').decode(b);
function printableRuns(blob,min){const out=[];let cur='';const flush=()=>{const t=cur.trim();if([...t].length>=min)out.push(t);cur='';};for(const c of decode(blob)){if(c==='\n'||c==='\t'||(!isControl(c)&&c!=='�'))cur+=c;else flush();}flush();return out;}
function isSessionMetadata(text){let saw=false;for(const raw of text.split(/\s+/).filter(Boolean)){if(raw.split(/[^0-9a-fA-F-]/).some(p=>p.length>=32&&/^[0-9a-fA-F-]+$/.test(p))){saw=true;continue;}if(raw.replace(/^[^A-Za-z0-9-]+|[^A-Za-z0-9-]+$/g,'').length>2)return false;}return saw;}
function firstFileUrl(blob){const text=decode(blob);const at=text.indexOf('file:///');if(at<0)return null;const rest=text.slice(at+7);const end=rest.search(/[\u0000-\u001f\u007f-\u009f"]/);const p=(end<0?rest:rest.slice(0,end)).trim();return p||null;}

async function agySessions(file,mtime){
 const db=await readonlyDb(file);if(!db)return [];
 const s={session_id:path.basename(file,path.extname(file)),cwd:'',updated:mtime,bodies:[],roles:[]};
 try{
  try{const r=db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();if(r?.data instanceof Uint8Array)s.cwd=firstFileUrl(r.data)??'';}catch{}
  for(const r of db.prepare('SELECT step_payload FROM steps ORDER BY idx LIMIT 500').all()){if(!(r.step_payload instanceof Uint8Array))continue;for(const run of printableRuns(r.step_payload,24)){if(isInjected(run)||isSessionMetadata(run))continue;s.bodies.push(clip(run));s.roles.push('message');}}
 }catch{}finally{try{db.close();}catch{}}
 return s.bodies.length?[s]:[];
}

/** Every conversation in a whole-file store, each with `bodies` and the
 *  parallel `roles` (user / assistant / message) — session-transcript.mjs reads
 *  one conversation's end through this. */
export function wholeSessions(agent,file,roots,mtime){
 if(agent==='gemini')return geminiSessions(file,roots,mtime);
 if(agent==='aider')return aiderSessions(file,mtime);
 if(agent==='opencode')return opencodeSessions(file);
 if(agent==='agy')return agySessions(file,mtime);
 return [];
}

// research.rs / notes.rs index_docs, over the same <home>/.canopy/{research,notes} layout.
const validId=id=>{const i=id.indexOf('-');if(i<0)return false;const num=id.slice(0,i),slug=id.slice(i+1);return /^\d{4}$/.test(num)&&slug.length>0&&slug.length<=64&&/^[a-z0-9-]+$/.test(slug);};
async function storeDocs(home,store){
 const root=path.join(home,'.canopy',store),out=[];let projects;try{projects=await readdir(root,{withFileTypes:true});}catch{return out;}
 for(const p of projects.filter(p=>p.isDirectory())){
  const pdir=path.join(root,p.name);const ref=json(await readFile(path.join(pdir,'project.json'),'utf8').catch(()=>''));
  const fallback=Array.isArray(ref?.roots)&&typeof ref.roots[0]==='string'?ref.roots[0]:'';
  let entries;try{entries=await readdir(pdir,{withFileTypes:true});}catch{continue;}
  for(const e of entries.filter(e=>e.isDirectory()&&validId(e.name))){
   const dir=path.join(pdir,e.name);const meta=json(await readFile(path.join(dir,'meta.json'),'utf8').catch(()=>''));
   if(!meta||typeof meta!=='object'||typeof meta.id!=='string'||typeof meta.status!=='string')continue;
   const str=v=>typeof v==='string'?v:'',list=v=>Array.isArray(v)?v:[];
   const body=await readFile(path.join(dir,store==='research'?'research.md':'note.md'),'utf8').catch(()=>'');
   const tags=list(meta.tags).join(' ');
   const text=store==='research'
    ?[str(meta.question),str(meta.digest),str(meta.recommendation),body,list(meta.sources).map(s=>str(s?.title)).join('\n'),tags].join('\n')
    :[body,str(meta.context),list(meta.attachments).map(a=>str(a?.title)).join('\n'),list(meta.links?.files).map(f=>str(f?.path)).join('\n'),tags].join('\n');
   out.push({project_id:p.name,id:e.name,title:`${str(meta.title)} · ${meta.status}`,body:text,cwd:str(meta.cwd)||fallback,agent:str(meta.agent),dir,ts:Math.max(0,Number.isFinite(meta.updated_at)?Math.trunc(meta.updated_at):0)});
  }
 }
 return out;
}

// ---------- the index ----------
const shardName=(prefix,key)=>prefix+'-'+createHash('sha256').update(key).digest('hex').slice(0,32);
const ROW=['kind','key','agent','cwd','title','body','meta','ts'];
const toRow=d=>JSON.stringify(ROW.map(k=>d[k]));
const fromRow=a=>Object.fromEntries(ROW.map((k,i)=>[k,a[i]]));

class Index{
 constructor(home){this.dir=path.join(home,'.canopy/spot');this.docsDir=path.join(this.dir,'docs');this.sources=new Map();this.shards=new Map();this.vocab=new Map();this.totalTokens=0;this.rows=0;this.loaded=null;this.queue=Promise.resolve();}
 async load(){return this.loaded??=this.read();}
 async read(){
  await mkdir(this.docsDir,{recursive:true,mode:0o700});
  const saved=json(await readFile(path.join(this.dir,'sources.json'),'utf8').catch(()=>''));
  const sources=saved?.version===1&&saved.sources&&typeof saved.sources==='object'?saved.sources:{};
  const wanted=new Set();
  for(const [p,s] of Object.entries(sources)){
   if(typeof s?.shard!=='string'||!/^[a-z]-[0-9a-f]{32}$/.test(s.shard))continue;
   const file=path.join(this.docsDir,s.shard+'.jsonl');let size=0;try{size=(await stat(file)).size;}catch{}
   // The bookmark and its shard are written separately; one that lost the other is re-read from zero.
   if(!Number.isInteger(s.bytes)||size<s.bytes)continue;
   if(size>s.bytes)await truncate(file,s.bytes);
   this.sources.set(p,{agent:String(s.agent??''),offset:Number(s.offset)||0,stamp:Number(s.stamp)||0,shard:s.shard,bytes:s.bytes});wanted.add(s.shard);
  }
  for(const name of await readdir(this.docsDir)){
   const shard=name.replace(/\.jsonl$/,'');
   if(!wanted.has(shard)&&!['research','notes'].includes(shard)){await rm(path.join(this.docsDir,name),{force:true});continue;}
   const raw=await readFile(path.join(this.docsDir,name),'utf8').catch(()=>'');
   const docs=[];for(const l of lines(raw)){const a=json(l);if(Array.isArray(a))docs.push(fromRow(a));}
   this.addDocs(shard,docs);
  }
 }
 // ---- memory ----
 addDocs(shard,docs){
  let list=this.shards.get(shard);if(!list)this.shards.set(shard,list=[]);
  for(const d of docs){
   const tf=new Map();let len=0;for(const t of [...tokens(d.title),...tokens(d.body)]){tf.set(t,(tf.get(t)??0)+1);len++;}
   d.tf=tf;d.len=len;list.push(d);this.totalTokens+=len;this.rows++;
   for(const t of tf.keys()){let set=this.vocab.get(t);if(!set)this.vocab.set(t,set=new Set());set.add(d);}
  }
 }
 dropDocs(shard,pred=()=>true){
  const list=this.shards.get(shard);if(!list)return 0;const keep=[];let n=0;
  for(const d of list){if(!pred(d)){keep.push(d);continue;}n++;this.totalTokens-=d.len;this.rows--;for(const t of d.tf.keys()){const set=this.vocab.get(t);set?.delete(d);if(set&&!set.size)this.vocab.delete(t);}}
  if(keep.length)this.shards.set(shard,keep);else this.shards.delete(shard);
  return n;
 }
 docs(){return [...this.shards.values()].flat();}
 // ---- disk ----
 shardFile(shard){return path.join(this.docsDir,shard+'.jsonl');}
 async writeShard(shard){const docs=this.shards.get(shard)??[];const file=this.shardFile(shard);if(!docs.length){await rm(file,{force:true});return 0;}const data=docs.map(toRow).join('\n')+'\n';const tmp=file+'.'+randomUUID()+'.next';await writeFile(tmp,data,{mode:0o600});await rename(tmp,file);return Buffer.byteLength(data);}
 async dropShard(shard){const n=this.dropDocs(shard);await rm(this.shardFile(shard),{force:true});return n;}
 async saveSources(){const out={};for(const [p,s] of this.sources)out[p]=s;const file=path.join(this.dir,'sources.json');const tmp=file+'.'+randomUUID()+'.next';await writeFile(tmp,JSON.stringify({version:1,sources:out}),{mode:0o600});await rename(tmp,file);}
 async removeSource(p){const s=this.sources.get(p);this.sources.delete(p);return s?this.dropShard(s.shard):0;}
 async clear(){this.sources.clear();this.shards.clear();this.vocab.clear();this.totalTokens=0;this.rows=0;await rm(this.docsDir,{recursive:true,force:true});await rm(path.join(this.dir,'sources.json'),{force:true});await mkdir(this.docsDir,{recursive:true,mode:0o700});}
 async bytes(){let n=0;try{n+=(await stat(path.join(this.dir,'sources.json'))).size;}catch{}try{for(const f of await readdir(this.docsDir))try{n+=(await stat(path.join(this.docsDir,f))).size;}catch{}}catch{}return n;}
 // ---- query ----
 // FTS5 bm25 over title+body: per phrase idf·f·(k1+1)/(f+k1·(1-b+b·|D|/avgdl)), negated (lower is better).
 search(phrases,limit){
  const per=phrases.map(p=>{
   const last=p.at(-1),firsts=p.slice(0,-1);
   const cand=new Set();
   const seed=firsts.length?(this.vocab.get(firsts[0])??new Set()):null;
   if(seed)for(const d of seed)cand.add(d);
   else for(const [t,set] of this.vocab)if(t.startsWith(last))for(const d of set)cand.add(d);
   const hits=new Map();
   for(const d of cand){let f=0;if(p.length===1){for(const [t,n] of d.tf)if(t.startsWith(last))f+=n;}else f=phraseCount(tokens(d.title),p)+phraseCount(tokens(d.body),p);if(f>0)hits.set(d,f);}
   return hits;
  });
  if(!per.length)return [];
  const N=this.rows,avgdl=N?this.totalTokens/N:0;
  const idf=per.map(h=>{const v=Math.log((0.5+N-h.size)/(0.5+h.size));return v<=0?1e-6:v;});
  const smallest=per.reduce((a,b)=>a.size<=b.size?a:b);const out=[];
  for(const d of smallest.keys()){
   if(!per.every(h=>h.has(d)))continue;
   let score=0;per.forEach((h,i)=>{const f=h.get(d);score+=idf[i]*(f*2.2)/(f+1.2*(0.25+0.75*(avgdl?d.len/avgdl:0)));});
   out.push({d,rank:-score});
  }
  out.sort((a,b)=>a.rank-b.rank);return out.slice(0,limit);
 }
}
function phraseCount(toks,p){let n=0;for(let i=0;i+p.length<=toks.length;i++){let ok=true;for(let j=0;j<p.length&&ok;j++)ok=j===p.length-1?toks[i+j].startsWith(p[j]):toks[i+j]===p[j];if(ok)n++;}return n;}

// Approximates snippet(docs, 5, '', '', ' … ', 14): the 14-token stretch of the body
// covering the most distinct query phrases, the hits roughly centred.
export function snippet(body,phrases,size=14){
 const spans=tokenSpans(body);if(!spans.length)return '';const toks=spans.map(s=>s.t);
 const hits=[];phrases.forEach((p,pi)=>{for(let i=0;i+p.length<=toks.length;i++){let ok=true;for(let j=0;j<p.length&&ok;j++)ok=j===p.length-1?toks[i+j].startsWith(p[j]):toks[i+j]===p[j];if(ok)hits.push({i,end:i+p.length,pi});}});
 let start=0;
 if(hits.length){
  hits.sort((a,b)=>a.i-b.i);let best=null;
  for(const h of hits){const inside=hits.filter(x=>x.i>=h.i&&x.end<=h.i+size);const distinct=new Set(inside.map(x=>x.pi)).size;if(!best||distinct>best.distinct||(distinct===best.distinct&&inside.length>best.count))best={h,distinct,count:inside.length,end:Math.max(...inside.map(x=>x.end),h.end)};}
  start=Math.max(0,best.h.i-Math.floor((size-(best.end-best.h.i))/2));
  start=Math.max(0,Math.min(start,spans.length-size));
 }
 const stop=Math.min(spans.length,start+size);
 return (start>0?' … ':'')+body.slice(spans[start].start,spans[stop-1].end)+(stop<spans.length?' … ':'');
}

// ---------- live terminals (runner) ----------
const runnerFetch=(route,init={})=>fetch(RUNNER+route,{...init,headers:{authorization:`Bearer ${process.env.CANOPY_RUNNER_TOKEN??''}`,'content-type':'application/json'},signal:AbortSignal.timeout(5000)});
async function defaultListSessions(){const r=await runnerFetch('/sessions');if(!r.ok)throw Error('runner sessions '+r.status);return r.json();}
async function defaultSessionOutput(id,max){const r=await runnerFetch(`/sessions/${id}/output`,{method:'POST',body:JSON.stringify({max})});if(!r.ok)return null;return (await r.json()).text??null;}
// The runner's summary has no cwd; the shell's own cwd stands in for the desktop's spawn cwd.
async function sessionCwd(s){if(typeof s.cwd==='string')return s.cwd;if(Number.isInteger(s.pid)&&s.pid>0)try{return await readlink(`/proc/${s.pid}/cwd`);}catch{}return '';}

// ---------- commands ----------
const indexes=new Map();
const strings=(v,name,max=256)=>{if(v==null)return undefined;if(!Array.isArray(v)||v.length>max||v.some(x=>typeof x!=='string'||x.length>4096||x.includes('\0')))throw Error(`Invalid ${name}`);return v;};

export function spotIndexCommands(ctx){
 const home=ctx.home;
 const index=indexes.get(home)??new Index(home);indexes.set(home,index);
 const listSessions=ctx.listSessions??defaultListSessions,sessionOutput=ctx.sessionOutput??defaultSessionOutput;
 const scopedRoot=ctx.scopedRoot??(r=>ctx.scoped(r));
 // One operation at a time against the shared index: the desktop holds a mutex for the same reason.
 const serial=fn=>{const next=index.queue.then(fn);index.queue=next.catch(()=>{});return next;};

 async function ingest(args={}){
  const agents=strings(args.agents,'agents')??STORE_AGENTS;
  if(args.terminals!=null&&typeof args.terminals!=='boolean')throw Error('Invalid terminals');
  const wantTerminals=args.terminals??true,roots=strings(args.roots,'roots')??[];
  if(args.retentionDays!=null&&!Number.isFinite(args.retentionDays))throw Error('Invalid retentionDays');
  const retention=Math.max(0,Math.trunc(args.retentionDays??0)),wanted=a=>agents.includes(a);

  let tails=null;
  if(wantTerminals){
   // A runner that cannot be reached leaves the terminal section as it was rather than emptying it.
   try{const list=await listSessions();tails=[];for(const s of Array.isArray(list)?list:[]){if(!Number.isInteger(s?.id))continue;const text=await sessionOutput(s.id,MAX_SCROLLBACK).catch(()=>null);if(typeof text!=='string')continue;tails.push({id:s.id,title:typeof s.title==='string'?s.title:'',cwd:await sessionCwd(s),tail:Buffer.from(text,'utf8')});}}catch{tails=null;}
  }
  const files=await sourceFiles(home,roots,wanted,scopedRoot);

  await index.load();
  let messages=0,terminals=0,pruned=0,more=false,pending=0,budget=INGEST_BUDGET;const now=nowSecs();

  // ---- purges ----
  for(const [p,s] of [...index.sources])if((s.agent!=='terminal'&&!wanted(s.agent))||(s.agent==='terminal'&&!wantTerminals))pruned+=await index.removeSource(p);
  for(const [p,s] of [...index.sources])if(s.agent!=='terminal'&&!await exists(p))pruned+=await index.removeSource(p);
  if(retention>0){const cutoff=now-retention*86400;for(const [p,s] of index.sources){if(s.agent==='terminal')continue;const n=index.dropDocs(s.shard,d=>d.kind==='transcript'&&d.ts>0&&d.ts<cutoff);if(n){pruned+=n;s.bytes=await index.writeShard(s.shard);}}}

  // ---- transcripts ----
  const bookmark=(p,agent,patch)=>{const s=index.sources.get(p)??{agent,offset:0,stamp:0,shard:shardName('t',p),bytes:0};Object.assign(s,{agent},patch);index.sources.set(p,s);return s;};
  for(const f of files){
   let info;try{info=await stat(f.path);}catch{continue;}
   const len=info.size,mtime=mtimeSecs(info);
   if(f.layout==='whole'){
    const stamp=Number(BigInt(len)^(BigInt(mtime)<<20n));
    if(index.sources.get(f.path)?.stamp===stamp)continue;
    if(budget===0){more=true;pending+=len;continue;}
    budget-=Math.min(len,budget);
    const shard=shardName('t',f.path);index.dropDocs(shard);
    const docs=[];
    for(const s of await wholeSessions(f.agent,f.path,roots,mtime))for(const body of s.bodies){if(docs.length>=MAX_WHOLE_BODIES)break;docs.push({kind:'transcript',key:s.session_id,agent:f.agent,cwd:s.cwd,title:'',body,meta:f.path,ts:s.updated>0?s.updated:mtime});}
    index.addDocs(shard,docs);messages+=docs.length;
    const bytes=await index.writeShard(shard);bookmark(f.path,f.agent,{offset:0,stamp,shard,bytes});
   }else{
    let s=index.sources.get(f.path),offset=s?.offset??0;
    if(len<offset){if(s){index.dropDocs(s.shard);s.bytes=await index.writeShard(s.shard);s.offset=0;}offset=0;}
    if(len===offset)continue;
    if(budget===0){more=true;pending+=len-offset;continue;}
    let raw;try{const fh=await open(f.path,'r');try{const want=Math.min(len-offset,budget);const b=Buffer.alloc(want);let read=0;while(read<want){const {bytesRead}=await fh.read(b,read,want-read,offset+read);if(!bytesRead)break;read+=bytesRead;}raw=b.subarray(0,read);}finally{await fh.close();}}catch{continue;}
    budget-=raw.length;
    if(raw.length<len-offset){more=true;pending+=len-offset-raw.length;}
    // Only complete lines: the writer may be mid-append.
    const consumed=raw.lastIndexOf(0x0a)+1;if(!consumed)continue;
    const [sessionId,cwd]=await appendMeta(f.agent,f.path);if(!sessionId)continue;
    const docs=[];for(const line of lines(raw.subarray(0,consumed).toString('utf8'))){const body=appendLineText(f.agent,line);if(body!=null)docs.push({kind:'transcript',key:sessionId,agent:f.agent,cwd,title:'',body,meta:f.path,ts:mtime});}
    s=bookmark(f.path,f.agent,{});
    if(docs.length){index.addDocs(s.shard,docs);const data=docs.map(toRow).join('\n')+'\n';await appendFile(index.shardFile(s.shard),data,{mode:0o600});s.bytes+=Buffer.byteLength(data);}
    s.offset=offset+consumed;messages+=docs.length;
   }
  }

  // ---- terminal scrollback: the terminal docs mirror the live sessions exactly ----
  if(tails){
   const live=new Set(tails.map(t=>'pty:'+t.id));
   for(const [p,s] of [...index.sources])if(s.agent==='terminal'&&!live.has(p)){await index.removeSource(p);pruned++;}
   for(const t of tails){
    const key='pty:'+t.id,stamp=tailStamp(t.tail);
    if((index.sources.get(key)?.offset??-1)===stamp)continue;
    const shard=shardName('p',key);index.dropDocs(shard);
    index.addDocs(shard,[{kind:'terminal',key,agent:'terminal',cwd:t.cwd,title:t.title,body:takeChars(stripAnsi(t.tail.toString('utf8')),MAX_SCROLLBACK),meta:t.cwd,ts:now}]);
    const bytes=await index.writeShard(shard);index.sources.set(key,{agent:'terminal',offset:stamp,stamp:0,shard,bytes});terminals++;
   }
  }

  // ---- research and notes: small, rewritten in place, so replaced whole every call ----
  const research=await storeDocs(home,'research'),notes=await storeDocs(home,'notes');
  index.dropDocs('research');index.addDocs('research',research.map(d=>({kind:'research',key:`${d.project_id}/${d.id}`,agent:d.agent||'research',cwd:d.cwd,title:d.title,body:d.body,meta:d.dir,ts:d.ts})));await index.writeShard('research');
  index.dropDocs('notes');index.addDocs('notes',notes.map(d=>({kind:'note',key:`${d.project_id}/${d.id}`,agent:'note',cwd:d.cwd,title:d.title,body:d.body,meta:d.dir,ts:d.ts})));await index.writeShard('notes');

  await index.saveSources();
  return {more,pending,messages,terminals,research:research.length,notes:notes.length,pruned};
 }

 async function search(args={}){
  if(typeof args.query!=='string'||args.query.length>4096)throw Error('Invalid query');
  if(args.limit!=null&&(!Number.isInteger(args.limit)||args.limit<0||args.limit>0xffffffff))throw Error('Invalid limit');
  const phrases=parseQuery(args.query);if(!phrases.length)return [];
  const cap=args.limit??20,roots=args.allProjects?[]:(strings(args.roots,'roots')??[]),now=nowSecs();
  await index.load();
  const scored=[];
  for(const {d,rank} of index.search(phrases,Math.max(cap*20,200))){
   if(!underRoots(d.cwd,roots))continue;
   const score=rank+agePenalty(d.ts,now);
   const seen=scored.find(x=>x.d.kind===d.kind&&x.d.key===d.key);
   if(seen){if(seen.score>score)seen.score=score;}else scored.push({d,score});
  }
  scored.sort((a,b)=>a.score-b.score);
  return scored.slice(0,cap).map(({d})=>({kind:d.kind,key:d.key,agent:d.agent,cwd:d.cwd,title:d.title,snippet:snippet(d.body,phrases),meta:d.meta,ts:d.ts??0}));
 }

 async function stats(){
  await index.load();const by=new Map(),sessions=new Set();let messages=0,terminals=0;
  for(const d of index.docs()){if(d.kind==='transcript'){messages++;sessions.add(d.key);by.set(d.agent,(by.get(d.agent)??0)+1);}else if(d.kind==='terminal')terminals++;}
  return {messages,sessions:sessions.size,terminals,bytes:await index.bytes(),by_agent:[...by].sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1))};
 }

 // spot.rs spot_save_context_text: <dir>/.canopy/spot/brief-<secs>[-n].md, never overwriting.
 async function saveContextText(args={}){
  if(typeof args.dir!=='string'||!args.dir)throw Error('Invalid dir');
  if(typeof args.text!=='string')throw Error('Invalid text');
  if(Buffer.byteLength(args.text)>MAX_BRIEF)throw Error('briefs are limited to 16 MB');
  let target=await ctx.scoped(args.dir);
  for(const part of ['.canopy','spot']){target=await ctx.scoped(path.join(target,part),true);await mkdir(target,{recursive:true});}
  if(!(await lstat(target)).isDirectory())throw Error('Invalid dir');
  const stamp=nowSecs();
  for(let n=1;n<1000;n++){
   const file=path.join(target,n===1?`brief-${stamp}.md`:`brief-${stamp}-${n}.md`);
   try{await writeFile(file,args.text,{flag:'wx'});return file;}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  throw Error('no free brief name');
 }

 return {
  spot_ingest:args=>serial(()=>ingest(args)),
  spot_search:args=>serial(()=>search(args)),
  spot_index_stats:()=>serial(stats),
  spot_index_clear:()=>serial(async()=>{await index.load();await index.clear();return null;}),
  spot_save_context_text:saveContextText,
 };
}

// Numeric usage only; never return prompt/tool contents or credentials.
import {readdir,stat,open,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {opencodeUsageReader} from './opencode-usage.mjs';
import {WorkspaceProfiles} from './profiles.mjs';
const fields=['input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens'];
const number=value=>Number.isSafeInteger(value)&&value>=0?value:0;
export function freshUsage(agent,id){return {agent,session_id:id,profile:'default',cwd:'',title:null,model:null,input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_creation_tokens:0,cost:null,turns:0,updated:0,supported:true};}
export function foldUsage(row,value){
 if(typeof value.cwd==='string')row.cwd=value.cwd;
 if(typeof value.sessionId==='string')row.session_id=value.sessionId;
 if(row.agent==='claude'&&value.type==='assistant'&&value.message?.usage){
  const message=value.message,usage=message.usage;
  if(typeof message.model==='string')row.model=message.model;
  // CLI streaming may repeat a message with increasing counters.
  row.messages??=new Map();const id=message.id??value.uuid;
  const counts=[number(usage.input_tokens),number(usage.output_tokens),number(usage.cache_read_input_tokens),number(usage.cache_creation_input_tokens)];
  const before=id?row.messages.get(id):null;
  for(let index=0;index<fields.length;index++)row[fields[index]]+=Math.max(0,counts[index]-(before?.[index]??0));
  if(id)row.messages.set(id,counts.map((count,index)=>Math.max(count,before?.[index]??0)));
  if(!before)row.turns++;
 }
 if(row.agent==='codex'){
  const payload=value.payload;
  if(value.type==='session_meta'){if(typeof payload?.id==='string')row.session_id=payload.id;if(typeof payload?.cwd==='string')row.cwd=payload.cwd;}
  if(value.type==='turn_context'&&typeof payload?.model==='string')row.model=payload.model;
  if(value.type==='event_msg'&&payload?.type==='token_count'){
   const total=payload.info?.total_token_usage;
   if(total){row.cache_read_tokens=number(total.cached_input_tokens);row.input_tokens=Math.max(0,number(total.input_tokens)-row.cache_read_tokens);row.output_tokens=number(total.output_tokens);row.turns++;}
   const limits=payload.rate_limits;
   if(limits){const windows=['primary','secondary'].flatMap(key=>{const window=limits[key];if(!window||!Number.isFinite(window.used_percent)||!Number.isFinite(window.window_minutes))return [];const mins=window.window_minutes;return [{label:mins%1440===0?`${mins/1440}d`:mins%60===0?`${mins/60}h`:`${mins}m`,used_percent:window.used_percent,resets_at:window.resets_at??null}];});if(windows.length)row.plan={agent:'codex',profile:'default',plan:limits.plan_type??limits.limit_id??null,windows,credits:limits.credits?.has_credits?limits.credits.balance??null:null,observed:row.updated};}
  }
 }
}
export function agentUsageReader(home='/home/agent'){
 const opencode=opencodeUsageReader(home),cache=new Map(),profiles=new WorkspaceProfiles(home),requested=new Map();let listingAt=0,files=[],inflight,profileStamp='';
 // Bound traversal and retained readers separately. An old directory must not
 // fill the retained 256 slots before an active or recently updated session.
 async function discover(root,agent,depth,profile,candidates){
  if(candidates.length>=4096||depth<0)return;
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  entries.sort((a,b)=>b.name.localeCompare(a.name));
  for(const entry of entries){
   if(candidates.length>=4096)break;
   const target=path.join(root,entry.name);
   if(entry.isDirectory())await discover(target,agent,depth-1,profile,candidates);
   else if(entry.isFile()&&entry.name.endsWith('.jsonl'))candidates.push({path:target,agent,profile});
  }
 }
 async function scan(){
  const inventory=await profiles.list();
  const stamp=JSON.stringify(inventory.map(p=>[p.id,p.root]));
  if(Date.now()-listingAt>=30000||stamp!==profileStamp){
   const candidates=[];
   for(const profile of inventory){
    let root;try{root=await profiles.root(profile.id);}catch{continue;}
    await discover(root+'/.claude/projects','claude',2,profile.id,candidates);
    await discover(root+'/.codex/sessions','codex',4,profile.id,candidates);
   }
   // Explicit footer lookups remain admitted even beyond the inventory cap.
   for(const file of requested.values())if(inventory.some(p=>p.id===file.profile)&&!candidates.some(c=>c.path===file.path))candidates.push(file);
   const recent=[];
   for(let index=0;index<candidates.length;index+=32){
    const batch=await Promise.all(candidates.slice(index,index+32).map(async file=>{
     try{return {...file,modified:(await stat(file.path)).mtimeMs};}catch{return null;}
    }));
    recent.push(...batch.filter(Boolean));
   }
   recent.sort((a,b)=>Number(requested.has(b.path))-Number(requested.has(a.path))||b.modified-a.modified||a.path.localeCompare(b.path));
   files=recent.slice(0,256);listingAt=Date.now();profileStamp=stamp;
   const present=new Set(files.map(file=>file.path));for(const key of cache.keys())if(!present.has(key))cache.delete(key);
   for(const [key,file]of requested)if(!inventory.some(p=>p.id===file.profile))requested.delete(key);
  }
  const rows=[];
  for(const file of files){let info;try{info=await stat(file.path);}catch{continue;}
   let entry=cache.get(file.path);if(!entry||info.ino!==entry.ino||info.size<entry.offset)entry={ino:info.ino,offset:0,row:freshUsage(file.agent,path.basename(file.path,'.jsonl'))};
   entry.row.profile=file.profile;entry.row.updated=Math.floor(info.mtimeMs/1000);
   if(info.size>entry.offset){const handle=await open(file.path,'r');try{const buffer=Buffer.alloc(Math.min(8*1024*1024,info.size-entry.offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,entry.offset);const end=buffer.subarray(0,bytesRead).lastIndexOf(10)+1;if(end){for(const line of buffer.subarray(0,end).toString('utf8').split('\n')){if(line.length>1024*1024)continue;try{foldUsage(entry.row,JSON.parse(line));}catch{/* Incomplete/malformed records never invent usage. */}}entry.offset+=end;}}finally{await handle.close();}}
   entry.row.supported=entry.offset===info.size;cache.set(file.path,entry);if(entry.row.plan)entry.row.plan.profile=file.profile;const {messages,plan,...row}=entry.row;if(row.turns)rows.push(row);
  }
  return [...rows,...await opencode.usage()];
 }
 const usage=()=>{if(!inflight)inflight=scan().finally(()=>{inflight=null;});return inflight;};
 return {usage,opencodeSessionStats:sessionId=>opencode.sessionStats(sessionId),sessionStats:async transcript=>{
  if(typeof transcript!=='string'||!path.isAbsolute(transcript)||!transcript.endsWith('.jsonl'))throw Error('Not a Claude transcript');
  const canonical=await realpath(transcript);
  if(canonical!==path.resolve(transcript))throw Error('Not a Claude transcript');
  const roots=await profiles.list();let permitted=false;
  for(const profile of roots){const root=await profiles.root(profile.id);if(canonical.startsWith(root+'/.claude/projects/')){permitted=true;requested.delete(canonical);requested.set(canonical,{path:canonical,agent:'claude',profile:profile.id});while(requested.size>32)requested.delete(requested.keys().next().value);}}
  if(!permitted)throw Error('Not a Claude transcript');
  if(!cache.has(canonical))listingAt=0;
  await usage();const row=cache.get(canonical)?.row;
  if(!row||row.agent!=='claude')throw Error('Transcript is unavailable');
  return Object.fromEntries(['model',...fields,'turns'].map(key=>[key,row[key]]));
 },plans:async(sessionId=null)=>{
  const result=[];for(const entry of cache.values())if(entry.row.plan&&(!sessionId||entry.row.agent!=='codex'||entry.row.session_id===sessionId))result.push(entry.row.plan);
  try{for(const file of (await readdir(home+'/.canopy/plan-usage')).slice(0,32)){if(!file.endsWith('.json'))continue;const item=JSON.parse(await readFile(home+'/.canopy/plan-usage/'+file,'utf8'));if((!sessionId||item.agent!=='codex'||item.session_id===sessionId)&&['claude','codex','omp','opencode'].includes(item.agent)&&Array.isArray(item.windows))result.push(item);}}catch{}
  const unique=new Map();for(const row of result.sort((a,b)=>(b.observed??0)-(a.observed??0))){const key=row.agent+'/'+row.profile;if(!unique.has(key))unique.set(key,row);}return [...unique.values()];
 }};
}

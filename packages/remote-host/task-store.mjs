// Durable task envelopes and route attempts for a Linux workspace. Mirrors
// src-tauri/src/tasks.rs (SQLite on the desktop) command for command: same
// validation, limits, state machine and error strings. Node 22 has no stable
// SQLite, so each task is a directory under ~/.canopy/tasks/runs/<runId>:
// envelope.json ({envelope, attempts}, rewritten atomically: one file is one
// Rust transaction), transcript.jsonl, events.jsonl, artifacts.jsonl and
// artifacts/<attemptId|envelope>/<artifactId>. One in-process async mutex per
// store serializes every call the way the Rust Mutex<Connection> does.
import {open,readFile,writeFile,appendFile,mkdir,rename,unlink,rm,readdir,lstat} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';

const DEFAULT_ATTEMPT_CAP=3,MAX_ATTEMPT_CAP=8,DEFAULT_LIST=50,MAX_LIST=200,MAX_HISTORY_LIST=1000;
const MAX_GOAL_BYTES=16*1024,MAX_CONTEXT_BYTES=24*1024,MAX_ACCEPTANCE=32,MAX_ACCEPTANCE_BYTES=1024,MAX_POLICY_BYTES=16*1024;
const MAX_TITLE_BYTES=256,MAX_METADATA_BYTES=64*1024,MAX_TRANSCRIPT_BYTES=16*1024,MAX_TRANSCRIPT_LIST=2000,MAX_TRANSCRIPT_ENTRIES=2000;
const MAX_EVENTS_PER_ATTEMPT=1000,MAX_RUN_EVENTS=1000,MAX_EVENT_METADATA_BYTES=16*1024,MAX_ARTIFACT_BYTES=2*1024*1024;
const MAX_ARTIFACTS_PER_ATTEMPT=32,MAX_ARTIFACTS_PER_ENVELOPE=100,MAX_ENVELOPE_ARTIFACT_BYTES=100*1024*1024,MAX_GLOBAL_ARTIFACT_BYTES=1024*1024*1024;
const ACTIVE=['reserved','launching','running','waiting'],TERMINAL=['completed','failed','blocked','interrupted','cancelled'];
const TRANSCRIPT_KINDS=['user','assistant','activity','question','error','route-switch','system'];

export const TASK_STORE_READ_ONLY=['task_artifact_read','task_event_list','task_get','task_get_for_attempt','task_list','task_list_all','task_list_history','task_transcript_list'];

// ---- shared helpers (workflow-store.mjs imports these) ----
export const bytes=value=>Buffer.byteLength(value,'utf8');
export const now=()=>Date.now();
export const randomId=prefix=>`${prefix}_${randomBytes(16).toString('hex')}`;
export const mutex=()=>{let tail=Promise.resolve();return fn=>{const run=tail.then(fn);tail=run.catch(()=>{});return run;};};
export function validId(id,label){if(typeof id!=='string'||!id||id.length>96||!/^[A-Za-z0-9_-]+$/.test(id))throw Error(`invalid ${label}`);}
export function validText(value,max,label,emptyOk=false){if(!emptyOk&&!value.trim())throw Error(`${label} is required`);if(bytes(value)>max)throw Error(`${label} exceeds ${max} bytes`);}
const boundedOpt=(value,max,label)=>{if(value!=null)validText(value,max,label,true);};
export const encode=value=>JSON.stringify(value===undefined?null:value);
export async function atomicWrite(file,data){const temporary=`${file}.${randomUUID()}.tmp`;try{await writeFile(temporary,data,{mode:0o600,flag:'wx'});await rename(temporary,file);}catch(error){await unlink(temporary).catch(()=>{});throw error;}}
export const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
// A torn final line (crash mid-append) is skipped rather than poisoning the ledger.
const readLines=async file=>{let text;try{text=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return [];throw error;}return text.split('\n').flatMap(line=>{if(!line)return [];try{return [JSON.parse(line)];}catch{return [];}});};
// A torn tail gets its own line ended first so the new record stays parseable.
async function appendLine(file,value){
 let lead='';
 try{const handle=await open(file,'r');try{const {size}=await handle.stat();if(size){const last=Buffer.alloc(1);await handle.read(last,0,1,size-1);if(last[0]!==10)lead='\n';}}finally{await handle.close();}}catch(error){if(error.code!=='ENOENT')throw error;}
 await appendFile(file,lead+JSON.stringify(value)+'\n',{mode:0o600});
}

// Tauri deserializes args into typed structs before the command runs; mirror
// that boundary so a wrong type fails instead of being stored.
export const badArgs=(command,key,message)=>Error(`invalid args \`${key}\` for command \`${command}\`: ${message}`);
export function arg(command,args,key,kind){
 const value=args?.[key],optional=kind.endsWith('?'),type=optional?kind.slice(0,-1):kind;
 if(value==null){if(optional||type==='value')return null;throw badArgs(command,key,`command ${command} missing required key ${key}`);}
 return typed(command,key,value,type);
}
function typed(command,key,value,type){
 const fail=expected=>{throw badArgs(command,key,`invalid type: ${Array.isArray(value)?'sequence':value===null?'null':typeof value}, expected ${expected}`);};
 if(type==='string'&&typeof value!=='string')fail('a string');
 if(type==='int'&&!Number.isSafeInteger(value))fail('i64');
 if(type==='uint'&&!(Number.isSafeInteger(value)&&value>=0))fail('usize');
 if(type==='strings'&&!(Array.isArray(value)&&value.every(item=>typeof item==='string')))fail('a sequence of strings');
 return type==='value'?structuredClone(value):value;
}
// spec: {field: 'string'|'string?'|'int?'|'value'|['string',default]|['strings',default]}
export function struct(command,key,value,spec){
 if(value==null||typeof value!=='object'||Array.isArray(value))throw badArgs(command,key,'invalid type: expected struct');
 const out={};
 for(const [field,kind] of Object.entries(spec)){
  const v=value[field];
  if(Array.isArray(kind)){out[field]=v===undefined?structuredClone(kind[1]):typed(command,key,v,kind[0]);continue;}
  if(typeof kind==='function'){if(v===undefined)throw badArgs(command,key,`missing field \`${field}\``);out[field]=kind(v);continue;}
  const optional=kind.endsWith('?'),type=optional?kind.slice(0,-1):kind;
  if(v===undefined||(v===null&&(optional||type==='value'))){if(!optional&&type!=='value')throw badArgs(command,key,`missing field \`${field}\``);out[field]=null;continue;}
  out[field]=typed(command,key,v,type);
 }
 return out;
}
export const clampLimit=(command,args,fallback,max)=>Math.min(Math.max(arg(command,args,'limit','uint?')??fallback,1),max);

const routeSpec={cli:'string',cliVersion:'string?',executableFingerprint:'string?',profileId:'string',requestedProvider:'string?',requestedModel:'string?',requestedEffort:'string?',observedModel:'string?',harnessVersion:'string',promptVersion:'string',toolPolicyVersion:'string',executionMode:'string',selection:'value'};
const route=command=>value=>struct(command,'input',value,routeSpec);

function validateRoute(r){
 validText(r.cli,128,'route cli');validText(r.profileId,256,'route profile');validText(r.harnessVersion,128,'harness version');
 validText(r.promptVersion,128,'prompt version');validText(r.toolPolicyVersion,128,'tool policy version');
 if(!['structured','oneshot','pty'].includes(r.executionMode))throw Error('route execution mode must be structured, oneshot, or pty');
 for(const [field,label] of [['cliVersion','cli version'],['executableFingerprint','executable fingerprint'],['requestedProvider','requested provider'],['requestedModel','requested model'],['requestedEffort','requested effort'],['observedModel','observed model']])boundedOpt(r[field],512,label);
 if(bytes(encode(r.selection))>MAX_POLICY_BYTES)throw Error(`route selection exceeds ${MAX_POLICY_BYTES} bytes`);
}
function validateReserve(i){
 validText(i.kind,64,'task kind');validText(i.projectId,256,'project id');validText(i.componentId,256,'component id');
 validText(i.worktreePath,4096,'worktree path');validText(i.goal,MAX_GOAL_BYTES,'goal');
 validText(i.contextSummary,MAX_CONTEXT_BYTES,'context summary',true);validText(i.riskClass,128,'risk class');boundedOpt(i.title,MAX_TITLE_BYTES,'title');
 if(i.acceptance.length>MAX_ACCEPTANCE)throw Error(`acceptance criteria exceed ${MAX_ACCEPTANCE} items`);
 for(const criterion of i.acceptance)validText(criterion,MAX_ACCEPTANCE_BYTES,'acceptance criterion');
 const cap=i.attemptCap??DEFAULT_ATTEMPT_CAP;
 if(cap<1||cap>MAX_ATTEMPT_CAP)throw Error(`attempt cap must be between 1 and ${MAX_ATTEMPT_CAP}`);
 for(const [field,label] of [['taskClasses','task classes'],['authorityPolicy','authority policy'],['failoverPolicy','failover policy']])if(bytes(encode(i[field]))>MAX_POLICY_BYTES)throw Error(`${label} exceeds ${MAX_POLICY_BYTES} bytes`);
 if(bytes(encode(i.metadata))>MAX_METADATA_BYTES)throw Error(`task metadata exceeds ${MAX_METADATA_BYTES} bytes`);
 validateRoute(i.route);
}

const summaryOf=e=>({runId:e.runId,projectId:e.projectId,componentId:e.componentId,kind:e.kind,title:e.title,status:e.status,attemptCount:e.attemptCount,createdAt:e.createdAt,updatedAt:e.updatedAt,metadata:structuredClone(e.metadata)});
const envelopeOf=e=>({...summaryOf(e),schemaVersion:e.schemaVersion,worktreePath:e.worktreePath,goal:e.goal,acceptance:[...e.acceptance],taskClasses:structuredClone(e.taskClasses),contextSummary:e.contextSummary,riskClass:e.riskClass,authorityPolicy:structuredClone(e.authorityPolicy),failoverPolicy:structuredClone(e.failoverPolicy),deadlineAt:e.deadlineAt,attemptCap:e.attemptCap,baseBaselineId:e.baseBaselineId,lastGreenBaselineId:e.lastGreenBaselineId});
const attemptOf=a=>({attemptId:a.attemptId,runId:a.runId,ordinal:a.ordinal,state:a.state,route:structuredClone(a.route),startedAt:a.startedAt,endedAt:a.endedAt,failureClass:a.failureClass,failureCode:a.failureCode,recoveryFromAttemptId:a.recoveryFromAttemptId});
const detailOf=rec=>({envelope:envelopeOf(rec.envelope),attempts:[...rec.attempts].sort((a,b)=>a.ordinal-b.ordinal).map(attemptOf)});
// json_extract(metadata,'$.history') = 1 matches true and 1; non-objects never match.
const isHistory=m=>!!m&&typeof m==='object'&&!Array.isArray(m)&&(m.history===true||m.history===1);
const newestFirst=(a,b)=>b.envelope.updatedAt-a.envelope.updatedAt||b.envelope.createdAt-a.envelope.createdAt||(a.envelope.runId<b.envelope.runId?-1:1);

const stores=new Map();
/** One store per home so commands and spawn helpers share a mutex and cache. */
export function taskStoreFor(ctx){
 const dir=ctx.home+'/.canopy/tasks';
 let store=stores.get(dir);
 if(!store){store=createTaskStore(dir);stores.set(dir,store);}
 store.pulse=ctx.pulse??store.pulse;
 return store;
}

function createTaskStore(dir){
 const runsDir=dir+'/runs',lock=mutex();
 const runDir=runId=>`${runsDir}/${runId}`;
 const artifactPath=(runId,leaf,id)=>`${runDir(runId)}/artifacts/${leaf}/${id}`;
 // runs: runId -> {rec:{envelope,attempts}, artifacts:[row], transcript?:{count,lastSeq}, events?:{byAttempt:Map,run:n}}
 let runs=null;const attempts=new Map(),artifacts=new Map();let globalBytes=0;
 const self={pulse:null};
 const changed=(projectId,runId)=>{try{self.pulse?.('tasks',projectId,runId);}catch{}};

 async function load(){
  if(runs)return;
  await mkdir(runsDir,{recursive:true,mode:0o700});
  const loaded=new Map();
  for(const name of await readdir(runsDir)){
   const base=runDir(name);
   if(!/^[A-Za-z0-9_-]{1,96}$/.test(name)){if(name.endsWith('.tmp'))await rm(base,{force:true,recursive:true});continue;}
   for(const file of await readdir(base).catch(()=>[]))if(file.endsWith('.tmp'))await rm(base+'/'+file,{force:true});
   let rec;
   try{rec=await readJson(base+'/envelope.json');}
   catch(error){if(error.code==='ENOENT'){await rm(base,{recursive:true,force:true});continue;}throw Error(`task store is unreadable (${name}): ${error.message}`);}
   loaded.set(name,{rec,artifacts:await reconcileArtifacts(name)});
  }
  runs=loaded;
  for(const [runId,entry] of runs){for(const a of entry.rec.attempts)attempts.set(a.attemptId,runId);for(const row of entry.artifacts){artifacts.set(row.id,row);globalBytes+=row.bytes;}}
 }
 // Files and index rows cannot share one commit: drop rows whose file never
 // landed and files whose row never did. Symlinks are removed, never followed.
 async function reconcileArtifacts(runId){
  const index=runDir(runId)+'/artifacts.jsonl',rows=await readLines(index),kept=[],expected=new Set();
  for(const row of rows){
   if(!row||typeof row!=='object')continue;
   try{validId(row.id,'artifact id');validId(row.leaf,'artifact directory');const info=await lstat(artifactPath(runId,row.leaf,row.id));if(info.isFile()){kept.push(row);expected.add(row.leaf+'/'+row.id);}}catch{}
  }
  if(kept.length!==rows.length)await atomicWrite(index,kept.map(row=>JSON.stringify(row)+'\n').join(''));
  const root=runDir(runId)+'/artifacts';
  let leaves=[];try{leaves=await readdir(root,{withFileTypes:true});}catch{}
  for(const leaf of leaves){
   const leafPath=root+'/'+leaf.name;
   if(!leaf.isDirectory()){await rm(leafPath,{force:true});continue;}
   for(const file of await readdir(leafPath,{withFileTypes:true}))if(!file.isFile()||!expected.has(leaf.name+'/'+file.name))await rm(leafPath+'/'+file.name,{force:true,recursive:true});
   if(!(await readdir(leafPath)).length)await rm(leafPath,{recursive:true,force:true});
  }
  return kept;
 }
 // Copy-on-write: the cache only changes once the envelope file has landed.
 async function commit(entry,next){await atomicWrite(runDir(next.envelope.runId)+'/envelope.json',JSON.stringify(next));entry.rec=next;}
 const entryForAttempt=attemptId=>{const runId=attempts.get(attemptId);const entry=runId&&runs.get(runId);if(!entry)throw Error('task attempt not found');const next=structuredClone(entry.rec);return {entry,next,attempt:next.attempts.find(a=>a.attemptId===attemptId),envelope:next.envelope};};
 const entryForRun=runId=>{const entry=runs.get(runId);if(!entry)throw Error('task envelope not found');return entry;};
 const belongs=(entry,attemptId)=>entry.rec.attempts.some(a=>a.attemptId===attemptId);
 const withLock=fn=>lock(async()=>{await load();return fn();});

 async function reserve(input){
  validateReserve(input);
  const runId=randomId('run'),attemptId=randomId('attempt'),at=now();
  const envelope={runId,schemaVersion:1,kind:input.kind,projectId:input.projectId,componentId:input.componentId,worktreePath:input.worktreePath,goal:input.goal,acceptance:input.acceptance,taskClasses:input.taskClasses,contextSummary:input.contextSummary,riskClass:input.riskClass,authorityPolicy:input.authorityPolicy,failoverPolicy:input.failoverPolicy,deadlineAt:input.deadlineAt,attemptCap:input.attemptCap??DEFAULT_ATTEMPT_CAP,status:'running',title:input.title,attemptCount:1,baseBaselineId:null,lastGreenBaselineId:null,createdAt:at,updatedAt:at,settledAt:null,metadata:input.metadata};
  const attempt={attemptId,runId,ordinal:1,state:'reserved',route:input.route,startedAt:null,endedAt:null,failureClass:null,failureCode:null,recoveryFromAttemptId:null,createdAt:at};
  await mkdir(runDir(runId),{recursive:true,mode:0o700});
  const entry={rec:null,artifacts:[]};
  try{await commit(entry,{envelope,attempts:[attempt]});}catch(error){await rm(runDir(runId),{recursive:true,force:true});throw error;}
  runs.set(runId,entry);attempts.set(attemptId,runId);changed(input.projectId,runId);
  return {envelope:summaryOf(envelope),attempt:attemptOf(attempt)};
 }
 async function reserveAttempt(input){
  validId(input.runId,'run id');validateRoute(input.route);
  if(input.recoveryFromAttemptId!=null)validId(input.recoveryFromAttemptId,'recovery attempt id');
  const attemptId=randomId('attempt'),at=now(),entry=entryForRun(input.runId),next=structuredClone(entry.rec),e=next.envelope;
  if(['completed','cancelled'].includes(e.status))throw Error(`task is already ${e.status}`);
  if(e.attemptCount>=e.attemptCap)throw Error(`task attempt cap (${e.attemptCap}) reached`);
  if(next.attempts.some(a=>ACTIVE.includes(a.state)))throw Error('task already has an active attempt');
  if(input.recoveryFromAttemptId!=null&&!belongs(entry,input.recoveryFromAttemptId))throw Error('recovery attempt does not belong to this task');
  const attempt={attemptId,runId:input.runId,ordinal:e.attemptCount+1,state:'reserved',route:input.route,startedAt:null,endedAt:null,failureClass:null,failureCode:null,recoveryFromAttemptId:input.recoveryFromAttemptId,createdAt:at};
  next.attempts.push(attempt);Object.assign(e,{attemptCount:attempt.ordinal,status:'running',updatedAt:at});
  await commit(entry,next);attempts.set(attemptId,input.runId);changed(e.projectId,e.runId);
  return attemptOf(attempt);
 }
 async function startAttempt(attemptId){
  validId(attemptId,'attempt id');
  const at=now(),{entry,next,attempt,envelope:e}=entryForAttempt(attemptId);
  if(!['reserved','launching'].includes(attempt.state))throw Error(`cannot start an attempt in state ${attempt.state}`);
  if(attempt.ordinal!==e.attemptCount)throw Error('cannot start a stale task attempt');
  if(['completed','failed','cancelled'].includes(e.status))throw Error(`task is already ${e.status}`);
  Object.assign(attempt,{state:'running',startedAt:at});Object.assign(e,{status:'running',updatedAt:at});
  await commit(entry,next);changed(e.projectId,e.runId);
  return attemptOf(attempt);
 }
 async function waitAttempt(attemptId){
  validId(attemptId,'attempt id');
  const at=now(),{entry,next,attempt,envelope:e}=entryForAttempt(attemptId);
  if(attempt.state!=='running'||attempt.ordinal!==e.attemptCount)throw Error('only the current running attempt can wait');
  attempt.state='waiting';Object.assign(e,{status:'blocked',updatedAt:at});
  await commit(entry,next);changed(e.projectId,e.runId);
  return attemptOf(attempt);
 }
 async function settleAttempt(input){
  validId(input.attemptId,'attempt id');
  if(!TERMINAL.includes(input.state))throw Error('attempt settlement state is not terminal');
  boundedOpt(input.failureClass,128,'failure class');boundedOpt(input.failureCode,256,'failure code');
  const at=now(),{entry,next,attempt,envelope:e}=entryForAttempt(input.attemptId);
  if(attempt.state===input.state){changed(e.projectId,e.runId);return attemptOf(attempt);}
  if(!ACTIVE.includes(attempt.state))throw Error(`attempt is already ${attempt.state}`);
  if(attempt.ordinal!==e.attemptCount)throw Error('cannot settle a stale task attempt');
  if(['completed','failed','cancelled'].includes(e.status))throw Error(`task is already ${e.status}`);
  Object.assign(attempt,{state:input.state,endedAt:at,failureClass:input.failureClass,failureCode:input.failureCode});
  const status=['completed','blocked','cancelled'].includes(input.state)?input.state:e.attemptCount>=e.attemptCap?'failed':'ready';
  Object.assign(e,{status,updatedAt:at,settledAt:['completed','failed','cancelled'].includes(status)?at:null});
  await commit(entry,next);changed(e.projectId,e.runId);
  return attemptOf(attempt);
 }
 const summaries=(filter,limit)=>[...runs.values()].filter(entry=>filter(entry.rec.envelope)).sort((a,b)=>newestFirst(a.rec,b.rec)).slice(0,limit).map(entry=>summaryOf(entry.rec.envelope));
 async function updateMetadata(runId,metadata){
  validId(runId,'run id');
  if(bytes(encode(metadata))>MAX_METADATA_BYTES)throw Error(`task metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  const entry=entryForRun(runId),next=structuredClone(entry.rec);
  Object.assign(next.envelope,{metadata,updatedAt:now()});
  await commit(entry,next);changed(next.envelope.projectId,runId);
  return summaryOf(next.envelope);
 }
 async function interruptStale(currentInstance){
  validText(currentInstance,256,'app instance');
  const stale=[];
  for(const {rec} of runs.values()){
   const m=rec.envelope.metadata;
   if(!isHistory(m)||m.appInstance===currentInstance)continue; // COALESCE(appInstance,'') != current
   for(const a of rec.attempts)if(ACTIVE.includes(a.state))stale.push(a);
  }
  let settled=0;
  for(const a of stale){
   const waiting=a.state==='waiting';
   try{await settleAttempt({attemptId:a.attemptId,state:waiting?'blocked':'interrupted',failureClass:waiting?'human_required':'route',failureCode:'previous-app-ended'});settled++;}catch{}
  }
  return settled;
 }
 async function remove(runId){
  validId(runId,'run id');
  const entry=entryForRun(runId),e=entry.rec.envelope;
  if(['running','blocked'].includes(e.status))throw Error('a live task cannot be removed from history');
  await unlink(runDir(runId)+'/envelope.json'); // the envelope is the authority; a half-removed dir is swept on load
  runs.delete(runId);
  for(const a of entry.rec.attempts)attempts.delete(a.attemptId);
  for(const row of entry.artifacts){artifacts.delete(row.id);globalBytes-=row.bytes;}
  await rm(runDir(runId),{recursive:true,force:true}).catch(()=>{});
  changed(e.projectId,runId);
 }
 async function clearHistory(){
  let deleted=0;
  for(const {rec} of [...runs.values()])if(isHistory(rec.envelope.metadata)&&!['running','blocked'].includes(rec.envelope.status)){try{await remove(rec.envelope.runId);deleted++;}catch{}}
  return deleted;
 }
 async function transcriptStats(entry,runId){
  if(!entry.transcript){const rows=await readLines(runDir(runId)+'/transcript.jsonl');entry.transcript={count:rows.length,lastSeq:rows.reduce((max,row)=>Math.max(max,row.seq||0),0)};}
  return entry.transcript;
 }
 async function appendTranscript(runId,attemptId,kind,body){
  validId(runId,'run id');if(attemptId!=null)validId(attemptId,'attempt id');
  if(!TRANSCRIPT_KINDS.includes(kind))throw Error('unknown transcript entry kind');
  validText(body,MAX_TRANSCRIPT_BYTES,'transcript entry',true);
  const at=now(),entry=entryForRun(runId);
  if(attemptId!=null&&!belongs(entry,attemptId))throw Error('transcript attempt does not belong to this task');
  const stats=await transcriptStats(entry,runId);
  if(stats.count>=MAX_TRANSCRIPT_ENTRIES)throw Error('task transcript entry cap reached');
  const row={seq:stats.lastSeq+1,runId,attemptId,kind,body,createdAt:at};
  await appendLine(runDir(runId)+'/transcript.jsonl',row);
  stats.count++;stats.lastSeq=row.seq;
  const next=structuredClone(entry.rec);next.envelope.updatedAt=at;
  await commit(entry,next);changed(next.envelope.projectId,runId);
  return row;
 }
 async function eventStats(entry,runId){
  if(!entry.events){const byAttempt=new Map();let run=0;for(const row of await readLines(runDir(runId)+'/events.jsonl')){if(row.attemptId==null)run++;else byAttempt.set(row.attemptId,(byAttempt.get(row.attemptId)??0)+1);}entry.events={byAttempt,run};}
  return entry.events;
 }
 async function appendEvent(input){
  validId(input.runId,'run id');if(input.attemptId!=null)validId(input.attemptId,'attempt id');
  validText(input.kind,128,'event kind');validText(input.source,128,'event source');
  boundedOpt(input.code,256,'event code');boundedOpt(input.confidence,64,'event confidence');
  if(bytes(encode(input.metadata))>MAX_EVENT_METADATA_BYTES)throw Error(`event metadata exceeds ${MAX_EVENT_METADATA_BYTES} bytes`);
  const eventId=randomId('event'),occurredAt=input.occurredAt??now(),entry=entryForRun(input.runId),stats=await eventStats(entry,input.runId);
  if(input.attemptId!=null){
   if(!belongs(entry,input.attemptId))throw Error('event attempt does not belong to this task');
   if((stats.byAttempt.get(input.attemptId)??0)>=MAX_EVENTS_PER_ATTEMPT)throw Error('task attempt event cap reached');
  }else if(stats.run>=MAX_RUN_EVENTS)throw Error('task run event cap reached');
  const event={eventId,runId:input.runId,attemptId:input.attemptId,kind:input.kind,code:input.code,source:input.source,confidence:input.confidence,metadata:input.metadata,occurredAt};
  await appendLine(runDir(input.runId)+'/events.jsonl',event);
  if(input.attemptId!=null)stats.byAttempt.set(input.attemptId,(stats.byAttempt.get(input.attemptId)??0)+1);else stats.run++;
  changed(entry.rec.envelope.projectId,input.runId);
  return event;
 }
 const newest=async(file,limit)=>(await readLines(file)).slice(-limit);
 async function writeArtifact(runId,attemptId,kind,content){
  validId(runId,'run id');if(attemptId!=null)validId(attemptId,'attempt id');
  validText(kind,64,'artifact kind');
  const size=bytes(content);
  if(size>MAX_ARTIFACT_BYTES)throw Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  const id=randomId('artifact'),at=now(),entry=entryForRun(runId);
  if(entry.artifacts.length>=MAX_ARTIFACTS_PER_ENVELOPE)throw Error('task envelope artifact count cap reached');
  if(attemptId!=null){
   if(entry.artifacts.filter(row=>row.attemptId===attemptId).length>=MAX_ARTIFACTS_PER_ATTEMPT)throw Error('task attempt artifact cap reached');
   if(!belongs(entry,attemptId))throw Error('artifact attempt does not belong to this task');
  }
  if(entry.artifacts.reduce((sum,row)=>sum+row.bytes,0)+size>MAX_ENVELOPE_ARTIFACT_BYTES)throw Error('task envelope artifact budget reached');
  if(globalBytes+size>MAX_GLOBAL_ARTIFACT_BYTES)throw Error('global task artifact budget reached');
  const leaf=attemptId??'envelope',leafDir=`${runDir(runId)}/artifacts/${leaf}`;
  for(const part of [runDir(runId)+'/artifacts',leafDir]){
   try{const info=await lstat(part);if(info.isSymbolicLink())throw Error('artifact directory may not be a symlink');if(!info.isDirectory())throw Error('artifact directory is not a directory');}
   catch(error){if(error.code!=='ENOENT')throw error;await mkdir(part,{mode:0o700});}
  }
  const file=artifactPath(runId,leaf,id),row={id,runId,attemptId,kind,bytes:size,createdAt:at,leaf};
  await atomicWrite(file,content);
  try{await appendLine(runDir(runId)+'/artifacts.jsonl',row);}catch(error){await unlink(file).catch(()=>{});throw error;}
  entry.artifacts.push(row);artifacts.set(id,row);globalBytes+=size;
  changed(entry.rec.envelope.projectId,runId);
  return {id,runId,attemptId,kind,bytes:size,createdAt:at};
 }
 async function readArtifact(id){
  validId(id,'artifact id');
  const row=artifacts.get(id);
  if(!row)throw Error('task artifact not found');
  const file=artifactPath(row.runId,row.leaf,row.id);
  if(!(await lstat(file)).isFile())throw Error('artifact path escaped its root');
  return readFile(file,'utf8');
 }
 // Managed-spawn identity (pty.rs spawn_binding/mark_spawned/mark_launch_failed):
 // both ids or neither, and only the current reserved attempt may launch.
 async function spawnBinding(runId,attemptId){
  if(runId==null&&attemptId==null)return null;
  if(runId==null||attemptId==null)throw Error('a task spawn needs both runId and attemptId');
  validId(runId,'run id');validId(attemptId,'attempt id');
  const entry=runs.get(runId),next=entry&&structuredClone(entry.rec),attempt=next?.attempts.find(a=>a.attemptId===attemptId);
  if(!attempt||attempt.state!=='reserved'||attempt.ordinal!==next.envelope.attemptCount||next.envelope.status!=='running')throw Error('task attempt is not the current reserved attempt');
  attempt.state='launching';
  await commit(entry,next);changed(next.envelope.projectId,runId);
  return {runId,attemptId};
 }

 return Object.assign(self,{
  reserve:input=>withLock(()=>reserve(input)),
  reserveAttempt:input=>withLock(()=>reserveAttempt(input)),
  startAttempt:id=>withLock(()=>startAttempt(id)),
  waitAttempt:id=>withLock(()=>waitAttempt(id)),
  settleAttempt:input=>withLock(()=>settleAttempt(input)),
  list:(projectId,limit)=>withLock(()=>{validText(projectId,256,'project id');return summaries(e=>e.projectId===projectId,limit);}),
  get:runId=>withLock(()=>{validId(runId,'run id');const entry=runs.get(runId);return entry?detailOf(entry.rec):null;}),
  getForAttempt:attemptId=>withLock(()=>{validId(attemptId,'attempt id');const entry=runs.get(attempts.get(attemptId));return entry?detailOf(entry.rec):null;}),
  listAll:limit=>withLock(()=>summaries(()=>true,limit)),
  listHistory:limit=>withLock(()=>summaries(e=>isHistory(e.metadata),limit)),
  updateMetadata:(runId,metadata)=>withLock(()=>updateMetadata(runId,metadata)),
  interruptStale:instance=>withLock(()=>interruptStale(instance)),
  delete:runId=>withLock(()=>remove(runId)),
  clearHistory:()=>withLock(()=>clearHistory()),
  appendTranscript:(...a)=>withLock(()=>appendTranscript(...a)),
  transcript:(runId,limit)=>withLock(()=>{validId(runId,'run id');return runs.has(runId)?newest(runDir(runId)+'/transcript.jsonl',limit):[];}),
  appendEvent:input=>withLock(()=>appendEvent(input)),
  events:(runId,limit)=>withLock(()=>{validId(runId,'run id');return runs.has(runId)?newest(runDir(runId)+'/events.jsonl',limit):[];}),
  writeArtifact:(...a)=>withLock(()=>writeArtifact(...a)),
  readArtifact:id=>withLock(()=>readArtifact(id)),
  spawnBinding:(runId,attemptId)=>withLock(()=>spawnBinding(runId,attemptId)),
  markSpawned:binding=>withLock(()=>startAttempt(binding.attemptId)).then(()=>{}),
  markLaunchFailed:binding=>withLock(()=>settleAttempt({attemptId:binding.attemptId,state:'failed',failureClass:'route',failureCode:'process-launch'})).then(()=>{}),
  claimAttemptActive:attemptId=>withLock(()=>{validId(attemptId,'attempt id');const entry=runs.get(attempts.get(attemptId));return !!entry?.rec.attempts.some(a=>a.attemptId===attemptId&&ACTIVE.includes(a.state));}),
 });
}

export function taskStoreCommands(ctx){
 const store=taskStoreFor(ctx);
 const str=(c,a,k)=>arg(c,a,k,'string'),optStr=(c,a,k)=>arg(c,a,k,'string?');
 return {
  task_reserve:async args=>{const c='task_reserve';return store.reserve(struct(c,'input',args?.input,{kind:'string',projectId:'string',componentId:'string',worktreePath:'string',goal:'string',acceptance:['strings',[]],taskClasses:'value',contextSummary:['string',''],riskClass:['string','unknown'],authorityPolicy:'value',failoverPolicy:'value',deadlineAt:'int?',attemptCap:'int?',title:'string?',metadata:'value',route:route(c)}));},
  task_attempt_reserve:async args=>{const c='task_attempt_reserve';return store.reserveAttempt(struct(c,'input',args?.input,{runId:'string',route:route(c),recoveryFromAttemptId:'string?'}));},
  task_attempt_start:async args=>store.startAttempt(str('task_attempt_start',args,'attemptId')),
  task_attempt_settle:async args=>{
   const input=struct('task_attempt_settle','input',args?.input,{attemptId:'string',state:'string',failureClass:'string?',failureCode:'string?'});
   const attempt=await store.settleAttempt(input);
   // tasks.rs also releases context claims held by the attempt; the host has
   // no claim store of its own, so the lead may inject that release.
   await ctx.releaseClaimsForAttempt?.(input.attemptId,'settled');
   return attempt;
  },
  task_attempt_wait:async args=>store.waitAttempt(str('task_attempt_wait',args,'attemptId')),
  task_list:async args=>store.list(str('task_list',args,'projectId'),clampLimit('task_list',args,DEFAULT_LIST,MAX_LIST)),
  task_get:async args=>store.get(str('task_get',args,'runId')),
  task_get_for_attempt:async args=>store.getForAttempt(str('task_get_for_attempt',args,'attemptId')),
  task_list_all:async args=>store.listAll(clampLimit('task_list_all',args,DEFAULT_LIST,MAX_LIST)),
  task_list_history:async args=>store.listHistory(clampLimit('task_list_history',args,DEFAULT_LIST,MAX_HISTORY_LIST)),
  task_update_metadata:async args=>{const c='task_update_metadata';if(!args||!('metadata' in args))throw badArgs(c,'metadata',`command ${c} missing required key metadata`);return store.updateMetadata(str(c,args,'runId'),arg(c,args,'metadata','value'));},
  task_interrupt_stale:async args=>store.interruptStale(str('task_interrupt_stale',args,'currentInstance')),
  task_delete:async args=>{await store.delete(str('task_delete',args,'runId'));return null;},
  task_clear_history:async()=>store.clearHistory(),
  task_transcript_append:async args=>{const c='task_transcript_append';return store.appendTranscript(str(c,args,'runId'),optStr(c,args,'attemptId'),str(c,args,'kind'),str(c,args,'body'));},
  task_transcript_list:async args=>store.transcript(str('task_transcript_list',args,'runId'),clampLimit('task_transcript_list',args,200,MAX_TRANSCRIPT_LIST)),
  task_event_append:async args=>store.appendEvent(struct('task_event_append','input',args?.input,{runId:'string',attemptId:'string?',kind:'string',code:'string?',source:'string',confidence:'string?',metadata:'value',occurredAt:'int?'})),
  task_event_list:async args=>store.events(str('task_event_list',args,'runId'),clampLimit('task_event_list',args,200,MAX_TRANSCRIPT_LIST)),
  task_artifact_write:async args=>{const c='task_artifact_write';return store.writeArtifact(str(c,args,'runId'),optStr(c,args,'attemptId'),str(c,args,'kind'),str(c,args,'content'));},
  task_artifact_read:async args=>store.readArtifact(str('task_artifact_read',args,'id')),
 };
}

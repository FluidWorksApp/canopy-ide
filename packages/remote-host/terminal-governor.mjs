// Per-terminal memory budgets for a Linux workspace: the desktop's
// src-tauri/src/governor.rs policy (states, thresholds, dwell, grants, stops,
// remembered per-CLI defaults and maximums, incidents) over the resident set of
// each agent terminal's process tree, as session-processes.mjs measures it.
//
// Like the desktop, this is a budget, not a cage: it measures, warns, asks the
// person for more room, and stops a terminal when they say so. The workspace's
// own cgroup limit remains the only hard boundary, and the capability says so.
// The IDE has no push channel to a workspace, so state changes queue as events
// the adapter drains (terminal_governor_events) into "terminal:governor".
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';

const MIB=1024*1024,GIB=1024*MIB;
const WARN_NUM=75,REQUEST_NUM=90,CLEAR_NUM=70;
const BREACH_DWELL_MS=10_000,CLEAR_DWELL_MS=10_000,RELIEF_COOLDOWN_MS=10_000;
const INCIDENT_CAP=256,STOP_TOMBSTONE_CAP=128,EVENT_CAP=256;
const GRANT_STEP=512*MIB,GRANT_CHOICES=[GRANT_STEP,2*GRANT_STEP];
const DEFAULTS_CAP=64,MIN_MAX=512*MIB,MAX_MAX=1024*GIB;
export const FALLBACK_POLICY='notify_natively_and_refuse_automatic_grant_pause_or_stop';

export function baseAllowance(total){return total<=12*GIB?GIB:total<24*GIB?GIB+512*MIB:4*GIB;}
const protectedReserve=total=>Math.min(Math.max(3*GIB,Math.floor(total/4)),total);
export const validCliKey=key=>typeof key==='string'&&!!key&&key.length<=192&&(key.startsWith('pkg:')||key.startsWith('bin:'))&&!/[\x00-\x1f\x7f]/.test(key);
const validMax=v=>Number.isSafeInteger(v)&&v>=MIN_MAX&&v<=MAX_MAX&&v%GRANT_STEP===0;
/** governor.rs cli_key: the package when known, else the binary. */
export function cliKeyOf(hint){
 if(!hint)return null;
 const pkg=typeof hint.pkg==='string'&&hint.pkg.trim()?hint.pkg:null;
 let value=String(pkg??hint.bin??'').trim().toLowerCase();
 if(!pkg&&value.endsWith('.exe'))value=value.slice(0,-4);
 const key=`${pkg?'pkg':'bin'}:${value}`;
 return validCliKey(key)&&value?key:null;
}

export const CAPABILITY={platform:'linux',enforcement:'monitor_only',measurement:'resident_set_sum',hard_limit:false,pause:false,soft_limit:false,dynamic_raise:false,mechanism:'none',
 detail:'Each terminal\'s memory is the resident set of its process tree in this workspace. Canopy warns, asks before a terminal grows past its allowance, and can stop it; the workspace\'s own memory limit is the only hard boundary.'};

export class TerminalGovernor{
 constructor({defaultsFile,now=Date.now}){
  this.defaultsFile=defaultsFile;this.now=now;
  this.sessions=new Map();this.incidentsRing=[];this.completedStops=[];this.nextRequest=0;
  this.hostTotal=0;this.hostAvailable=0;this.reserve=0;this.aggregate=0;
  this.events=[];this.eventSeq=0;
  this.defaults=null;this.writes=Promise.resolve();
 }
 // ---- remembered defaults and maximums (one file, both kinds) ----
 async load(){
  if(this.defaults)return this.defaults;
  let raw={};
  try{raw=JSON.parse(await readFile(this.defaultsFile,'utf8'))??{};}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  const pick=(obj,ok)=>Object.fromEntries(Object.entries(obj&&typeof obj==='object'?obj:{}).filter(([k,v])=>validCliKey(k)&&ok(v)).slice(0,DEFAULTS_CAP));
  this.defaults={values:pick(raw.defaults,v=>GRANT_CHOICES.includes(v)),maxima:pick(raw.maxima,validMax)};
  return this.defaults;
 }
 async persist(values,maxima){
  if(Object.keys(values).length>DEFAULTS_CAP||Object.keys(maxima).length>DEFAULTS_CAP)throw Error(`remembered-default store is full (${DEFAULTS_CAP} entries)`);
  await mkdir(this.defaultsFile.slice(0,this.defaultsFile.lastIndexOf('/')),{recursive:true,mode:0o700});
  const temporary=`${this.defaultsFile}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify({defaults:values,maxima}),{mode:0o600,flag:'wx'});await rename(temporary,this.defaultsFile);
 }
 locked(fn){const next=this.writes.catch(()=>{}).then(fn);this.writes=next;return next;}
 async maxima(){const {maxima}=await this.load();return Object.entries(maxima).map(([cli_key,max_allowance_bytes])=>({cli_key,max_allowance_bytes})).sort((a,b)=>a.cli_key<b.cli_key?-1:a.cli_key>b.cli_key?1:0);}
 async setMaximum(cliKey,value){
  const key=String(cliKey??'');
  if(!validCliKey(key))throw Error('invalid agent CLI identity');
  value=value??null;
  if(value!==null&&!validMax(value))throw Error(`agent allowance maximum must be between ${MIN_MAX} and ${MAX_MAX} bytes`);
  return this.locked(async()=>{
   const d=await this.load(),maxima={...d.maxima};
   if(value===null)delete maxima[key];
   else{if(!Object.hasOwn(maxima,key)&&Object.keys(maxima).length>=DEFAULTS_CAP)throw Error(`remembered-default store is full (${DEFAULTS_CAP} entries)`);maxima[key]=value;}
   await this.persist(d.values,maxima);d.maxima=maxima;
   for(const s of this.sessions.values())if(s.cliKey===key){s.max=value;if(s.pending)s.pending.increments=this.choices(s);this.emit('maximum_changed',s);}
   return this.maxima();
  });
 }
 // ---- session arithmetic ----
 uncapped(s){return s.base+s.remembered+s.granted;}
 allowance(s){const u=this.uncapped(s);return s.max==null?u:Math.min(u,s.max);}
 choices(s){return GRANT_CHOICES.filter(inc=>s.max==null||this.uncapped(s)+inc<=s.max);}
 status(s){
  return {id:s.id,budget_generation:s.generation,state:s.state,base_allowance_bytes:s.base,granted_bytes:s.granted,remembered_default_bytes:s.remembered,allowance_bytes:this.allowance(s),max_allowance_bytes:s.max,current_bytes:s.current,peak_bytes:s.peak,ema_bytes:Math.max(0,Math.round(s.ema)),growth_bytes_per_second:s.growth,samples:s.samples,grant_request:s.pending?{...s.pending,increments:[...s.pending.increments]}:null,stop_request_id:`pty-${s.id}-stop-${s.generation}`,cli_key:s.cliKey};
 }
 headroom(){
  let unused=0;for(const s of this.sessions.values())unused+=Math.min(Math.max(0,this.allowance(s)-s.current),s.granted+s.remembered);
  return Math.max(0,this.hostAvailable-this.reserve-unused);
 }
 incident(at,s,event,from,to,detail,allowance){
  this.incidentsRing.push({at_ms:at,id:s.id,event,from,to,current_bytes:s.current,allowance_bytes:allowance??this.allowance(s),detail});
  while(this.incidentsRing.length>INCIDENT_CAP)this.incidentsRing.shift();
 }
 emit(kind,s){this.events.push({seq:++this.eventSeq,event:{kind,status:this.status(s)}});while(this.events.length>EVENT_CAP)this.events.shift();}
 /** Events after `cursor`, for the adapter to replay as "terminal:governor". */
 drain(cursor){
  const from=Number.isSafeInteger(cursor)?cursor:null;
  // A fresh reader starts at the present: old transitions are history, not news.
  if(from===null||from>this.eventSeq)return {cursor:this.eventSeq,events:[]};
  return {cursor:this.eventSeq,events:this.events.filter(e=>e.seq>from).map(e=>e.event)};
 }
 // ---- one sample of every live terminal ----
 async observe(observations,hostTotal,hostAvailable,at=this.now()){
  const {values,maxima}=await this.load();
  this.hostTotal=hostTotal;this.hostAvailable=hostAvailable;this.reserve=protectedReserve(hostTotal);
  this.aggregate=observations.reduce((sum,o)=>sum+o.bytes,0);
  const live=new Set(observations.map(o=>o.id));
  for(const [id,old] of [...this.sessions]){
   if(live.has(id))continue;
   this.sessions.delete(id);const from=old.state;old.state='exited';old.pending=null;old.generation++;
   this.incident(at,old,'session_exited',from,'exited','one-session allowance released; terminal exited');
   if(old.lastStop){this.completedStops.push({applied:old.lastStop,status:this.status(old)});while(this.completedStops.length>STOP_TOMBSTONE_CAP)this.completedStops.shift();}
  }
  for(const o of observations){
   const id=o.id,current=o.bytes;
   let s=this.sessions.get(id);
   if(!s){s={id,generation:1,state:'normal',base:baseAllowance(hostTotal),granted:0,remembered:0,max:o.cliKey&&maxima[o.cliKey]!=null?maxima[o.cliKey]:null,current,peak:current,ema:current,growth:0,samples:0,warnStreak:0,breachSince:null,clearSince:null,lastSample:at,pending:null,lastGrant:null,lastStop:null,reliefSince:null,cliKey:o.cliKey??null,evaluatedCli:null};this.sessions.set(id,s);}
   if(o.cliKey)s.cliKey=o.cliKey;
   if(s.cliKey){
    s.max=maxima[s.cliKey]??null;
    if(s.evaluatedCli!==s.cliKey){
     s.evaluatedCli=s.cliKey;
     const increment=values[s.cliKey];
     if(increment&&s.remembered===0&&s.granted===0){
      const next=this.uncapped(s)+increment;
      const refused=s.max!=null&&next>s.max?'remembered default exceeds the agent allowance maximum':increment>this.headroom()?'remembered default would consume the protected host reserve':null;
      if(refused)this.incident(at,s,'remembered_default_refused',s.state,s.state,refused);
      else{s.remembered=increment;s.generation++;this.incident(at,s,'remembered_default_applied',s.state,s.state,'separately confirmed native CLI default applied',next);this.emit('remembered_default_applied',s);}
     }
    }
   }
   const elapsed=at-s.lastSample;
   if(s.samples>0&&elapsed>0){s.growth=(current-s.current)*1000/elapsed;s.ema=s.ema*0.7+current*0.3;}
   s.samples++;s.current=current;s.peak=Math.max(s.peak,current);s.lastSample=at;
   const allowance=Math.max(1,this.allowance(s));
   if(current>=allowance)s.breachSince??=at;else s.breachSince=null;
   if(current*100<allowance*CLEAR_NUM)s.clearSince??=at;else s.clearSince=null;
   const breach=s.breachSince!=null&&at-s.breachSince>=BREACH_DWELL_MS;
   const clear=s.clearSince!=null&&at-s.clearSince>=CLEAR_DWELL_MS;
   if(current*100>=allowance*WARN_NUM)s.warnStreak=Math.min(255,s.warnStreak+1);else if(current*100<allowance*CLEAR_NUM)s.warnStreak=0;
   let target=s.state;
   if(s.state==='stopping')target='stopping';
   else if(breach)target='over_allowance';
   else if(s.state==='over_allowance'&&!clear)target='over_allowance';
   else if(s.warnStreak>=2&&current*100>=allowance*REQUEST_NUM)target='awaiting_grant';
   else if(s.warnStreak>=2&&current*100>=allowance*WARN_NUM)target='warned';
   else if(clear){
    if(['warned','awaiting_grant','over_allowance'].includes(s.state))target='relief';
    else if(s.state==='relief'&&s.reliefSince!=null&&at-s.reliefSince>=RELIEF_COOLDOWN_MS)target='normal';
   }
   if(target!==s.state){
    const from=s.state;s.state=target;s.generation++;s.pending=null;s.reliefSince=target==='relief'?at:null;
    if(target==='awaiting_grant'||target==='over_allowance'){this.nextRequest++;s.pending={request_id:`pty-${id}-grant-${this.nextRequest}`,budget_generation:s.generation,increments:this.choices(s)};}
    this.incident(at,s,'state_changed',from,target,'governor lifecycle transition',allowance);
    this.emit('state_changed',s);
   }
  }
 }
 snapshot(capability=CAPABILITY){
  return {capability,host_total_bytes:this.hostTotal,host_available_bytes:this.hostAvailable,protected_reserve_bytes:this.reserve,aggregate_terminal_bytes:this.aggregate,grantable_headroom_bytes:this.headroom(),fallback_policy:FALLBACK_POLICY,sessions:[...this.sessions.values()].sort((a,b)=>a.id-b.id).map(s=>this.status(s))};
 }
 incidents(){return this.incidentsRing.map(i=>({...i}));}
 // ---- the person's answers ----
 grant(id,generation,requestId,increment,at=this.now()){
  const s=this.sessions.get(id);if(!s)throw Error(`no monitored terminal ${id}`);
  const last=s.lastGrant;
  if(last&&last.requestId===requestId&&last.generation===generation&&last.increment===increment){
   this.incident(at,s,'grant_idempotent_retry',s.state,s.state,'exact grant retry returned the original outcome');
   return {applied:false,idempotent:true,status:this.status(s)};
  }
  const refusal=!GRANT_CHOICES.includes(increment)?'unsupported grant increment'
   :s.max!=null&&this.uncapped(s)+increment>s.max?'grant would exceed the agent allowance maximum'
   :increment>this.headroom()?'grant would consume the protected host reserve'
   :!s.pending?'terminal is not awaiting a grant'
   :s.pending.request_id!==requestId?'stale grant request'
   :s.pending.budget_generation!==generation?'stale budget generation':null;
  if(refusal){this.incident(at,s,'grant_refused',s.state,s.state,refusal);throw Error(refusal);}
  s.granted+=increment;s.lastGrant={requestId,generation,increment};s.pending=null;
  const from=s.state;s.warnStreak=0;s.generation++;
  if(s.current>=this.allowance(s)){this.nextRequest++;s.pending={request_id:`pty-${id}-grant-${this.nextRequest}`,budget_generation:s.generation,increments:this.choices(s)};s.reliefSince=null;s.state='over_allowance';}
  else{s.reliefSince=at;s.state='relief';}
  this.incident(at,s,'grant_applied',from,s.state,s.state==='over_allowance'?'temporary allowance raised; terminal remains over allowance':'temporary one-session allowance raised');
  this.emit('grant_applied',s);
  return {applied:true,idempotent:false,status:this.status(s)};
 }
 async stop(id,generation,requestId,requestStop,at=this.now()){
  const done=[...this.completedStops].reverse().find(t=>t.applied.requestId===requestId&&t.applied.generation===generation&&t.status.id===id);
  if(done){this.incidentsRing.push({at_ms:at,id,event:'stop_idempotent_retry',from:'exited',to:'exited',current_bytes:done.status.current_bytes,allowance_bytes:done.status.allowance_bytes,detail:'exact stop retry returned the completed outcome'});return {requested:false,idempotent:true,status:done.status};}
  const s=this.sessions.get(id);if(!s)throw Error(`no monitored terminal ${id}`);
  if(s.lastStop&&s.lastStop.requestId===requestId&&s.lastStop.generation===generation){this.incident(at,s,'stop_idempotent_retry',s.state,s.state,'exact stop retry returned the in-flight outcome');return {requested:false,idempotent:true,status:this.status(s)};}
  const refusal=s.state==='stopping'?'terminal is already stopping':requestId!==`pty-${id}-stop-${s.generation}`?'stale stop request':generation!==s.generation?'stale budget generation':null;
  if(refusal){this.incident(at,s,'stop_refused',s.state,s.state,refusal);throw Error(refusal);}
  try{await requestStop(id);}
  catch(error){this.incident(at,s,'stop_refused',s.state,s.state,'PTY graceful-stop request failed');throw Error(`could not request graceful terminal stop: ${error?.message??error}`);}
  const from=s.state;s.state='stopping';s.pending=null;s.reliefSince=null;s.lastStop={requestId,generation};s.generation++;
  this.incident(at,s,'stop_requested',from,'stopping','explicit graceful-stop request accepted');
  this.emit('stop_requested',s);
  return {requested:true,idempotent:false,status:this.status(s)};
 }
 async rememberDefault(id,grantRequestId,grantGeneration,increment,confirmed,at=this.now()){
  if(!confirmed)throw Error('remembering a CLI default requires separate confirmation');
  if(!GRANT_CHOICES.includes(increment))throw Error('unsupported remembered-default increment');
  const s=this.sessions.get(id);if(!s)throw Error(`no monitored terminal ${id}`);
  if(!s.lastGrant)throw Error('remembered default requires a successfully applied grant');
  if(s.lastGrant.requestId!==grantRequestId||s.lastGrant.generation!==grantGeneration||s.lastGrant.increment!==increment)throw Error('remembered default does not match the applied grant');
  const cliKey=s.cliKey;if(!cliKey)throw Error('terminal CLI identity is not known');
  return this.locked(async()=>{
   const d=await this.load();
   const live=()=>this.sessions.get(id)??{id,state:'exited',current:0,base:0,granted:0,remembered:0,max:null};
   if(d.values[cliKey]===increment){const t=live();this.incident(at,t,'remembered_default_idempotent_retry',t.state,t.state,'exact remembered-default retry left native storage unchanged');return {persisted:false,idempotent:true,cli_key:cliKey,increment_bytes:increment};}
   if(!Object.hasOwn(d.values,cliKey)&&Object.keys(d.values).length>=DEFAULTS_CAP)throw Error(`remembered-default store is full (${DEFAULTS_CAP} entries)`);
   const values={...d.values,[cliKey]:increment};
   await this.persist(values,d.maxima);d.values=values;
   const t=live();this.incident(at,t,'remembered_default_persisted',t.state,t.state,'separate confirmation persisted a content-free CLI default');
   return {persisted:true,idempotent:false,cli_key:cliKey,increment_bytes:increment};
  });
 }
}

/** The workspace's own memory: its cgroup limit and use, else the machine's. */
export async function workspaceMemory(read=file=>readFile(file,'utf8')){
 try{
  const limit=Number((await read('/sys/fs/cgroup/memory.max')).trim()),used=Number((await read('/sys/fs/cgroup/memory.current')).trim());
  if(Number.isFinite(limit)&&Number.isFinite(used)&&limit>0)return {total:limit,available:Math.max(0,limit-used)};
 }catch{}
 return {total:os.totalmem(),available:os.freemem()};
}

/** Sample every `intervalMs` (unref'd) once started; `sample()` returns the
 *  live terminals as {id, bytes, cliKey}. A failed sample is skipped. */
export function governorSampler({governor,sample,memory=workspaceMemory,intervalMs=2000}){
 let timer=null,busy=false;
 const tick=async()=>{
  if(busy)return;busy=true;
  try{const [observations,host]=await Promise.all([sample(),memory()]);await governor.observe(observations,host.total,host.available);}
  catch{/* The runner or /proc may be momentarily unavailable. */}
  finally{busy=false;}
 };
 return {
  start(){if(timer)return;timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();void tick();},
  stop(){clearInterval(timer);timer=null;},
  tick,
  get running(){return !!timer;},
 };
}

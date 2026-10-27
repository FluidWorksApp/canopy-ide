// Small desktop commands with a plain workspace meaning (fsx.rs build locks,
// agents.rs session_forget, profiles.rs profile_setup, prwatch.rs
// pr_watch_now, governor.rs settings). The workspace watches no terminal's
// memory one by one — one cgroup limit covers it — so grant/stop/remember
// answer as the desktop does for a terminal it does not monitor, while the
// per-CLI maximums are still kept for when a terminal is.
import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
const MIB=1024*1024,GIB=1024*MIB,STEP=512*MIB,MIN_MAX=512*MIB,MAX_MAX=1024*GIB,DEFAULTS_CAP=64;
export const WORKSPACE_MISC_READ_ONLY=['terminal_governor_incidents','terminal_governor_memory_maxima'];
export function workspaceMiscCommands({home,pulse,setupAgent}){
 const builds=new Map();
 const defaultsFile=home+'/.canopy/terminal-governor-defaults.json';
 const readMaxima=async()=>{try{const value=JSON.parse(await readFile(defaultsFile,'utf8'));return value&&typeof value.maxima==='object'?value.maxima:{};}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return {};throw error;}};
 const listMaxima=maxima=>Object.entries(maxima).map(([cli_key,max_allowance_bytes])=>({cli_key,max_allowance_bytes})).sort((a,b)=>a.cli_key<b.cli_key?-1:a.cli_key>b.cli_key?1:0);
 let writes=Promise.resolve();
 const unmonitored=id=>{throw Error(`no monitored terminal ${id}`);};
 return {
  build_operation_acquire:async({key})=>{
   if(typeof key!=='string'||!key||key.length>512||!/^[A-Za-z0-9:\-_.]+$/.test(key))throw Error('Invalid build operation identity');
   if(builds.has(key))throw Error('An operation is already running for this resource');
   const token=randomBytes(16).toString('hex');builds.set(key,token);return token;
  },
  build_operation_release:async({key,token})=>{if(builds.get(key)!==token)throw Error('Build operation ownership changed');builds.delete(key);},
  session_forget:async({sessionId})=>{
   const id=String(sessionId??'');if(!id||id.includes('/')||id.includes('\\')||id.includes('..'))throw Error('invalid session id');
   const dir=home+'/.canopy/sessions/';
   await unlink(dir+id+'.edits.jsonl').catch(()=>{});
   try{await unlink(dir+id+'.json');}catch(error){if(error.code!=='ENOENT')throw error;}
   pulse?.('sessions','',id);
  },
  profile_setup:async({agent,id})=>setupAgent(agent,id),
  pr_watch_now:async()=>{},
  terminal_governor_incidents:async()=>[],
  terminal_governor_grant:async({id})=>unmonitored(id),
  terminal_governor_stop:async({id})=>unmonitored(id),
  terminal_governor_remember_default:async({id,confirmed})=>{if(!confirmed)throw Error('remembering a CLI default requires separate confirmation');unmonitored(id);},
  terminal_governor_memory_maxima:async()=>listMaxima(await readMaxima()),
  terminal_governor_set_memory_maximum:async({cliKey,maxAllowanceBytes})=>{
   const key=String(cliKey??'');
   if(!key||key.length>192||!(key.startsWith('pkg:')||key.startsWith('bin:'))||/[\x00-\x1f\x7f]/.test(key))throw Error('invalid agent CLI identity');
   const value=maxAllowanceBytes??null;
   if(value!==null&&!(Number.isSafeInteger(value)&&value>=MIN_MAX&&value<=MAX_MAX&&value%STEP===0))throw Error(`agent allowance maximum must be between ${MIN_MAX} and ${MAX_MAX} bytes`);
   const next=writes.catch(()=>{}).then(async()=>{
    const maxima=await readMaxima();
    if(value===null)delete maxima[key];
    else{if(!Object.hasOwn(maxima,key)&&Object.keys(maxima).length>=DEFAULTS_CAP)throw Error(`remembered-default store is full (${DEFAULTS_CAP} entries)`);maxima[key]=value;}
    await mkdir(home+'/.canopy',{recursive:true,mode:0o700});const temporary=`${defaultsFile}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify({maxima}),{mode:0o600,flag:'wx'});await rename(temporary,defaultsFile);
    return listMaxima(maxima);
   });
   writes=next;return next;
  },
 };
}

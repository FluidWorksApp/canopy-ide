// Small desktop commands with a plain workspace meaning (fsx.rs build locks,
// agents.rs session_forget, profiles.rs profile_setup, prwatch.rs
// pr_watch_now, governor.rs). Per-terminal memory budgets are
// terminal-governor.mjs: the host samples each terminal's process tree
// (ctx.governorSampler, started when the IDE first asks) and these commands
// answer with the desktop's shapes.
import {unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {TerminalGovernor} from './terminal-governor.mjs';
export const WORKSPACE_MISC_READ_ONLY=['terminal_governor_incidents','terminal_governor_memory_maxima','terminal_governor_status','terminal_governor_events'];
export function workspaceMiscCommands(ctx){
 const {home,pulse,setupAgent}=ctx;
 const builds=new Map();
 const governor=ctx.terminalGovernor??new TerminalGovernor({defaultsFile:home+'/.canopy/terminal-governor-defaults.json'});
 // Sampling starts with the first question from the IDE, and runs from then on.
 const watching=()=>ctx.governorSampler?.start();
 const stopSession=ctx.stopSession??(async id=>{throw Error(`terminal ${id} cannot be stopped from here`);});
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
  // A watch pass now: provenance rows for any new PR (pr-observer.mjs).
  pr_watch_now:async()=>{await ctx.prObserver?.now();},
  terminal_governor_status:async()=>{watching();return governor.snapshot();},
  /** The adapter's poll: state changes since `cursor`, as "terminal:governor" events. */
  terminal_governor_events:async({cursor}={})=>{watching();return governor.drain(cursor);},
  terminal_governor_incidents:async()=>governor.incidents(),
  terminal_governor_grant:async({id,budgetGeneration,requestId,incrementBytes})=>governor.grant(Number(id),Number(budgetGeneration),String(requestId??''),Number(incrementBytes)),
  terminal_governor_stop:async({id,budgetGeneration,requestId})=>governor.stop(Number(id),Number(budgetGeneration),String(requestId??''),stopSession),
  terminal_governor_remember_default:async({id,grantRequestId,grantBudgetGeneration,incrementBytes,confirmed})=>governor.rememberDefault(Number(id),String(grantRequestId??''),Number(grantBudgetGeneration),Number(incrementBytes),confirmed===true),
  terminal_governor_memory_maxima:async()=>governor.maxima(),
  terminal_governor_set_memory_maximum:async({cliKey,maxAllowanceBytes})=>governor.setMaximum(cliKey,maxAllowanceBytes),
 };
}

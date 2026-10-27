// Canopy hooks for the other agent CLIs the workspace image ships — Cursor,
// Grok, OpenCode, oh-my-pi, Amp and Antigravity — written exactly as the
// desktop's installers write them (setup_cursor_hooks, setup_grok_hooks,
// setup_opencode_plugin, setup_omp_hook, setup_amp_plugin, setup_agy_hooks in
// src-tauri/src/agents.rs). Each registers the lifecycle events Canopy reads
// and the pre-tool hook (or plugin gate) that enforces the Rules panel's gates,
// so a rule stops an agent in a cloud workspace whichever CLI it runs.
// Generated plugin sources come from agent-templates.mjs, which is generated
// from agents.rs itself.
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AGENT_TEMPLATES} from './agent-templates.mjs';

/** The CLIs this module installs, with the binary each ships as. */
export const GATED_CLIS={cursor:'cursor-agent',grok:'grok',opencode:'opencode',omp:'omp',amp:'amp',agy:'agy'};
// The matchers, as agents.rs declares them.
export const CURSOR_GATE_MATCHER='Shell|Write|Read|Delete|WebFetch|MCP';
export const GATE_TOOLS_ANY_MATCHER='Bash|Edit|Write|MultiEdit|Read|WebFetch|mcp__.*';
export const AGY_GATE_MATCHER='run_command|write_to_file|replace_file_content|multi_replace_file_content|view_file|read_url_content|.*canopy_vault.*|.*browser_.*';
const MARKERS=['agent-events.jsonl','canopy-hook','.canopy/'];
const AGY_HOOK_EVENTS=['SessionStart','PreToolUse','PostToolUse','PreInvocation','PostInvocation','Stop'];

const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
const pretty=value=>JSON.stringify(value,null,2);
async function readJson(file){
 let raw;try{raw=await readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return {};throw Error(`${file} could not be read: ${e.message}`);}
 if(!raw.trim())return {};
 let value;try{value=JSON.parse(raw);}catch(e){throw Error(`${file} is not valid JSON: ${e.message}`);}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${file} is not an object`);
 return value;
}
const readText=file=>readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
async function writeAtomic(file,text){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temporary=`${file}.${randomUUID()}.next`;await writeFile(temporary,text,{mode:0o600,flag:'wx'});await rename(temporary,file);
}
/** Write a generated file unless it already says exactly this. */
async function generated(file,source,ok,already){
 if(await readText(file)===source)return already;
 await writeAtomic(file,source);return ok;
}

export function cursorConfig(config,helper){
 const value=structuredClone(config);value.version??=1;
 if(value.hooks==null)value.hooks={};
 if(typeof value.hooks!=='object'||Array.isArray(value.hooks))throw Error('Cursor hooks is not an object');
 const command=signal=>`${quote(helper)} --agent cursor --signal ${signal}`;
 const ours=entry=>MARKERS.some(m=>JSON.stringify(entry).includes(m));
 for(const [event,signal] of [['sessionStart','turn-end'],['beforeSubmitPrompt','turn-start'],['postToolUse','turn-progress'],['postToolUseFailure','turn-progress'],['stop','turn-end'],['sessionEnd','session-end']]){
  const entries=value.hooks[event]??[];if(!Array.isArray(entries))throw Error(`Cursor hook ${event} is not an array`);
  value.hooks[event]=[...entries.filter(e=>!ours(e)),{command:command(signal),timeout:10}];
 }
 const gate=value.hooks.preToolUse??[];if(!Array.isArray(gate))throw Error('Cursor hook preToolUse is not an array');
 value.hooks.preToolUse=[...gate.filter(e=>!ours(e)),{command:`${quote(helper)} --agent cursor --gate`,matcher:CURSOR_GATE_MATCHER,timeout:10}];
 return value;
}

export function grokConfig(helper){
 const handler=signal=>({type:'command',command:`${quote(helper)} --agent grok --signal ${signal}`,timeout:10});
 const group=signal=>({hooks:[handler(signal)]});
 return {hooks:{
  SessionStart:[group('turn-end')],
  UserPromptSubmit:[group('turn-start')],
  PreToolUse:[{matcher:GATE_TOOLS_ANY_MATCHER,hooks:[{type:'command',command:`${quote(helper)} --agent grok`,timeout:10}]}],
  PostToolUse:[group('turn-progress')],
  PostToolUseFailure:[group('turn-progress')],
  Stop:[group('turn-end')],
  StopFailure:[group('turn-end')],
  StopCancelled:[group('turn-end')],
  Notification:[{matcher:'idle_prompt',hooks:[handler('turn-end')]},{matcher:'permission_prompt',hooks:[handler('needs-human-permission')]}],
  SessionEnd:[group('session-end')],
 }};
}

export function agyGroup(helper){
 const command=`${quote(helper)} --agent agy`;
 const handler={type:'command',command,timeout:10};
 const gate={type:'command',command:`${command} --gate`,timeout:10};
 const group={};
 for(const event of AGY_HOOK_EVENTS)group[event]=event==='PreToolUse'?[{matcher:AGY_GATE_MATCHER,hooks:[gate]}]:event==='PostToolUse'?[{matcher:'*',hooks:[handler]}]:[handler];
 return group;
}
/** The user's `enabled: false` on our group is theirs and survives. */
function agyWanted(hooks,helper){const want=agyGroup(helper);if(hooks.canopy&&'enabled' in hooks.canopy)want.enabled=hooks.canopy.enabled;return want;}

export const opencodeSource=helper=>AGENT_TEMPLATES.opencode.replace('__HELPER__',helper);
export const ompSource=helper=>AGENT_TEMPLATES.omp.replace('__HELPER__',helper).replace('__CANOPY_CONTEXT__',JSON.stringify(AGENT_TEMPLATES.sessionContext));
export const ampSource=helper=>AGENT_TEMPLATES.amp.replace('__HELPER__',helper);

const files={
 cursor:root=>path.join(root,'.cursor/hooks.json'),
 grok:root=>path.join(root,'.grok/hooks/canopy.json'),
 opencode:root=>path.join(root,'.config/opencode/plugin/canopy.ts'),
 omp:root=>path.join(root,'.omp/agent/extensions/canopy.ts'),
 // AMP_SETTINGS_FILE relocates settings, not plugin discovery: one global
 // plugin in the home observes every Amp profile.
 amp:(root,home)=>path.join(home,'.config/amp/plugins/canopy.ts'),
 agy:root=>path.join(root,'.gemini/config/hooks.json'),
};

/** Install one CLI's hooks in one config root. Resolves with the message the
 *  desktop reports. */
export async function installGates(agent,root,home,helper){
 const file=files[agent]?.(root,home);if(!file)throw Error(`No Canopy hooks for ${agent}`);
 switch(agent){
  case 'cursor':{
   const next=pretty(cursorConfig(await readJson(file),helper));
   if(await readText(file)===next)return 'Cursor hooks already set up';
   await writeAtomic(file,next);return 'Cursor hooks installed — restart cursor-agent sessions';
  }
  case 'grok':return generated(file,pretty(grokConfig(helper)),'Grok hooks installed — restart grok sessions','Grok hooks already set up');
  case 'opencode':return generated(file,opencodeSource(helper),'OpenCode plugin installed — restart opencode sessions to load it','OpenCode plugin already set up');
  case 'omp':{
   // An older bridge in hooks/ is not auto-discovered; one canonical file.
   const legacy=path.join(root,'.omp/agent/hooks/canopy.ts'),old=await readText(legacy);
   if(old!=null&&MARKERS.some(m=>old.includes(m)))await rm(legacy,{force:true});
   return generated(file,ompSource(helper),'oh-my-pi hook installed — restart omp sessions to load it','oh-my-pi hook already set up');
  }
  case 'amp':return generated(file,ampSource(helper),'Amp plugin installed — restart amp sessions to load it','Amp plugin already set up');
  case 'agy':{
   const hooks=await readJson(file),want=agyWanted(hooks,helper);
   if(JSON.stringify(hooks.canopy)===JSON.stringify(want))return 'Antigravity hooks already set up';
   hooks.canopy=want;await writeAtomic(file,pretty(hooks));return 'Antigravity hooks installed — restart agy sessions to pick them up';
  }
 }
}

/** Whether one config root has exactly the hooks installGates would write. */
export async function gatesInstalled(agent,root,home,helper){
 const file=files[agent]?.(root,home);if(!file)return false;
 try{
  switch(agent){
   case 'cursor':{const raw=await readText(file);if(raw==null)return false;return raw===pretty(cursorConfig(JSON.parse(raw),helper));}
   case 'grok':return await readText(file)===pretty(grokConfig(helper));
   case 'opencode':return await readText(file)===opencodeSource(helper);
   case 'omp':return await readText(file)===ompSource(helper);
   case 'amp':return await readText(file)===ampSource(helper);
   case 'agy':{const hooks=await readJson(file);return JSON.stringify(hooks.canopy)===JSON.stringify(agyWanted(hooks,helper));}
  }
 }catch{return false;}
 return false;
}

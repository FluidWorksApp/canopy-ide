// Every MCP server the workspace's agent CLIs are configured with, folded into
// one list. The Linux counterpart of src-tauri/src/mcp.rs: same registries,
// same identity, same redaction, same per-source enable/remove semantics, read
// from the workspace user's own config files instead of the desktop's.
//
// Discovery is file-only. Nothing is spawned or connected to, and environment
// values are never retained: a row carries variable *names* and redacted argv,
// so there is no credential here that a later mistake could serialize.
//
// Containment: project roots go through the workspace `scoped` check, config
// files must resolve (symlinks included) inside the account home or the
// workspace, and edits only ever target a source rediscovered from the fixed
// registry list below. The renderer cannot name an arbitrary file to rewrite.
import {open,lstat,realpath,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const LIMIT=4*1024*1024;
const DEFAULT_ID='default';
// CLIs whose config a non-default account profile isolates (agent_cli.rs
// profile_isolation). Everything else keeps one config in $HOME.
const PROFILE_CLIS=new Set(['claude','codex','amp','opencode']);
// The workspace launches every agent with CLAUDE_CONFIG_DIR=<root>/.claude, so
// Claude's state file is a child of the config dir for every account here,
// including the default one (runner.mjs, profiles.mjs).
const CLAUDE_STATE='.claude/.claude.json';
export const GLOBAL_REGISTRIES=[
 {agent:'claude',label:'Claude Code',rel:CLAUDE_STATE,key:'mcpServers',dialect:'claude'},
 {agent:'agy',label:'Antigravity',rel:'.gemini/config/mcp_config.json',key:'mcpServers',dialect:'claude'},
 {agent:'agy',label:'Antigravity',rel:'.gemini/settings.json',key:'mcpServers',dialect:'claude'},
 {agent:'opencode',label:'OpenCode',rel:'.config/opencode/opencode.json',key:'mcp',dialect:'opencode'},
 {agent:'amp',label:'Amp',rel:'.config/amp/settings.json',key:'amp.mcpServers',dialect:'claude'},
 {agent:'cursor',label:'Cursor',rel:'.cursor/mcp.json',key:'mcpServers',dialect:'claude'},
 {agent:'windsurf',label:'Windsurf',rel:'.codeium/windsurf/mcp_config.json',key:'mcpServers',dialect:'claude'},
];
export const PROJECT_REGISTRIES=[
 {agent:'claude',label:'Claude Code',rel:'.mcp.json',key:'mcpServers',dialect:'claude'},
 {agent:'cursor',label:'Cursor',rel:'.cursor/mcp.json',key:'mcpServers',dialect:'claude'},
 {agent:'vscode',label:'VS Code',rel:'.vscode/mcp.json',key:'servers',dialect:'claude'},
 {agent:'opencode',label:'OpenCode',rel:'opencode.json',key:'mcp',dialect:'opencode'},
];
const TOML_REGISTRIES=[['codex','Codex','.codex/config.toml'],['grok','Grok','.grok/config.toml']];

// --- Redaction (mirrors mcp.rs) ---------------------------------------------
const SECRET_WORDS=['key','token','secret','password','passwd','auth','credential'];
const SECRET_PREFIXES=['sk-','sk_','pk_','rk_','ghp_','gho_','ghu_','ghs_','github_pat_','xoxb-','xoxp-','xoxa-','xoxr-','AIza','bb_live_','bb_test_','Bearer '];
export const secretish=name=>{const n=String(name).toLowerCase();return SECRET_WORDS.some(w=>n.includes(w));};
const bareSecret=arg=>arg.length>=12&&SECRET_PREFIXES.some(p=>arg.startsWith(p));
function redactArg(arg){const at=arg.indexOf('=');if(at>=0&&secretish(arg.slice(0,at))&&arg.length>at+1)return arg.slice(0,at)+'=***';return bareSecret(arg)?'***':arg;}
export function redactArgs(args){const out=[];let next=false;for(const arg of args){if(next){out.push('***');next=false;continue;}next=arg.startsWith('-')&&!arg.includes('=')&&secretish(arg);out.push(redactArg(arg));}return out;}
// Remote servers routinely carry per-user tokens in the URL itself. The panel
// only needs to recognise the endpoint, so credentials in userinfo and in
// secret-looking query parameters are blanked before the row leaves.
export function redactUrl(raw){
 let url;try{url=new URL(raw);}catch{return raw.split(/[?#]/)[0];}
 if(url.password)url.password='***';else if(url.username&&bareSecret(decodeURIComponent(url.username)))url.username='***';
 for(const [name,value] of [...url.searchParams])if(secretish(name)||bareSecret(value))url.searchParams.set(name,'***');
 return url.href.replaceAll('%2A%2A%2A','***');
}

// --- Identity -----------------------------------------------------------------
function basename(command){const tail=command.split(/[/\\]/).pop().toLowerCase();for(const suffix of ['.exe','.cmd','.bat'])if(tail.endsWith(suffix))return tail.slice(0,-suffix.length);return tail;}
export function normalizeUrl(url){
 const lower=url.trim().toLowerCase(),noQuery=lower.split(/[?#]/)[0];
 const at=noQuery.indexOf('://');const scheme=at<0?'':noQuery.slice(0,at);let rest=at<0?noQuery:noQuery.slice(at+3);
 const user=rest.lastIndexOf('@');if(user>=0)rest=rest.slice(user+1);
 return (scheme?scheme+'://'+rest:rest).replace(/\/+$/,'');
}
export function dedupeKey(endpoint){
 if(endpoint.url!=null)return 'url:'+normalizeUrl(endpoint.url);
 const tokens=[];if(endpoint.command!=null)tokens.push(basename(endpoint.command));
 for(let arg of endpoint.args){arg=arg.trim();if(['-y','--yes','-q','--quiet','--silent'].includes(arg))continue;if(arg.endsWith('@latest'))arg=arg.slice(0,-7);tokens.push(arg.toLowerCase());}
 return 'cmd:'+tokens.join(' ');
}

// --- Dialects -------------------------------------------------------------------
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stringList=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'):[];
// Names only. The values are credentials and the workspace never starts these
// servers from discovery, so they are dropped at parse time.
const keysOf=value=>isObject(value)?Object.keys(value).sort():[];
function parseClaudeEntry(entry){
 if(!isObject(entry))return null;const enabled=typeof entry.enabled==='boolean'?entry.enabled:true;
 if(typeof entry.url==='string')return {transport:entry.type==='sse'?'sse':'http',command:null,args:[],url:entry.url,envKeys:keysOf(entry.headers),enabled};
 if(typeof entry.command!=='string')return null;
 return {transport:'stdio',command:entry.command,args:stringList(entry.args),url:null,envKeys:keysOf(entry.env),enabled};
}
function parseOpenCodeEntry(entry){
 if(!isObject(entry))return null;const enabled=typeof entry.enabled==='boolean'?entry.enabled:true;
 if(typeof entry.url==='string')return {transport:'http',command:null,args:[],url:entry.url,envKeys:keysOf(entry.headers),enabled};
 const [command,...args]=stringList(entry.command);if(command===undefined)return null;
 return {transport:'stdio',command,args,url:null,envKeys:keysOf(entry.environment),enabled};
}
const parseEntry=(entry,dialect)=>dialect==='opencode'?parseOpenCodeEntry(entry):parseClaudeEntry(entry);

// --- Codex TOML, read and edited as text exactly like mcp.rs --------------------
export function tomlTablePath(line){
 const t=line.trim();if(!t.startsWith('[')||!t.endsWith(']'))return null;
 const parts=[];let current='',quote=null;
 for(const ch of t.slice(1,-1)){if(quote){if(ch===quote)quote=null;else current+=ch;}else if(ch==="'"||ch==='"')quote=ch;else if(ch==='.'){parts.push(current);current='';}else current+=ch;}
 parts.push(current);return parts.map(p=>p.trim());
}
const unquote=value=>value.replace(/^["']+|["']+$/g,'');
function tomlValue(raw){
 raw=raw.trim();if(raw.startsWith('[')&&raw.endsWith(']'))return raw.slice(1,-1).split(',').map(item=>unquote(item.trim())).filter(Boolean);
 const value=unquote(raw);return value?[value]:[];
}
export function parseCodexToml(raw){
 const servers=new Map();let table=[];
 for(const line of raw.split(/\r?\n/)){
  const header=tomlTablePath(line);if(header){table=header;continue;}
  const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#')||table.length<2||table[0]!=='mcp_servers')continue;
  const at=trimmed.indexOf('=');if(at<0)continue;
  const key=unquote(trimmed.slice(0,at).trim()),value=trimmed.slice(at+1);
  if(!servers.has(table[1]))servers.set(table[1],{transport:'stdio',command:null,args:[],url:null,envKeys:[],enabled:true});
  const entry=servers.get(table[1]);
  if(table.length===3&&table[2]==='env'){if(!entry.envKeys.includes(key))entry.envKeys.push(key);continue;}
  if(table.length!==2)continue;
  if(key==='command')entry.command=tomlValue(value)[0]??null;
  else if(key==='args')entry.args=tomlValue(value);
  else if(key==='url'){entry.url=tomlValue(value)[0]??null;entry.transport='http';}
  else if(key==='enabled')entry.enabled=value.trim()!=='false';
 }
 return [...servers].filter(([,entry])=>entry.command!=null||entry.url!=null).map(([name,entry])=>[name,{...entry,envKeys:entry.envKeys.sort()}]);
}
export function codexTomlWithSource(existing,name,enabled){
 let inServer=false,sawServer=false,changed=false;const out=[];
 for(const line of existing.split(/\r?\n/)){
  const header=tomlTablePath(line);
  if(header){inServer=header.length>=2&&header[0]==='mcp_servers'&&header[1]===name;sawServer||=inServer;if(inServer&&!enabled){changed=true;continue;}out.push(line);continue;}
  if(inServer){if(!enabled){changed=true;continue;}const at=line.indexOf('=');if(at>=0&&unquote(line.slice(0,at).trim())==='enabled'){changed=true;continue;}}
  out.push(line);
 }
 if(!sawServer)throw Error(`Codex config no longer contains an MCP server named '${name}'`);
 if(!changed)return null;
 while(out.length&&out.at(-1)==='')out.pop();
 return out.length?out.join('\n')+'\n':'';
}

// Claude Code asks before trusting a project's `.mcp.json` server and records
// the answer per project; an unanswered server is neither on nor off.
export function mcpjsonStatus(state,name){
 if(!isObject(state))return 'pending';
 const listed=key=>Array.isArray(state[key])&&state[key].includes(name);
 if(listed('disabledMcpjsonServers'))return 'disabled';
 if(listed('enabledMcpjsonServers')||state.enableAllProjectMcpServers===true)return 'enabled';
 return 'pending';
}
const plainStatus=enabled=>enabled?'enabled':'disabled';

export class Collector{
 constructor(){this.rows=new Map();}
 add(name,endpoint,source){
  const key=dedupeKey(endpoint);
  if(!this.rows.has(key))this.rows.set(key,{key,name,transport:endpoint.transport,command:endpoint.command,args:redactArgs(endpoint.args),url:endpoint.url==null?null:redactUrl(endpoint.url),env_keys:[],sources:[],enabled:false});
  const row=this.rows.get(key);
  for(const envKey of endpoint.envKeys)if(!row.env_keys.includes(envKey))row.env_keys.push(envKey);
  row.env_keys.sort();row.enabled||=source.status==='enabled';row.sources.push(source);
 }
 list(){return [...this.rows.values()];}
}
const isManagedBridge=server=>server.command!=null&&basename(server.command)==='canopy-hook'&&server.args.includes('--mcp');
const within=(base,file)=>file===base||file.startsWith(base+'/');

export class McpRegistry{
 /** @param {{home:string,workspace:string,scoped:(p:string)=>Promise<string>,profiles:{list():Promise<{id:string,root:string}[]>}}} options */
 constructor({home,workspace,scoped,profiles}){this.home=home;this.workspace=workspace;this.scoped=scoped;this.profiles=profiles;this.queue=Promise.resolve();}
 // A config file's text, or null when it is absent. Symlinks are followed only
 // while they stay inside the account home or the workspace.
 async text(file){
  let resolved;try{resolved=await realpath(file);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;}
  const bases=await Promise.all([this.home,this.workspace].map(base=>realpath(base).catch(()=>base)));
  if(!bases.some(base=>within(base,resolved)))throw Error('MCP configuration resolves outside the workspace account');
  const handle=await open(resolved,'r');
  try{const info=await handle.stat();if(!info.isFile())throw Error('MCP configuration is not a file');if(info.size>LIMIT)throw Error('MCP configuration is too large');const buffer=Buffer.alloc(info.size);let length=0;while(length<info.size){const {bytesRead}=await handle.read(buffer,length,info.size-length,null);if(!bytesRead)break;length+=bytesRead;}return buffer.subarray(0,length).toString('utf8');}
  finally{await handle.close();}
 }
 async json(file){const raw=await this.text(file);if(raw==null||!raw.trim())return {};try{return JSON.parse(raw);}catch{throw Error(`${file} is not valid JSON`);}}
 async projectRoots(projectDirs){
  if(projectDirs==null)return [];
  if(!Array.isArray(projectDirs)||projectDirs.length>64||projectDirs.some(dir=>typeof dir!=='string'))throw Error('Choose project component folders');
  const roots=[];for(const dir of projectDirs){const root=await this.scoped(dir);if(!roots.includes(root))roots.push(root);}return roots;
 }
 async readRegistry(collector,file,registry,scope,statusFor,{suffix='',projectDir}={}){
  // One CLI's broken or unreadable config must not empty a list seven feed.
  let config;try{config=await this.json(file);}catch{return;}
  const entries=isObject(config)?config[registry.key]:null;if(!isObject(entries))return;
  for(const [name,entry] of Object.entries(entries)){
   const endpoint=parseEntry(entry,registry.dialect);if(!endpoint)continue;
   collector.add(name,endpoint,{agent:registry.agent,label:`${registry.label} (${scope})${suffix}`,name,config_path:file,scope,status:statusFor(name,endpoint.enabled),...(projectDir?{project_dir:projectDir}:{})});
  }
 }
 async discover(projectDirs){
  const projects=await this.projectRoots(projectDirs);const collector=new Collector();
  for(const {id,root} of await this.profiles.list()){
   const isDefault=id===DEFAULT_ID,suffix=isDefault?'':' · '+id;
   for(const registry of GLOBAL_REGISTRIES){if(!isDefault&&!PROFILE_CLIS.has(registry.agent))continue;await this.readRegistry(collector,path.join(root,registry.rel),registry,'global',(_,enabled)=>plainStatus(enabled),{suffix});}
   for(const [agent,label,rel] of TOML_REGISTRIES){
    if(!isDefault&&!PROFILE_CLIS.has(agent))continue;
    const file=path.join(root,rel);let raw;try{raw=await this.text(file);}catch{continue;}if(raw==null)continue;
    for(const [name,endpoint] of parseCodexToml(raw))collector.add(name,endpoint,{agent,label:`${label} (global)${suffix}`,name,config_path:file,scope:'global',status:plainStatus(endpoint.enabled)});
   }
  }
  if(!projects.length)return collector.list();
  const claudeFile=path.join(this.home,CLAUDE_STATE);let claude={};try{claude=await this.json(claudeFile);}catch{}
  for(const project of projects){
   const state=isObject(claude?.projects)?claude.projects[project]:undefined;
   if(isObject(state?.mcpServers))for(const [name,entry] of Object.entries(state.mcpServers)){
    const endpoint=parseClaudeEntry(entry);if(!endpoint)continue;
    collector.add(name,endpoint,{agent:'claude',label:'Claude Code (project)',name,config_path:claudeFile,scope:'project',status:plainStatus(endpoint.enabled),project_dir:project});
   }
   for(const registry of PROJECT_REGISTRIES){
    const gated=registry.agent==='claude'&&registry.rel==='.mcp.json';
    await this.readRegistry(collector,path.join(project,registry.rel),registry,'project',(name,enabled)=>gated?mcpjsonStatus(state,name):plainStatus(enabled),{projectDir:project});
   }
  }
  return collector.list();
 }
 servers(projectDirs){return this.discover(projectDirs);}
 // Apply the panel's staged selections. Every target is rediscovered first, so
 // a change can only ever name a source this registry list produced.
 update(projectDirs,changes){const work=this.queue.then(()=>this.apply(projectDirs,changes));this.queue=work.catch(()=>{});return work;}
 async apply(projectDirs,changes){
  if(!Array.isArray(changes)||changes.length>256)throw Error('Invalid MCP changes');
  for(const change of changes)if(!isObject(change)||['agent','name','configPath','scope'].some(key=>typeof change[key]!=='string')||typeof change.enabled!=='boolean'||(change.projectDir!=null&&typeof change.projectDir!=='string'))throw Error('Invalid MCP changes');
  const before=await this.discover(projectDirs);const validated=[];
  for(const change of changes){
   let match;for(const server of before){const source=server.sources.find(s=>s.agent===change.agent&&s.name===change.name&&s.config_path===change.configPath&&s.scope===change.scope&&(s.project_dir??null)===(change.projectDir??null));if(source){match={server,source};break;}}
   if(!match)throw Error(`${change.agent} no longer configures an MCP server named '${change.name}' at ${change.configPath} — re-read the configs`);
   if(isManagedBridge(match.server))throw Error("Canopy's context bridge is managed from Settings → Agents");
   if(match.source.status==='pending')throw Error(`${match.source.name} is waiting for approval in ${match.source.label} — approve or reject it from Claude Code`);
   if((match.source.status==='enabled')!==change.enabled)validated.push([match.source,change.enabled]);
  }
  for(const [source,enabled] of validated){if(['codex','grok'].includes(source.agent))await this.setToml(source,enabled);else await this.setJson(source,enabled);}
  return this.discover(projectDirs);
 }
 async setToml(source,enabled){const raw=await this.text(source.config_path);if(raw==null)throw Error(`${source.config_path} could not be read`);const body=codexTomlWithSource(raw,source.name,enabled);if(body!=null)await this.write(source.config_path,body);}
 async setJson(source,enabled){
  const file=source.config_path,config=await this.json(file);let entries;
  if(source.agent==='claude'&&source.scope==='project'&&path.basename(file)==='.claude.json'){
   if(!source.project_dir)throw Error("Claude's project MCP entry has no project directory");
   entries=config?.projects?.[source.project_dir]?.mcpServers;if(!isObject(entries))throw Error(`${file} no longer contains Claude's MCP registry for ${source.project_dir}`);
  }else{const key={opencode:'mcp',amp:'amp.mcpServers',vscode:'servers'}[source.agent]??'mcpServers';entries=config?.[key];if(!isObject(entries))throw Error(`${key} in ${file} is not an object`);}
  if(!Object.hasOwn(entries,source.name))throw Error(`${file} no longer contains an MCP server named '${source.name}'`);
  if(enabled){const entry=entries[source.name];if(!isObject(entry))throw Error(`MCP server '${source.name}' in ${file} is not an object`);if(!('enabled' in entry)&&!('disabled' in entry))return;delete entry.enabled;delete entry.disabled;}
  else delete entries[source.name];
  await this.write(file,JSON.stringify(config,null,2));
 }
 // Replace the file in one step, keeping its mode. The link itself is never
 // replaced: a symlinked config is reported rather than silently detached.
 async write(file,body){
  if(Buffer.byteLength(body)>LIMIT)throw Error('MCP configuration is too large');
  const info=await lstat(file);if(info.isSymbolicLink())throw Error(`${file} is a symlink; edit it from a terminal`);
  const temporary=path.join(path.dirname(file),'.'+path.basename(file)+'.'+randomUUID()+'.next');
  await writeFile(temporary,body,{flag:'wx',mode:info.mode&0o777});
  try{await rename(temporary,file);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
 }
}

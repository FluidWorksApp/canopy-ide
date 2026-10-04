import {access,constants,readFile,mkdir,writeFile,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkspaceProfiles} from './profiles.mjs';
import {installMcp,mcpStatus} from './agent-mcp.mjs';
const EVENTS=['SessionStart','UserPromptSubmit','Stop','SessionEnd','PostToolUse','PermissionRequest'];
export class AgentIntegrations {
 constructor(home,helper='/usr/local/bin/canopy-hook',searchPath=process.env.PATH??''){this.home=home;this.helper=helper;this.searchPath=searchPath;this.queue=Promise.resolve();}
 async cliInstalled(agent){
  if(!['claude','codex'].includes(agent))return false;
  for(const directory of this.searchPath.split(path.delimiter).filter(p=>path.isAbsolute(p))){
   const candidate=path.join(directory,agent);
   try{await access(candidate,constants.X_OK);if((await stat(candidate)).isFile())return true;}catch{}
  }
  return false;
 }
 async settings(root,agent){const file=path.join(root,agent==='claude'?'.claude/settings.json':'.codex/hooks.json');let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;value={};}if(!value||Array.isArray(value)||typeof value!=='object')throw Error('Agent settings must be an object');return {file,value};}
 command(agent){return `'${this.helper.replaceAll("'","'\\''")}' --agent ${agent}`;}
 async installed(agent){if(!['claude','codex'].includes(agent))return false;try{await access(this.helper,constants.X_OK);for(const profile of await new WorkspaceProfiles(this.home).list()){const {value}=await this.settings(profile.root,agent);if(!EVENTS.every(event=>value.hooks?.[event]?.some(entry=>entry.hooks?.some(hook=>hook.type==='command'&&hook.command===this.command(agent)))))return false;}return true;}catch{return false;}}
 async health(agent){const states=await Promise.all((await new WorkspaceProfiles(this.home).list()).map(p=>mcpStatus(p.root,agent,this.helper)));return {agent,cli_installed:await this.cliInstalled(agent),hooks:await this.installed(agent)?'ours':'missing',mcp:states.every(s=>s==='ours')?'ours':states.find(s=>s!=='ours')??'missing'};}
 setup(agent){const work=this.queue.then(()=>this.install(agent));this.queue=work.catch(()=>{});return work;}
 async install(agent){
  if(!['claude','codex'].includes(agent))throw Error('Automatic integration is supported for Claude and Codex');
  await access(this.helper,constants.X_OK);
  const profiles=new WorkspaceProfiles(this.home);const steps=[];
  for(const profile of await profiles.list()){
   try {
   const root=await profiles.root(profile.id);const {file,value}=await this.settings(root,agent);
   value.hooks??={};if(!value.hooks||Array.isArray(value.hooks)||typeof value.hooks!=='object')throw Error('Agent hooks must be an object');
   for(const event of EVENTS){const entries=value.hooks[event]??[];if(!Array.isArray(entries))throw Error(`Invalid ${event} hooks; existing settings preserved`);const command=this.command(agent);if(!entries.some(entry=>entry.hooks?.some(hook=>hook.command===command)))entries.push({hooks:[{type:'command',command}]});value.hooks[event]=entries;}
   await profiles.directory(path.dirname(file));const temporary=file+'.'+randomUUID()+'.next';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,file);
   steps.push({step:profile.id+": hooks",ok:true,message:"Hooks installed"});
   await installMcp(root,agent,this.helper);
   steps.push({step:profile.id+": MCP",ok:true,message:"Canopy MCP registered"});
   }catch(error){steps.push({step:profile.id,ok:false,message:error instanceof SyntaxError?"Configuration is invalid; existing file preserved":String(error.message??error)});}
  }
  const failed=steps.filter(step=>!step.ok);
  return {agent,ok:failed.length===0,steps,summary:failed.length?failed.map(step=>step.step+': '+step.message).join('; '):'Hooks installed. Existing agent sessions must restart to load them.'};
 }
}

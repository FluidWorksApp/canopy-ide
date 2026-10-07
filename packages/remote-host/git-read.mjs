import {realpath} from 'node:fs/promises';
import path from 'node:path';
// Automatic Git inspection must not execute code from a writable shared repo.
export const GIT_READ_COMMANDS=new Set(['status','diff','show','log','rev-parse','branch','for-each-ref','worktree','remote']);
const safety=['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','diff.external=','-c','core.attributesFile=/dev/null'];
export async function safeGitRead(execute,args,options){
 if(!GIT_READ_COMMANDS.has(args[0]))throw Error('Unsupported Git inspection');
 const env={...options.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'0'};
 delete env.GIT_CONFIG_PARAMETERS;delete env.GIT_EXTERNAL_DIFF;
 const {allowedRoot,...rest}=options;const settings={...rest,env};let filters='';
 if(allowedRoot){
  const root=await realpath(allowedRoot),locations=(await execute('git',[...safety,'rev-parse','--show-toplevel','--absolute-git-dir'],settings)).stdout.trim().split('\n');
  if(locations.length!==2)throw Error('Git inspection path is unavailable');
  for(const location of locations){const canonical=await realpath(path.resolve(options.cwd,location));if(canonical!==root&&!canonical.startsWith(root+path.sep))throw Error('Git inspection path is outside the workspace');}
 }
 try{filters=(await execute('git',[...safety,'config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$'],settings)).stdout;}catch(error){if(error.code!==1)throw Error('Git inspection configuration is unavailable');}
 const disabled=[];
 for(const key of filters.split('\0').filter(Boolean)){
  if(!/^[a-zA-Z0-9_.-]+\.(clean|smudge|process|required)$/.test(key))throw Error('Unsupported Git filter configuration');
  disabled.push('-c',key+'='+(key.endsWith('.required')?'false':''));
 }
 const command=[...args];if(['diff','show','log'].includes(command[0]))command.splice(1,0,'--no-ext-diff','--no-textconv');
 return execute('git',[...safety,...disabled,...command],settings);
}

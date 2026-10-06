import {mkdir,writeFile,realpath} from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
// Writes only disposable, per-session facade tokens. HOME and transcript stores
// stay with this member; switching provider accounts does not move history.
export async function prepareSharedAgentLaunch(home,requestId,accounts,{binaries={claude:"/usr/local/bin/claude",codex:"/usr/local/bin/codex",git:"/usr/bin/git"}}={}){
 if(!accounts||typeof accounts!=='object'||Object.keys(accounts).some(k=>!['claude','codex','git'].includes(k)))throw Error('Invalid shared agent launch');
 const root=await realpath(home),directory=path.join(root,'.canopy','shared-agent-launch',createHash('sha256').update(requestId).digest('hex'));
 await mkdir(directory,{recursive:true,mode:0o700});if(await realpath(directory)!==directory)throw Error('Invalid shared agent launch directory');
 for(const [agent,config]of Object.entries(accounts)){
  const url=new URL(config.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||typeof config.token!=='string'||!/^[\w-]{43}$/.test(config.token))throw Error('Invalid shared agent facade');
  if(agent==='git'){
   if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[-\w.]{1,100}$/.test(config.repository)||['.','..'].includes(config.repository.split('/')[1]))throw Error('Invalid shared repository');
   const temporary=path.join(directory,'git.'+randomUUID()+'.next');await writeFile(temporary,'#!/bin/sh\nexec node /opt/canopy/shared-git-launch.mjs '+quote(JSON.stringify(config))+' "$@"\n',{mode:0o700,flag:'wx'});const {rename}=await import('node:fs/promises');await rename(temporary,path.join(directory,'git'));continue;
  }
  const vars=agent==='claude'?['ANTHROPIC_BASE_URL='+url.href,'ANTHROPIC_AUTH_TOKEN='+config.token,'ANTHROPIC_API_KEY=']:['CANOPY_SHARED_CODEX_TOKEN='+config.token];
  const args=agent==='codex'?['-c','model_provider="canopy_shared"','-c','model_providers.canopy_shared.name="Canopy shared account"','-c','model_providers.canopy_shared.base_url='+JSON.stringify(url.href+'/v1'),'-c','model_providers.canopy_shared.env_key="CANOPY_SHARED_CODEX_TOKEN"','-c','model_providers.canopy_shared.wire_api="responses"','-c','model_providers.canopy_shared.requires_openai_auth=false']:[];
  if(typeof binaries[agent]!=='string'||!path.isAbsolute(binaries[agent]))throw Error('Invalid agent executable');
  const script='#!/bin/sh\nexec env '+vars.map(quote).join(' ')+' '+quote(binaries[agent])+' '+args.map(quote).join(' ')+' "$@"\n';
  // Symlink replacement is prohibited; rename a new file over any old entry.
  const temporary=path.join(directory,agent+'.'+randomUUID()+'.next');await writeFile(temporary,script,{mode:0o700,flag:'wx'});const {rename}=await import('node:fs/promises');await rename(temporary,path.join(directory,agent));
 }
 return directory;
}

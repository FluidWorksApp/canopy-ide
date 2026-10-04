import {WorkspaceProfiles} from './profiles.mjs';
import {mkdir,realpath,writeFile,rename,chmod,readFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
export async function completeClaudeAccountSetup(home){
  const directory=path.join(await realpath(home),'.claude');
  if(await realpath(directory)!==directory)throw Error('Credential directory must not be a symlink');
  // Claude's interactive CLI checks onboarding separately from OAuth. Keep
  // the remote settings, project permissions and identity; change only this flag.
  const target=path.join(directory,'.claude.json');let settings={};
  try{
    const info=await lstat(target);
    if(!info.isFile()||info.isSymbolicLink())throw Error('Claude settings must be a regular file');
    if(info.size>1048576)throw Error('Claude settings too large');
    settings=JSON.parse(await readFile(target,'utf8'));
    if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Invalid Claude settings');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  settings.hasCompletedOnboarding=true;
  const temporary=path.join(directory,randomUUID()+'.next');
  await writeFile(temporary,JSON.stringify(settings),{mode:0o600,flag:'wx'});
  await rename(temporary,target);
}
export function validateAgentAccounts(accounts){
  if(!accounts||typeof accounts!=='object'||Array.isArray(accounts)||!Object.keys(accounts).length)throw Error('No agent accounts selected');
  for(const [agent,value] of Object.entries(accounts)){
    if(!['claude','codex'].includes(agent)||!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid agent credentials');
    if(Buffer.byteLength(JSON.stringify(value))>65536)throw Error('Agent credentials too large');
    if(agent==='claude'&&!(typeof value.claudeAiOauth?.accessToken==='string'&&typeof value.claudeAiOauth?.refreshToken==='string'))throw Error('Claude login missing');
    if(agent==='codex'&&!(typeof value.tokens?.access_token==='string'||typeof value.OPENAI_API_KEY==='string'))throw Error('Codex login missing');
  }
}
export async function importAgentAccounts(accounts,home){
  validateAgentAccounts(accounts);
  const root=await realpath(home),imported=[];
  for(const [agent,value] of Object.entries(accounts)){
    const directory=path.join(root,'.'+agent);await mkdir(directory,{recursive:true,mode:0o700});
    if(await realpath(directory)!==directory)throw Error('Credential directory must not be a symlink');
    await chmod(directory,0o700);
    const target=path.join(directory,agent==='claude'?'.credentials.json':'auth.json'),temporary=path.join(directory,randomUUID()+'.next');
    await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temporary,target);
    if(agent==='claude')await completeClaudeAccountSetup(root);
    imported.push(agent);
  }
  return {imported};
}

// Explicit account copy only. Never copy project trust, MCP secrets or history.
export async function importAccountProfiles(items,home,profiles=new WorkspaceProfiles(home)){
 if(!Array.isArray(items)||items.length>32)throw Error('Invalid account profiles');
 const imported=[],skipped=[];
 for(const item of items){
  if(!item||!profiles.valid(item.id)||item.id==='default'||typeof item.label!=='string'||item.label.length>80)throw Error('Invalid account profile');
  validateAgentAccounts(item.accounts);
 }
 for(const item of items){
  if((await profiles.list()).some(p=>p.id===item.id)){skipped.push(item.label);continue;}
  // Create using the original ID; preserve the display label separately.
  await profiles.create(item.id,async root=>{
  await importAgentAccounts(item.accounts,root);
  if(item.claudeIdentity){const identity=item.claudeIdentity;const allowed={};for(const key of ['emailAddress','displayName','accountUuid'])if(typeof identity[key]==='string'&&identity[key].length<=320)allowed[key]=identity[key];
   const file=path.join(root,'.claude/.claude.json');const settings=JSON.parse(await readFile(file,'utf8'));settings.oauthAccount=allowed;await writeFile(file,JSON.stringify(settings),{mode:0o600});}
  });
  await profiles.mutate(async()=>{const r=await profiles.registry();r.profiles.find(p=>p.id===item.id).label=item.label;await profiles.save(r);});
  imported.push(item.label);
 }
 return {imported,skipped};
}

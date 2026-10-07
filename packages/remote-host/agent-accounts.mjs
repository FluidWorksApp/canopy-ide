import {WorkspaceProfiles} from './profiles.mjs';
import {mkdir,realpath,writeFile,rename,chmod,readFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
// Read-modify-write of Claude's state file. Keeps remote settings, project
// permissions and history; changes only the given keys.
async function updateClaudeSettings(home,change){
  const directory=path.join(await realpath(home),'.claude');
  if(await realpath(directory)!==directory)throw Error('Credential directory must not be a symlink');
  const target=path.join(directory,'.claude.json');let settings={};
  try{
    const info=await lstat(target);
    if(!info.isFile()||info.isSymbolicLink())throw Error('Claude settings must be a regular file');
    if(info.size>1048576)throw Error('Claude settings too large');
    settings=JSON.parse(await readFile(target,'utf8'));
    if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Invalid Claude settings');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  change(settings);
  const temporary=path.join(directory,randomUUID()+'.next');
  await writeFile(temporary,JSON.stringify(settings),{mode:0o600,flag:'wx'});
  await rename(temporary,target);
}
// Claude's interactive CLI checks onboarding separately from OAuth.
export const completeClaudeAccountSetup=home=>updateClaudeSettings(home,settings=>{settings.hasCompletedOnboarding=true;});
// The signed-in account Claude shows (and Canopy reads as logged in). Identity only, never a credential.
export function claudeIdentity(identity){
  if(!identity||typeof identity!=='object'||Array.isArray(identity))return null;
  const allowed={};for(const key of ['emailAddress','displayName','accountUuid'])if(typeof identity[key]==='string'&&identity[key].length<=320)allowed[key]=identity[key];
  return Object.keys(allowed).length?allowed:null;
}
export function validateAgentAccounts(accounts){
  if(!accounts||typeof accounts!=='object'||Array.isArray(accounts)||!Object.keys(accounts).length)throw Error('No agent accounts selected');
  for(const [agent,value] of Object.entries(accounts)){
    if(!['claude','codex'].includes(agent)||!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid agent credentials');
    if(Buffer.byteLength(JSON.stringify(value))>65536)throw Error('Agent credentials too large');
    // A cleared login (empty tokens) is not a login: copying it would overwrite a working cloud copy.
    const filled=v=>typeof v==='string'&&v.length>0;
    if(agent==='claude'&&!(filled(value.claudeAiOauth?.accessToken)&&filled(value.claudeAiOauth?.refreshToken)))throw Error('Claude login missing');
    if(agent==='codex'&&!(filled(value.tokens?.access_token)||filled(value.OPENAI_API_KEY)))throw Error('Codex login missing');
  }
}
export async function importAgentAccounts(accounts,home,{claudeIdentity:identity}={}){
  validateAgentAccounts(accounts);const oauthAccount=claudeIdentity(identity);
  const root=await realpath(home),imported=[];
  for(const [agent,value] of Object.entries(accounts)){
    const directory=path.join(root,'.'+agent);await mkdir(directory,{recursive:true,mode:0o700});
    if(await realpath(directory)!==directory)throw Error('Credential directory must not be a symlink');
    await chmod(directory,0o700);
    const target=path.join(directory,agent==='claude'?'.credentials.json':'auth.json'),temporary=path.join(directory,randomUUID()+'.next');
    await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temporary,target);
    if(agent==='claude')await updateClaudeSettings(root,settings=>{settings.hasCompletedOnboarding=true;if(oauthAccount)settings.oauthAccount=oauthAccount;});
    imported.push(agent);
  }
  return {imported};
}

// Explicit account copy only. Never copy project trust, MCP secrets or history.
// A re-sync replaces an existing profile's login files: the Mac's copy is the
// newest after a refresh-token rotation, so keeping the cloud copy strands it.
export async function importAccountProfiles(items,home,profiles=new WorkspaceProfiles(home)){
 if(!Array.isArray(items)||items.length>32)throw Error('Invalid account profiles');
 const imported=[],updated=[];
 for(const item of items){
  if(!item||!profiles.valid(item.id)||item.id==='default'||typeof item.label!=='string'||item.label.length>80)throw Error('Invalid account profile');
  validateAgentAccounts(item.accounts);
 }
 for(const item of items){
  const options={claudeIdentity:item.claudeIdentity};
  if((await profiles.list()).some(p=>p.id===item.id)){await importAgentAccounts(item.accounts,await profiles.root(item.id),options);updated.push(item.label);}
  // Create using the original ID; preserve the display label separately.
  else{await profiles.create(item.id,root=>importAgentAccounts(item.accounts,root,options));imported.push(item.label);}
  await profiles.mutate(async()=>{const r=await profiles.registry();const entry=r.profiles.find(p=>p.id===item.id);if(entry.label!==item.label){entry.label=item.label;await profiles.save(r);}});
 }
 return {imported,updated,skipped:[]};
}

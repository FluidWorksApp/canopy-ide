import {open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateConfig} from './policy.mjs';

// Only management-owned retained metadata is reused. New lifecycle intent,
// limits, signing keys and principals always come from the control plane.
export function mergeRetainedHostConfig(incoming,retained){
 validateConfig(incoming);
 if(!retained)return structuredClone(incoming);
 validateConfig(retained);
 if(incoming.managedSession?.workspaceId!==retained.managedSession?.workspaceId||
    !incoming.managedSession||incoming.workspaces.length!==retained.workspaces.length)throw Error('Retained workspace identity differs');
 const previous=new Map(retained.workspaces.map(w=>[w.id,w]));
 const merged=structuredClone(incoming);
 for(const workspace of merged.workspaces){
  const old=previous.get(workspace.id);
  if(!old||old.memberId||old.parentWorkspaceId)throw Error('Retained workspace identity differs');
  if(!Number.isSafeInteger(workspace.generation)||workspace.generation<Number(old.generation??0))throw Error('Workspace generation regressed');
  for(const key of ['projectMounts','ownerImage','accounts'])if(old[key]!==undefined)workspace[key]=structuredClone(old[key]);
  for(const field of ['cgroupParent','sharingCgroupParent'])if(old[field]!==undefined){
   if(typeof old[field]!=='string'||!/^canopy-[a-f0-9]{24}\.slice$/.test(old[field]))throw Error('Invalid retained capacity group');
   workspace[field]=old[field];
  }
 }
 return validateConfig(merged);
}

async function readTrusted(path){
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 try{
  const info=await file.stat();
  if(!info.isFile()||info.size>1024*1024||(info.mode&0o077)!==0||![0,process.getuid?.()].includes(info.uid))throw Error('Unsafe retained host configuration');
  return JSON.parse(await file.readFile('utf8'));
 }finally{await file.close();}
}
export async function persistRetainedHostConfig(path,incoming){
 const retained=await readTrusted(path);
 const merged=mergeRetainedHostConfig(incoming,retained);
 const temporary=path+'.'+randomUUID()+'.tmp';
 let file;
 try{
  file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(merged));await file.sync();await file.close();file=null;
  await rename(temporary,path);
  const parent=await open(dirname(path),'r');try{await parent.sync();}finally{await parent.close();}
 }finally{if(file)await file.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return merged;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Host configuration bootstrap requires management root');
 const incoming=JSON.parse(Buffer.from(process.argv[3]??'','base64').toString('utf8'));
 await persistRetainedHostConfig(process.argv[2],incoming);
}

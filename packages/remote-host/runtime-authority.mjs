import {createHmac} from 'node:crypto';
import {workspaceImageReference} from './image-release.mjs';
export function runtimeAuthority(endpoint,managed,{fetchImpl=fetch,now=Date.now}={}){
 if(!endpoint)return undefined;
 const url=new URL(endpoint);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/api/runtime-policy'||typeof managed?.key!=='string'||managed.key.length<32)throw Error('Invalid runtime policy authority');
 const observe=async workspace=>{
  if(workspace.id!==managed.workspaceId||!Number.isSafeInteger(workspace.generation)||workspace.generation<0)return null;
  try{
   const claims={version:3,kind:'runtime-policy',workspaceId:workspace.id,generation:workspace.generation,expires:Math.floor(now()/1000)+60};
   const payload=Buffer.from(JSON.stringify(claims)).toString('base64url'),signature=createHmac('sha256',managed.key).update(payload).digest('base64url');
   const response=await fetchImpl(url.href,{method:'POST',headers:{authorization:`Bearer ${payload}.${signature}`},redirect:'error',signal:AbortSignal.timeout(3000)});
   if(!response.ok||!response.body)return null;
   const reader=response.body.getReader(),chunks=[];let length=0;
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4096){await reader.cancel();return null;}chunks.push(Buffer.from(value));}
   const result=JSON.parse(Buffer.concat(chunks).toString());
   return result.allowed===true&&result.workspaceId===workspace.id&&result.generation===workspace.generation?result:null;
  }catch{return null;}
 };
 const authorize=async workspace=>Boolean(await observe(workspace));
 // Only management-owned HTTPS policy can select a fresh immutable release.
 authorize.release=async workspace=>{
  const result=await observe(workspace);
  if(!result||typeof result.image!=='string'||!result.image.includes('@sha256:'))throw Error('Current workspace release is unavailable');
  return workspaceImageReference(result.image);
 };
 return authorize;
}

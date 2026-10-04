import {validateGitIdentity} from './git-identity.mjs';
import {validateProjectAccess} from './project-mounts.mjs';
// This endpoint is set by trusted provisioning, never by a development container.
export function memberAuthority(endpoint,{fetchImpl=fetch}={}){
 if(!endpoint)return undefined;
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||url.pathname!=='/api/member-access')throw Error('Invalid member authority');
 return async(principal,bearer)=>{
  if(typeof bearer!=='string'||!bearer.startsWith('Bearer '))return false;
  try{
   const response=await fetchImpl(url.href,{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(3000)});
   if(!response.ok)return false;
   // Bounded read: a compromised or misconfigured endpoint cannot exhaust memory.
   const reader=response.body.getReader();let length=0;const chunks=[];
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>32768){await reader.cancel();return false;}chunks.push(Buffer.from(value));}
   const result=JSON.parse(Buffer.concat(chunks).toString());
   if(!(result.allowed===true&&result.workspaceId===principal.workspaceId&&result.memberId===principal.memberId&&result.accessVersion===principal.accessVersion&&result.scope===principal.scope))return false;
   return result.projectAccess ? {projectAccess:validateProjectAccess(result.projectAccess),...(result.gitIdentity?{gitIdentity:validateGitIdentity(result.gitIdentity)}:{})} : true;
  }catch{return false;}
 };
}

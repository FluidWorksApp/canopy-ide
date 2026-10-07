import {validateGitIdentity} from './git-identity.mjs';
import {validateSharedResourceAccess} from './credential-authority.mjs';
import {validateProjectAccess} from './project-mounts.mjs';
import {validateSessionAccess} from './shared-sessions.mjs';
// This endpoint is set by trusted provisioning, never by a development container.
// The control plane can take seconds to answer, so a slow answer is not a denial.
// Every member request is checked, so an allowed answer is reused for the same
// credential for a short time (never past its expiry); denials are never cached.
export function memberAuthority(endpoint,{fetchImpl=fetch,timeoutMs=30_000,cacheMs=30_000,now=Date.now}={}){
 if(!endpoint)return undefined;
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||url.pathname!=='/api/member-access')throw Error('Invalid member authority');
 const allowed=new Map(),pending=new Map();
 const check=async(principal,bearer)=>{
  try{
   const response=await fetchImpl(url.href,{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok)return false;
   // Bounded read: a compromised or misconfigured endpoint cannot exhaust memory.
   const reader=response.body.getReader();let length=0;const chunks=[];
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>32768){await reader.cancel();return false;}chunks.push(Buffer.from(value));}
   const result=JSON.parse(Buffer.concat(chunks).toString());
   if(!(result.allowed===true&&result.workspaceId===principal.workspaceId&&result.memberId===principal.memberId&&result.accessVersion===principal.accessVersion&&result.scope===principal.scope))return false;
   return result.projectAccess ? {projectAccess:validateProjectAccess(result.projectAccess),...(result.gitIdentity?{gitIdentity:validateGitIdentity(result.gitIdentity)}:{}),...(result.sharedAccess?{sharedAccess:validateSharedResourceAccess(result.sharedAccess)}:{}),...(result.sessionAccess?{sessionAccess:validateSessionAccess(result.sessionAccess)}:{})} : true;
  }catch{return false;}
 };
 return async(principal,bearer)=>{
  if(typeof bearer!=='string'||!bearer.startsWith('Bearer '))return false;
  const key=JSON.stringify([bearer,principal.workspaceId,principal.memberId,principal.accessVersion,principal.scope]),at=now();
  for(const [k,entry] of allowed)if(entry.expires<=at)allowed.delete(k);
  const cached=allowed.get(key);if(cached)return cached.result;
  if(pending.has(key))return pending.get(key);
  const run=check(principal,bearer).then(result=>{
   const expires=Math.min(now()+cacheMs,Number.isFinite(principal.expiresAt)?principal.expiresAt:0);
   if(result&&expires>now()){if(allowed.size>=512)allowed.delete(allowed.keys().next().value);allowed.set(key,{result,expires});}
   return result;
  }).finally(()=>pending.delete(key));
  pending.set(key,run);return run;
 };
}

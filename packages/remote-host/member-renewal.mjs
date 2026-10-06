import {createHmac,randomBytes} from 'node:crypto';import {authenticate} from './policy.mjs';
// The workspace signing key is management-owned. A developer process receives
// only the resulting member token, never this purpose-bound renewal credential.
export function memberRenewal(config,{fetchImpl=fetch,now=Date.now,timeoutMs=5000}={}){
 const managed=config.managedSession;if(!managed?.memberRenewalUrl)return undefined;
 const source=new URL(managed.memberRenewalUrl);if(source.protocol!=='https:'||source.username||source.password||source.search||source.hash||source.pathname!=='/api/member-runtime-renewal')throw Error('Invalid member renewal authority');
 const endpoint=source;
 return async(runtime,principal)=>{
  const workspace=config.workspaces.find(w=>w.id===runtime.parentWorkspaceId);
  if(!workspace||workspace.id!==principal.workspaceId||!principal.memberId||principal.memberId.startsWith('collaboration:')||!Number.isSafeInteger(workspace.generation)||workspace.generation<0||['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state))throw Error('Member renewal unavailable');
  const claims={version:1,purpose:'member-runtime-renewal',workspaceId:workspace.id,memberId:principal.memberId,accessVersion:principal.accessVersion,scope:principal.scope,generation:workspace.generation,expires:Math.floor(now()/1000)+30,nonce:randomBytes(16).toString('hex')};
  const request=Buffer.from(JSON.stringify(claims)).toString('base64url'),signature=createHmac('sha256',managed.key).update(request).digest('base64url');
  const abort=new AbortController();let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('Renewal timed out'));},timeoutMs);});
  try{return await Promise.race([timeout,(async()=>{
   const response=await fetchImpl(endpoint.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature}),redirect:'error',signal:abort.signal});
   if(!response.ok)throw Error('Renewal denied');const reader=response.body.getReader(),chunks=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw Error('Invalid renewal');}chunks.push(Buffer.from(value));}
   const result=JSON.parse(Buffer.concat(chunks).toString());if(typeof result.token!=='string'||result.workspaceId!==workspace.id||result.memberId!==principal.memberId||result.accessVersion!==principal.accessVersion||result.scope!==principal.scope)throw Error('Renewal identity differs');
   const bearer='Bearer '+result.token,renewed=authenticate(config,bearer);
   if(['memberId','workspaceId','accessVersion','scope'].some(k=>renewed[k]!==principal[k])||renewed.expiresAt<=now()+30000||renewed.expiresAt>now()+300000)throw Error('Invalid renewed access');
   return {principal:renewed,bearer};
  })()]);}catch{abort.abort();throw Error('Member renewal unavailable');}finally{clearTimeout(timer);}
 };
}

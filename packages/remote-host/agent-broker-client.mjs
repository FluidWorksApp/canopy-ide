import {createHash} from 'node:crypto';
// Used by a CLI adapter. Resolver supplies only the member's short-lived access,
// never a provider key or management signing key. Resolve afresh for each call.
export class AgentBrokerClient {
 constructor({endpoint,workspaceId,projectId,memberId,resolveCredential,fetchImpl=fetch}){
  const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^ws-[a-f0-9-]{36}$/.test(workspaceId)||! /^[a-zA-Z0-9_-]{1,128}$/.test(projectId)||typeof memberId!=='string'||!memberId||typeof resolveCredential!=='function')throw Error('Invalid shared CLI connection');
  Object.assign(this,{endpoint:url.origin,workspaceId,projectId,memberId,resolveCredential,fetch:fetchImpl});
 }
 async execute(operation,payload,{signal}={}){
  if(!['agents:claude','agents:codex','agents:claude:count-tokens','agents:claude:models','agents:codex:models'].includes(operation)||!(payload instanceof Uint8Array)||payload.byteLength>4*1024*1024)throw Error('Invalid shared CLI request');
  const credential=await this.resolveCredential({minimumValidityMs:30000});
  if(!credential||credential.workspaceId!==this.workspaceId||credential.memberId!==this.memberId||typeof credential.token!=='string'||!credential.token||!Number.isFinite(credential.expiresAt)||credential.expiresAt<Date.now()+30000)throw Error('Shared CLI access needs renewal');
  const headers={authorization:'Bearer '+credential.token,'content-type':'application/json'},base=this.endpoint+'/v1/workspaces/'+this.workspaceId;
  const ticket=await this.fetch(base+'/shared-ticket',{method:'POST',headers,body:JSON.stringify({projectId:this.projectId,operation,bodySha256:createHash('sha256').update(payload).digest('hex')}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
  if(!ticket.ok)throw Error('Shared CLI access is unavailable');const value=await ticket.json();if(typeof value.ticket!=='string'||value.ticket.length>2048)throw Error('Invalid shared CLI ticket');
  return this.fetch(base+'/shared-execute',{method:'POST',headers,body:JSON.stringify({ticket:value.ticket,body:Buffer.from(payload).toString('base64')}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1800000)]):AbortSignal.timeout(1800000)});
 }
}

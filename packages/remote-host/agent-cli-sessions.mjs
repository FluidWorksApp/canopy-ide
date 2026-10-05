import {randomBytes,createHash} from 'node:crypto';
import {gitCliHandler} from './git-cli-proxy.mjs';
import {agentCliHandler} from './agent-cli-proxy.mjs';
// This registry lives in management, not in the container. A stolen facade token
// can perform only its original actor/project operation while that lease is live.
export class AgentCliSessions {
 constructor({resolvePrincipal,authorize,execute,endpoint,loadGitRepository,now=Date.now}){
  Object.assign(this,{resolvePrincipal,authorize,execute,endpoint,loadGitRepository,now});this.entries=new Map();this.active=new Map();this.pending=new Map();
  this.timer=setInterval(()=>{for(const [key,entry]of this.entries)void this.resolvePrincipal(entry).then(current=>{entry.expiresAt=current.expiresAt;},()=>this.entries.delete(key));},5000);this.timer.unref();
 }
 async prepare(workspace,principal,projectId,requestId){
  const key=JSON.stringify([workspace.id,principal.memberId,principal.accessVersion,projectId,requestId]);
  if(this.pending.has(key))return this.pending.get(key);
  const pending=this.prepareEntry(workspace,principal,projectId,requestId).finally(()=>this.pending.delete(key));this.pending.set(key,pending);return pending;
 }
 async prepareEntry(workspace,principal,projectId,requestId){
  if(typeof projectId!=='string'||!/^[\w-]{1,128}$/.test(projectId)||typeof requestId!=='string'||!/^[\w:-]{8,128}$/.test(requestId))throw Error('Shared agent project and session identity required');
  const actor=principal.memberId?'member:'+principal.memberId:'owner',version=principal.accessVersion??1;
  const key=createHash('sha256').update(JSON.stringify([workspace.id,actor,version,projectId,requestId])).digest('hex');
  let entry=this.entries.get(key);
  if(entry){const current=await this.resolvePrincipal(entry);entry.expiresAt=current.expiresAt;return entry.launch;}
  if(this.entries.size>=256)throw Error('Shared agent session capacity reached');
  const url=new URL(this.endpoint(workspace));if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid shared agent endpoint');
  entry={workspaceId:workspace.id,generation:workspace.generation,memberId:principal.memberId??'owner',isOwner:!principal.memberId,accessVersion:version,principal,projectId,requestId,expiresAt:principal.expiresAt,handlers:{},launch:{}};
  for(const agent of ['claude','codex']){
   const operation='agents:'+agent,context={workspaceId:workspace.id,generation:workspace.generation,memberId:principal.memberId??'owner',projectId,operation};
   const current=await this.resolvePrincipal(entry),grant=await this.authorize(current,context);
   if(!grant)continue;
   const secret=randomBytes(32).toString('base64url');
   entry.launch[agent]={url:url.origin+'/v1/agent-sessions/'+key+'/'+agent,token:secret};
   entry.handlers[agent]=agentCliHandler({agent,secret,execute:async(op,payload,options)=>{
    const renewed=await this.resolvePrincipal(entry);entry.expiresAt=renewed.expiresAt;
    return this.execute(renewed,{projectId,operation:op,body:payload,...(options.providerHeaders?{providerHeaders:options.providerHeaders}:{})},{...options,isSessionActive:()=>this.entries.get(key)===entry});
   }});
  }
  if(this.loadGitRepository){
   const current=await this.resolvePrincipal(entry),context={workspaceId:workspace.id,generation:workspace.generation,memberId:principal.memberId??'owner',projectId,operation:'git:fetch'},grant=await this.authorize(current,context);
   if(grant){const repository=await this.loadGitRepository(grant.accountId,context);if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[-\w.]{1,100}$/.test(repository)||['.','..'].includes(repository.split('/')[1]))throw Error('Invalid shared Git repository');
    const token=randomBytes(32).toString('base64url');entry.launch.git={url:url.origin+'/v1/agent-sessions/'+key+'/git',token,repository};
    entry.handlers.git=gitCliHandler({secret:token,execute:async(op,payload,{advertise,signal})=>{const renewed=await this.resolvePrincipal(entry);entry.expiresAt=renewed.expiresAt;return this.execute(renewed,{projectId,operation:op,body:payload,advertise},{signal,isSessionActive:()=>this.entries.get(key)===entry});}});
   }
  }
  this.entries.set(key,entry);return entry.launch;
 }
 bind(workspaceId,memberId,requestId,sessionId){for(const entry of this.entries.values())if(entry.workspaceId===workspaceId&&entry.memberId===memberId&&entry.requestId===requestId)entry.sessionId=sessionId;}
 revoke(workspaceId,memberId,sessionId){for(const [key,entry]of this.entries)if(entry.workspaceId===workspaceId&&entry.memberId===memberId&&entry.sessionId===sessionId)this.entries.delete(key);}
 async handle(req,res){
  const path=new URL(req.url,'http://gateway').pathname,match=path.match(/^\/v1\/agent-sessions\/([a-f0-9]{64})\/(claude|codex|git)(\/.*)$/);
  if(!path.startsWith('/v1/agent-sessions/'))return false;
  const entry=match&&this.entries.get(match[1]),handler=entry?.handlers[match[2]];
  if(!handler){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Shared agent access expired'}}));return true;}
  // Preserve query validation by the facade; never accept a caller-supplied URL.
  const query=new URL(req.url,'http://gateway').search;req.url=match[3]+query;
  const actor=entry.workspaceId+':'+entry.memberId,count=this.active.get(actor)??0;
  if(count>=8||[...this.active.values()].reduce((a,b)=>a+b,0)>=32){res.writeHead(429);res.end();return true;}
  this.active.set(actor,count+1);try{await handler(req,res);}finally{const left=this.active.get(actor)-1;if(left)this.active.set(actor,left);else this.active.delete(actor);}return true;
 }
 close(){clearInterval(this.timer);this.entries.clear();}
}

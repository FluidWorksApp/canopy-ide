import {serviceMountSource} from './service-mount.mjs';
// Gateway side of the Canopy service lifecycle (docs/canopy-service-protocol.md).
// The service is optional: every failure here degrades to "agents start without
// harness environment" and is reported, never blocks a terminal.
const unavailable=(reason,message)=>({available:false,reason,message});
const REQUEST_ID=/^[a-zA-Z0-9:-]{8,128}$/;
export class ServiceHarness{
 constructor({admin,config,controlPlane,tokenFor,inspect,listSessions,now=Date.now,log=message=>console.warn(message),intervalMs=30_000,accessIntervalMs=60_000,relayIntervalMs=60_000}){
  Object.assign(this,{admin,config,controlPlane,tokenFor,inspect,listSessions,now,log,intervalMs,accessIntervalMs,relayIntervalMs});
  this.workspaces=new Map(); // id -> {runnerUrl, runnerToken, registeredAt, accessAt, relayAt, hostRegistered, state}
  this.terminals=new Map();  // `${ws}\n${requestId}` -> {workspaceId, requestId, sessionId}
  this.states=new Map();     // id -> availability report
 }
 workspace(id){return this.config.workspaces.find(w=>w.id===id);}
 eligible(workspace){return !!workspace&&!workspace.memberId&&!workspace.parentWorkspaceId;}
 registration(workspace,runnerUrl){
  return {name:workspace.name??workspace.id,ownerUserId:workspace.ownerUserId??this.config.managedSession?.ownerUserId??null,runnerUrl,runnerToken:this.tokenFor(workspace.id)};
 }
 report(id,state){this.states.set(id,state);if(!state.available)this.log(`Canopy service ${state.reason} for ${id}: ${state.message}`);return state;}
 status(id){return this.states.get(id)??unavailable('not-registered','The workspace runtime has not registered with the Canopy service yet');}
 /** Before `docker run`: the service creates the socket directory the
  *  container will bind. The runner URL is unknown until it starts. */
 async prepareMount(workspace){
  if(!this.eligible(workspace))return false;
  try{
   const result=await this.admin.registerWorkspace(workspace.id,this.registration(workspace,null));
   if(result?.agentSocketDir!==serviceMountSource(workspace.id))throw Error('The service answered with an unexpected socket directory');
   return true;
  }catch(error){this.report(workspace.id,unavailable('unavailable',error.message));return false;}
 }
 /** Called whenever the gateway holds a live runtime for a workspace. */
 async attach(workspace,runtime){
  if(!this.eligible(workspace))return this.status(workspace?.id);
  if(!runtime?.harness)return this.report(workspace.id,unavailable('no-mount','This workspace container predates the Canopy service; it gains agent tools when it is next recreated'));
  const current=this.workspaces.get(workspace.id);
  if(current&&current.runnerUrl===runtime.url&&current.runnerToken===runtime.token&&this.now()-current.registeredAt<this.intervalMs&&this.states.get(workspace.id)?.available)return this.states.get(workspace.id);
  try{
   await this.admin.registerWorkspace(workspace.id,this.registration(workspace,runtime.url));
   this.workspaces.set(workspace.id,{...current,runnerUrl:runtime.url,runnerToken:runtime.token,registeredAt:this.now()});
   const state=this.report(workspace.id,{available:true});
   void this.refreshAuthority(workspace).catch(()=>{});
   return state;
  }catch(error){return this.report(workspace.id,unavailable(error.code==='rejected'?'rejected':'unavailable',error.message));}
 }
 async detach(id){
  const known=this.workspaces.delete(id);
  for(const [key,entry] of this.terminals)if(entry.workspaceId===id)this.terminals.delete(key);
  this.states.delete(id);
  if(known)await this.admin.deregisterWorkspace(id).catch(error=>this.log(`Canopy service deregistration failed for ${id}: ${error.message}`));
 }
 /** Mint a terminal credential before the runner spawns. null = degrade. */
 async mint(workspace,runtime,payload){
  const state=await this.attach(workspace,runtime);
  if(!state.available)return {harness:null,state};
  if(typeof payload?.requestId!=='string'||!REQUEST_ID.test(payload.requestId))return {harness:null,state:unavailable('invalid-request','Spawn request id required')};
  const text=value=>typeof value==='string'&&value.length&&value.length<=256?value:undefined;
  // A retried spawn reuses its credential, so the runner's receipt still matches.
  const existing=this.terminals.get(`${workspace.id}\n${payload.requestId}`);
  if(existing?.token)return {harness:{token:existing.token},state};
  try{
   const result=await this.admin.mintTerminal(workspace.id,{requestId:payload.requestId,agent:text(payload.agent),name:text(payload.name)??text(payload.title),task:text(payload.task)});
   if(typeof result?.token!=='string'||!result.token||result.token.length>1024)throw Error('The service minted no credential');
   if(this.terminals.size>=1024)throw Error('Too many live agent credentials');
   this.terminals.set(`${workspace.id}\n${payload.requestId}`,{workspaceId:workspace.id,requestId:payload.requestId,sessionId:null,token:result.token});
   return {harness:{token:result.token},state};
  }catch(error){return {harness:null,state:this.report(workspace.id,unavailable(error.code==='rejected'?'rejected':'unavailable',error.message))};}
 }
 async bind(workspaceId,requestId,{id,pid}){
  const entry=this.terminals.get(`${workspaceId}\n${requestId}`);if(!entry)return;
  entry.sessionId=id;
  try{await this.admin.bindTerminal(workspaceId,requestId,{sessionId:id,pid:Number.isSafeInteger(pid)?pid:null});}
  catch(error){this.log(`Canopy service bind failed for ${workspaceId}: ${error.message}`);await this.revoke(workspaceId,requestId);}
 }
 async revoke(workspaceId,requestId){
  if(!this.terminals.delete(`${workspaceId}\n${requestId}`))return;
  await this.admin.revokeTerminal(workspaceId,requestId).catch(error=>this.log(`Canopy service revocation failed for ${workspaceId}: ${error.message}`));
 }
 async revokeSession(workspaceId,sessionId){
  for(const entry of [...this.terminals.values()])if(entry.workspaceId===workspaceId&&entry.sessionId===sessionId)await this.revoke(workspaceId,entry.requestId);
 }
 /** Revoke credentials whose terminal exited or vanished from the runner. */
 async observeSessions(workspaceId,sessions){
  if(!Array.isArray(sessions))return;
  const live=new Set(sessions.filter(s=>s?.exitCode==null).map(s=>s.id));
  for(const entry of [...this.terminals.values()])if(entry.workspaceId===workspaceId&&entry.sessionId!=null&&!live.has(entry.sessionId))await this.revoke(workspaceId,entry.requestId);
 }
 async refreshAuthority(workspace,{force=false}={}){
  const entry=this.workspaces.get(workspace.id);if(!entry||!this.controlPlane||this.config.managedSession?.workspaceId!==workspace.id)return;
  const at=this.now();
  if(force||!entry.relayAt||at-entry.relayAt>=this.relayIntervalMs){
   try{await this.controlPlane.writeRelayCredential(workspace);entry.relayAt=at;}catch(error){this.log(`Relay credential refresh failed: ${error.message}`);}
  }
  // The control plane issues no snapshot until this host's device is registered.
  if(!entry.hostRegistered){
   try{await this.controlPlane.registerHost(workspace,await this.admin.device());entry.hostRegistered=true;}
   catch(error){this.log(`Host device registration failed: ${error.message}`);}
  }
  if(force||!entry.accessAt||at-entry.accessAt>=this.accessIntervalMs){
   try{await this.admin.putAccess(workspace.id,await this.controlPlane.accessSnapshot(workspace));entry.accessAt=at;}
   catch(error){this.log(`Access snapshot refresh failed for ${workspace.id}: ${error.message}`);}
  }
 }
 /** Periodic: deregister stopped runtimes, heal a restarted service, refresh
  *  authority and sweep exited terminals. */
 async reconcile(){
  for(const id of [...this.workspaces.keys()]){
   const workspace=this.workspace(id);
   try{
    const inspected=workspace&&!['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state)?await this.inspect(workspace):null;
    if(!inspected||inspected.State?.Running!==true){await this.detach(id);continue;}
    const entry=this.workspaces.get(id);
    await this.admin.registerWorkspace(id,this.registration(workspace,entry.runnerUrl));entry.registeredAt=this.now();this.report(id,{available:true});
    await this.refreshAuthority(workspace);
    if(this.listSessions)await this.observeSessions(id,await this.listSessions({url:entry.runnerUrl,token:entry.runnerToken}));
   }catch(error){this.report(id,unavailable('unavailable',error.message));}
  }
 }
 start(){
  if(this.timer)return;
  let running=false;
  this.timer=setInterval(async()=>{if(running)return;running=true;try{await this.reconcile();}finally{running=false;}},Math.min(this.intervalMs,this.accessIntervalMs,this.relayIntervalMs));
  this.timer.unref?.();
 }
 close(){clearInterval(this.timer);this.timer=undefined;}
}

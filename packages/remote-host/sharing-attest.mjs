import {createHash,createHmac} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {waitForRuntimeReady} from './runtime-readiness.mjs';
const execute=promisify(execFile);
// Whole-workspace sharing readiness. The control plane asks after every
// resume/resize of a workspace its owner shares; members may connect only once
// this host has proven, for this exact generation and instance, that member
// runtimes can run isolated: the shared capacity slice exists and holds the
// owner, the workspace network is up and the owner's services answer.
// Nothing is copied or stopped. Each refusal carries one fixed reason the
// control plane records and shows to the owner and members.
export const ATTEST_REASONS={
 recovery:'This workspace needs management recovery before it can be shared',
 capacity:'Member capacity is not configured on this machine yet. Restart the workspace to finish setup',
 network:'The workspace network is not ready yet',
 services:'Workspace services are not ready yet',
 authorization:'The workspace lifecycle changed while sharing was being checked',
 request:'The sharing readiness request is invalid',
};
const refuse=reason=>{throw Object.assign(Error(reason),{reason});};
export class SharingAttest{
 constructor({config,host,authorizeRuntime,instanceName=process.env.CANOPY_INSTANCE_NAME,networkReady=async()=>{await execute('systemctl',['is-active','--quiet','canopy-network'],{timeout:5000});},ready=waitForRuntimeReady,now=Date.now}){Object.assign(this,{config,host,authorizeRuntime,instanceName,networkReady,ready,now});}
 async attest(workspace,{nonce,generation,instanceName}={}){
  if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce)||generation!==workspace.generation||typeof this.instanceName!=='string'||!this.instanceName||instanceName!==this.instanceName)refuse(ATTEST_REASONS.request);
  if(workspace.memberId||workspace.parentWorkspaceId)refuse(ATTEST_REASONS.request);
  if(this.host.migrationCleanupRequired.has(workspace.id))refuse(ATTEST_REASONS.recovery);
  if(typeof this.authorizeRuntime!=='function'||!await this.authorizeRuntime(workspace))refuse(ATTEST_REASONS.authorization);
  if(!workspace.cgroupParent)refuse(ATTEST_REASONS.capacity);
  try{await this.host.verifyCapacity(workspace);}catch{refuse(ATTEST_REASONS.capacity);}
  try{await this.networkReady();}catch{refuse(ATTEST_REASONS.network);}
  let runtime;try{runtime=await this.host.open(workspace,{resume:true});}catch{refuse(ATTEST_REASONS.services);}
  if(!await this.ready(runtime))refuse(ATTEST_REASONS.services);
  // The owner container must be inside the slice members share, or members
  // would be capacity on top of the owner instead of within the workspace.
  const inspected=await this.host.inspectRuntime(workspace);
  if(inspected?.HostConfig?.CgroupParent!==workspace.cgroupParent)refuse(ATTEST_REASONS.capacity);
  if(!await this.authorizeRuntime(workspace))refuse(ATTEST_REASONS.authorization);
  const catalogHash=createHash('sha256').update(JSON.stringify(workspace.projectMounts??[])).digest('hex');
  const claims={version:1,purpose:'sharing-ready',workspaceId:workspace.id,generation,instanceName,nonce,catalogHash,expiresAt:this.now()+30000};
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  return {proof:payload+'.'+createHmac('sha256',this.config.managedSession.key).update(payload).digest('base64url')};
 }
}

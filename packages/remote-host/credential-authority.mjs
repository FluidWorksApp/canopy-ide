import {validateProjectAccess,grantedProjects} from './project-mounts.mjs';
const slots={'git:fetch':'git','git:push':'git','agents:claude':'claude','agents:codex':'codex'};
export function validateSharedResourceAccess(value){
 if(!value||Object.keys(value).length!==2||!Object.hasOwn(value,'git')||!Object.hasOwn(value,'agents'))throw Error('Invalid shared resource access');
 return {git:validateProjectAccess(value.git),agents:validateProjectAccess(value.agents)};
}
export function credentialAuthority({workspaces,authorizeMember,bindings,now=Date.now}){
 if(typeof authorizeMember!=='function'||typeof bindings!=='function')throw Error('Shared execution requires live authority and trusted bindings');
 return async(principal,context)=>{
  if(!principal?.memberId||!Number.isFinite(principal.expiresAt)||principal.expiresAt<=now()||principal.workspaceId!==context.workspaceId||principal.memberId!==context.memberId||typeof principal.bearer!=='string')return null;
  if(!Object.hasOwn(slots,context.operation))return null;const slot=slots[context.operation];
  const workspace=workspaces.find(w=>w.id===context.workspaceId);if(!workspace||['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state))return null;
  const current=await authorizeMember(principal,principal.bearer);
  if(!current?.sharedAccess||!current.projectAccess)return null;
  const project=grantedProjects(workspace,current.projectAccess).find(p=>p.id===context.projectId);if(!project)return null;
  const shared=validateSharedResourceAccess(current.sharedAccess)[slot==='git'?'git':'agents'];
  const selected=shared.selected.find(p=>p.id===context.projectId);
  const write=context.operation!=='git:fetch';
  if(write?(!project.writable||!shared.allWrite&&!selected?.writable):(!shared.allRead&&!selected))return null;
  const accountId=await bindings(context.workspaceId,context.projectId,slot);
  if(typeof accountId!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(accountId))return null;
  return {...context,accountId};
 };
}

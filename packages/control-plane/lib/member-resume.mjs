import {createHash} from 'node:crypto';
import {workspaceAccess} from './workspace-access.mjs';
import {projectAccess} from './project-access.mjs';
import {requestOperation,LifecycleError} from './lifecycle.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export function previouslyShared(workspace){const sharing=Number(workspace.sharing_generation),generation=Number(workspace.generation);return workspace.provider==='lightsail'&&workspace.sharing_generation!=null&&Number.isSafeInteger(sharing)&&sharing>=0&&Number.isSafeInteger(generation)&&generation>=sharing&&!workspace.deleted_at&&workspace.desired_state!=='deleted';}
export function writableMemberProjects(grants){const access=projectAccess(grants);return access.allWrite||access.selected.some(project=>project.writable);}
export function canResumeShared(workspace,grants,operation){
 if(!previouslyShared(workspace)||!writableMemberProjects(grants)||['created','unknown','stopping','deleting','deleted'].includes(workspace.state))return false;
 if(operation&&['pending','running','failed'].includes(operation.status)&&operation.action!=='resume')return false;
 if(operation?.status==='failed'&&operation.action==='resume'&&(workspace.desired_state!=='running'||String(operation.generation)!==String(workspace.generation)))return false;
 return true;
}
export function memberResumeKey(workspaceId,userId,requestKey){
 if(!uuid(requestKey))throw new LifecycleError(400,'Invalid workspace action');const bytes=createHash('sha256').update(JSON.stringify(['canopy-member-resume',workspaceId,userId,requestKey.toLowerCase()])).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const value=bytes.toString('hex');return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
async function accessAndOperation(db,userId,workspace){
 const grants=await workspaceAccess(db,workspace.id,userId),operation=(await db.query('SELECT id,workspace_id,owner_id,action,status,phase,generation,context FROM workspace_operation WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[workspace.id])).rows[0]??null;
 if(workspace.owner_id===userId||!canResumeShared(workspace,grants,operation))throw new LifecycleError(403,'You cannot resume this shared workspace');return operation;
}
// Owner-funded, resume-only. Browser-supplied owner/plan/context overrides never
// reach lifecycle mutation. Replays are bound to the authenticated requester.
export async function requestMemberResume(db,userId,workspace,input){
 if(input?.action!=='resume')throw new LifecycleError(403,'Only shared workspace resume is allowed');const requestKey=memberResumeKey(workspace.id,userId,input.requestKey),previous=await accessAndOperation(db,userId,workspace);
 if(previous?.action==='resume'&&previous.owner_id===workspace.owner_id&&previous.workspace_id===workspace.id){
  if(previous.context?.retryRequestKey===requestKey&&previous.context?.retryRequesterId===userId)return previous;
  if(['pending','running'].includes(previous.status))return {...previous,joined:true};
  if(previous.status==='failed'){
   const lock=(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[previous.id])).rows[0];if(!lock?.acquired)throw new LifecycleError(409,'Finishing a workspace step; try again shortly');
   const fresh=(await db.query("SELECT * FROM workspace_operation WHERE id=$1 AND workspace_id=$2 AND owner_id=$3 AND action='resume' AND generation=$4 AND status='failed' FOR UPDATE",[previous.id,workspace.id,workspace.owner_id,workspace.generation])).rows[0];if(!fresh)throw new LifecycleError(409,'Workspace operation changed; refresh before continuing');
   return (await db.query("UPDATE workspace_operation SET status='pending',attempts=0,last_error=NULL,context=(context-'phaseStartedAt'-'bootstrapReport')||$2::jsonb,next_attempt_at=now(),created_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[fresh.id,JSON.stringify({retryRequesterId:userId,retryRequestKey:requestKey})])).rows[0];
  }
 }
 return requestOperation(db,workspace.owner_id,workspace.id,{action:'resume',requestKey},{requesterId:userId});
}
export async function advanceMemberResume(db,userId,workspace){
 const operation=await accessAndOperation(db,userId,workspace);
 if(!operation){if(workspace.state==='ready'&&workspace.desired_state==='running')return {id:null,action:'resume',status:'succeeded',phase:'complete',noop:true};throw new LifecycleError(409,'No shared resume operation is available');}
 if(operation.action!=='resume'||operation.owner_id!==workspace.owner_id||operation.workspace_id!==workspace.id)throw new LifecycleError(409,'Only an existing workspace resume can be advanced');return operation;
}

import {memberAccessSnapshot,memberToken} from './member-access.mjs';
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
// sharing_generation is set only by trusted provisioning after project-volume
// migration and host isolation checks. Recreating/resizing invalidates it.
export async function memberConnection(db,userId,workspace,{clientId,key,readOnly=false,viewWorkspace=false,now=Date.now()}){
 const access=await memberAccessSnapshot(db,workspace.id,userId);
 if(!access||access.scope!=='drive'&&!((readOnly===true||viewWorkspace===true)&&access.scope==='view'))fail(403,'You do not have development access to this workspace');
 if(readOnly===true&&access.scope==='view'&&!access.sessionAccess.view.allRead&&!access.sessionAccess.view.selected.length)fail(403,'You do not have shared session viewing access to this workspace');
 if(workspace.sharing_generation==null||String(workspace.sharing_generation)!==String(workspace.generation)||String(access.generation)!==String(workspace.generation))fail(409,'This workspace is not ready for shared connections yet');
 if(workspace.provider!=='lightsail'||!workspace.endpoint)fail(409,'This workspace is not ready to connect');
 const endpoint=new URL(workspace.endpoint);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')fail(409,'Workspace connection is unavailable');
 if(typeof clientId!=='string'||!/^[-a-f0-9]{36}$/i.test(clientId))fail(400,'Missing IDE connection identity');
 const lease=await db.query("INSERT INTO connection_lease(id,user_id,workspace_id,expires_at) VALUES($3::uuid,$1,$2,now()+interval '2 minutes') ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE connection_lease.user_id=EXCLUDED.user_id AND connection_lease.workspace_id=EXCLUDED.workspace_id RETURNING id",[userId,workspace.id,clientId]);
 if(!lease.rows.length)fail(409,'Connection identity conflicts; reopen the workspace');
 const token=memberToken({workspaceId:workspace.id,memberId:userId,...access},key,now);
 return {connection:{endpoint:workspace.endpoint,token,workspaceId:workspace.id,workspaceName:workspace.name,scope:access.scope},expiresAt:new Date(now+120000).toISOString()};
}

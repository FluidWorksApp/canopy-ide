const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
export const isLegacyConnection=workspace=>workspace?.provider!=='lightsail'&&typeof workspace?.host_id==='string'&&workspace.host_id.length>0;
/** Remove only the account's saved connection record. Provider resources and
 * immutable usage/history rows remain untouched. Caller owns a transaction. */
export async function removeLegacyConnection(db,userId,input){
 const workspace=(await db.query('SELECT * FROM workspace WHERE id=$1 AND owner_id=$2 FOR UPDATE',[input.id,userId])).rows[0];
 if(!workspace||workspace.deleted_at)fail(404,'Workspace not found');
 if(!isLegacyConnection(workspace))fail(409,'Managed workspaces use Delete workspace');
 if(input.confirmName!==workspace.name)fail(409,'Type the workspace name to confirm removing its connection');
 const changed=await db.query('UPDATE workspace SET deleted_at=now() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL RETURNING id',[workspace.id,userId]);
 if(changed.rows.length!==1)fail(409,'Workspace connection changed. Refresh and try again');
 return {removed:true,workspaceId:workspace.id,resourcesRetained:true};
}

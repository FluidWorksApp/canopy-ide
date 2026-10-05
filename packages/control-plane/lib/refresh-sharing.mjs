// Previously enabled sharing survives a normal resume/resize only after the
// new management runtime proves the new generation. Never enable a new share
// from a container report, or start compute to obtain this proof.
export async function refreshSharingReadiness(pool,{activate,limit=2,workspaceId=null}){
 if(typeof activate!=='function'||!Number.isInteger(limit)||limit<1||limit>10)throw Error('Invalid sharing refresh');
 const rows=(await pool.query("SELECT id FROM workspace WHERE provider='lightsail' AND state='ready' AND desired_state='running' AND deleted_at IS NULL AND sharing_generation IS NOT NULL AND sharing_generation<>generation AND ($2::text IS NULL OR id=$2) ORDER BY observed_at LIMIT $1",[limit,workspaceId])).rows;
 const outcomes=[];
 for(const {id} of rows){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const workspace=(await client.query('SELECT * FROM workspace WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
   if(!workspace||workspace.provider!=='lightsail'||workspace.state!=='ready'||workspace.desired_state!=='running'||workspace.sharing_generation==null||String(workspace.sharing_generation)===String(workspace.generation)){
    await client.query('ROLLBACK');continue;
   }
   await activate(client,workspace);
   await client.query('COMMIT');outcomes.push({workspaceId:id,activated:true});
  }catch{await client.query('ROLLBACK');outcomes.push({workspaceId:id,activated:false});}
  finally{client.release();}
 }
 return outcomes;
}

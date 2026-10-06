export class LifecycleError extends Error {
 constructor(code, message) { super(message); this.code = code; }
}
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export function validateOperation(workspace, input) {
 if (!['resume','hibernate','resize','delete'].includes(input.action) || !uuid(input.requestKey)) throw new LifecycleError(400,'Invalid workspace action');
 if (workspace.deleted_at) throw new LifecycleError(410,'This workspace was deleted');
 if (input.action==='delete' && input.confirmName !== workspace.name) throw new LifecycleError(409,'Confirm the workspace name to permanently delete its files and setup');
 if (input.action==='resize' && (typeof input.planId !== 'string' || !input.planId)) throw new LifecycleError(400,'Choose a compute package');
 if (['ready','starting','error'].includes(workspace.state) && input.action!=='resume' && input.confirmInterrupt!==true) throw new LifecycleError(409,'This may stop running agents and jobs. Confirm before continuing');
}
// Caller owns the transaction; the row lock orders competing requests.
export async function requestOperation(client, userId, workspaceId, input, {requesterId=userId}={}) {
 if(!uuid(input.requestKey))throw new LifecycleError(400,'Invalid workspace action');
 const found=await client.query('SELECT * FROM workspace WHERE id=$1 AND owner_id=$2 FOR UPDATE',[workspaceId,userId]);
 const workspace=found.rows[0]; if(!workspace)throw new LifecycleError(404,'Workspace not found');
 const existing=await client.query('SELECT * FROM workspace_operation WHERE owner_id=$1 AND request_key=$2',[userId,input.requestKey]);
 if(existing.rows.length){
  const previous=existing.rows[0];
  if(previous.workspace_id!==workspaceId||previous.action!==input.action||(previous.target_plan_id??null)!==(input.planId??null)||(previous.context?.requesterId??previous.owner_id)!==requesterId)throw new LifecycleError(409,'Request identifier already used');
  return previous;
 }
 validateOperation(workspace,input);
 if(input.action==='resume'&&workspace.state==='ready'&&workspace.desired_state==='running')return {id:null,workspace_id:workspaceId,owner_id:userId,action:'resume',generation:workspace.generation,status:'succeeded',phase:'complete',noop:true,context:{requesterId}};
 const active=await client.query("SELECT id FROM workspace_operation WHERE workspace_id=$1 AND status IN('pending','running')",[workspaceId]);
 if(active.rows.length)throw new LifecycleError(409,'A workspace operation is already in progress');
 if(input.action==='resize'){
  const plan=await client.query('SELECT id FROM compute_plan WHERE id=$1 AND active=true',[input.planId]);
  if(!plan.rows.length)throw new LifecycleError(400,'Choose an available compute package');
 }
 const desired=input.action==='delete'?'deleted':input.action==='hibernate'?'stopped':'running';
 const changed=await client.query('UPDATE workspace SET generation=generation+1,desired_state=$2 WHERE id=$1 RETURNING generation',[workspaceId,desired]);
 const operation=await client.query('INSERT INTO workspace_operation(workspace_id,owner_id,request_key,action,generation,target_plan_id,context) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
  [workspaceId,userId,input.requestKey,input.action,changed.rows[0].generation,input.planId??null,JSON.stringify({previousPlanId:workspace.plan_id,previousState:workspace.state,requesterId})]);
 return operation.rows[0];
}
// Each step must be observed complete by the provider before advancing.
// Hibernate never reaches any delete-storage action.
export const PHASES = Object.freeze({
 resume:['ensure-storage','create-compute','attach-storage','verify-setup','start-runtime','verify-ready','complete'],
 hibernate:['quiesce','stop-compute','verify-stopped','detach-storage','verify-storage-retained','delete-compute','verify-compute-absent','complete'],
 resize:['quiesce','stop-compute','verify-stopped','detach-storage','verify-storage-retained','create-replacement','attach-storage','verify-setup','start-runtime','verify-ready','commit-package','delete-old-compute','complete'],
 delete:['revoke-access','stop-compute','verify-stopped','detach-storage','delete-compute','verify-compute-absent','delete-storage','delete-backups','verify-data-absent','complete'],
});
export function nextPhase(action, phase) {
 const steps=PHASES[action]; if(!steps)throw Error('Unknown lifecycle action');
 if(phase==='queued')return steps[0];
 const index=steps.indexOf(phase); if(index<0)throw Error('Unknown lifecycle phase');
 return steps[Math.min(index+1,steps.length-1)];
}

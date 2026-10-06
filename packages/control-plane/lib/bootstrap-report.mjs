import {createHmac,timingSafeEqual} from 'node:crypto';
const ttl=20*60*1000;
export const BOOTSTRAP_STAGES=Object.freeze(['packages','storage','artifact','image','host-services']);
const reject=code=>{throw Object.assign(new Error('Bootstrap report rejected'),{code});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const keyFor=(key,workspaceId)=>createHmac('sha256',key).update(`bootstrap-report:v1:${workspaceId}`).digest();
const mac=(payload,key,id)=>createHmac('sha256',keyFor(key,id)).update(payload).digest();
export function issueBootstrapReportToken(workspace,operation,key,now=Date.now()){
 if(typeof key!=='string'||key.length<32||!uuid(operation.id)||operation.workspace_id!==workspace.id||Number(operation.generation)!==Number(workspace.generation)||!['resume','resize'].includes(operation.action))reject(401);
 const startedAt=new Date(operation.created_at).getTime();if(!Number.isSafeInteger(startedAt))reject(401);
 const claims={version:1,purpose:'bootstrap-report',workspaceId:workspace.id,operationId:operation.id,generation:Number(operation.generation),startedAt,issuedAt:now,expiresAt:now+ttl};
 const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${payload}.${mac(payload,key,workspace.id).toString('base64url')}`;
}
export function verifyBootstrapReportToken(token,keyForWorkspace,now=Date.now()){
 if(typeof token!=='string'||token.length>2048)reject(401);
 const parts=token.split('.');if(parts.length!==2||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))reject(401);
 let c;try{c=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{reject(401);}
 const keys=['version','purpose','workspaceId','operationId','generation','startedAt','issuedAt','expiresAt'];
 if(!c||Object.keys(c).length!==keys.length||keys.some(k=>!Object.hasOwn(c,k))||c.version!==1||c.purpose!=='bootstrap-report'||!/^ws-[a-f0-9-]{36}$/.test(c.workspaceId??'')||!uuid(c.operationId)||!Number.isSafeInteger(c.generation)||c.generation<0||!Number.isSafeInteger(c.startedAt)||!Number.isSafeInteger(c.issuedAt)||c.issuedAt>now+5000||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt-c.issuedAt!==ttl||c.issuedAt<now-ttl)reject(401);
 const secret=keyForWorkspace(c.workspaceId);if(typeof secret!=='string'||secret.length<32)reject(401);
 const actual=Buffer.from(parts[1],'base64url'),expected=mac(parts[0],secret,c.workspaceId);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))reject(401);
 return c;
}
export function validateBootstrapReport(body){
 if(!body||Array.isArray(body)||Object.keys(body).length!==3||!BOOTSTRAP_STAGES.includes(body.stage)||!['progress','failed','succeeded'].includes(body.status)||(body.status==='succeeded'&&body.stage!=='host-services')||!Number.isSafeInteger(body.sequence)||body.sequence<1||body.sequence>64)reject(400);
 return body;
}
// Caller owns a transaction. A shared worker advisory lock prevents a callback
// being overwritten by an in-flight provider observation. No report can declare
// readiness, change billing, or call infrastructure. Unavailable callbacks retry.
export async function recordBootstrapReport(client,claims,input,now=Date.now()){
 const body=validateBootstrapReport(input);
 const locked=(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[claims.operationId])).rows[0]?.acquired;if(!locked)reject(409);
 const w=(await client.query('SELECT id,generation,desired_state,state,deleted_at FROM workspace WHERE id=$1 FOR UPDATE',[claims.workspaceId])).rows[0];
 const op=(await client.query('SELECT * FROM workspace_operation WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[claims.operationId,claims.workspaceId])).rows[0];
 if(!w||!op||w.deleted_at||w.desired_state!=='running'||['ready','stopped','stopping','deleting','deleted'].includes(w.state)||Number(w.generation)!==claims.generation||Number(op.generation)!==claims.generation||!['resume','resize'].includes(op.action)||!['pending','running'].includes(op.status)||new Date(op.created_at).getTime()!==claims.startedAt)reject(409);
 const previous=op.context?.bootstrapReport;
 if(previous?.startedAt===claims.startedAt&&(previous.status==='succeeded'||body.sequence<=previous.sequence||BOOTSTRAP_STAGES.indexOf(body.stage)<BOOTSTRAP_STAGES.indexOf(previous.stage)))reject(409);
 const report={...body,startedAt:claims.startedAt,receivedAt:new Date(now).toISOString()};
 const context={...op.context,bootstrapReport:report};
 const error=body.status==='failed'?`Workspace startup failed during ${body.stage}. Saved files are retained. Retry after checking the startup service.`:null;
 await client.query("UPDATE workspace_operation SET context=$2::jsonb,status=CASE WHEN $3 THEN 'failed' ELSE status END,last_error=CASE WHEN $3 THEN $4 ELSE last_error END,updated_at=now() WHERE id=$1",[op.id,JSON.stringify(context),body.status==='failed',error]);
 if(body.status==='failed')await client.query("UPDATE workspace SET state='error',observed_at=now() WHERE id=$1 AND generation=$2 AND desired_state='running'",[w.id,claims.generation]);
 return {accepted:true};
}

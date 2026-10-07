import {createHmac,timingSafeEqual} from 'node:crypto';
const ttl=20*60*1000;
export const BOOTSTRAP_STAGES=Object.freeze(['packages','storage','migrating-files','artifact','image','host-services']);
// A moved workspace reports copied/total bytes every 20 s (up to 240 reports).
export const MAX_BOOTSTRAP_REPORTS=256;
const MAX_COPY_BYTES=2**50;
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
// Coded failure reasons a host may attach to a failed stage. Numbers only: the
// host never sends daemon output, paths or free text.
export const BOOTSTRAP_FAILURE_REASONS=Object.freeze({'disk-full':{stage:'image',fields:['freeGB','neededGB']}});
const gigabytes=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<1e6;
export function validateBootstrapReport(body){
 if(body&&!Array.isArray(body)&&typeof body==='object'&&(Object.hasOwn(body,'copiedBytes')||Object.hasOwn(body,'totalBytes'))){
  const bytes=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX_COPY_BYTES;
  if(body.stage!=='migrating-files'||body.status!=='progress'||Object.keys(body).length!==5||!bytes(body.copiedBytes)||!bytes(body.totalBytes)||body.copiedBytes>body.totalBytes)reject(400);
  const {copiedBytes:_c,totalBytes:_t,...base}=body;validateBootstrapReport(base);
  return body;
 }
 const reason=body&&!Array.isArray(body)&&typeof body==='object'?body.reason:undefined;
 if(reason!==undefined){
  const rule=Object.hasOwn(BOOTSTRAP_FAILURE_REASONS,reason)?BOOTSTRAP_FAILURE_REASONS[reason]:null;
  if(!rule||body.status!=='failed'||body.stage!==rule.stage||Object.keys(body).length!==4+rule.fields.length||!rule.fields.every(field=>gigabytes(body[field])))reject(400);
  const {reason:_,...base}=body;for(const field of rule.fields)delete base[field];validateBootstrapReport(base);
  return body;
 }
 if(!body||Array.isArray(body)||Object.keys(body).length!==3||!BOOTSTRAP_STAGES.includes(body.stage)||!['progress','failed','succeeded'].includes(body.status)||(body.status==='succeeded'&&body.stage!=='host-services')||!Number.isSafeInteger(body.sequence)||body.sequence<1||body.sequence>MAX_BOOTSTRAP_REPORTS)reject(400);
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
 const error=body.status==='failed'?bootstrapFailureMessage(body):null;
 await client.query("UPDATE workspace_operation SET context=$2::jsonb,status=CASE WHEN $3 THEN 'failed' ELSE status END,last_error=CASE WHEN $3 THEN $4 ELSE last_error END,updated_at=now() WHERE id=$1",[op.id,JSON.stringify(context),body.status==='failed',error]);
 if(body.status==='failed')await client.query("UPDATE workspace SET state='error',observed_at=now() WHERE id=$1 AND generation=$2 AND desired_state='running'",[w.id,claims.generation]);
 return {accepted:true};
}
export function bootstrapFailureMessage(body){
 if(body.reason==='disk-full')return `Workspace disk is full: ${body.freeGB.toFixed(1)} GB free, ${body.neededGB.toFixed(1)} GB needed for the workspace image. Old workspace images were already removed and your saved files are retained. The workspace disk needs more space before it can start; contact support.`;
 return `Workspace startup failed during ${body.stage}. Saved files are retained. Retry after checking the startup service.`;
}

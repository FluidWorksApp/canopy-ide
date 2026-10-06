import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {issueBootstrapReportToken,verifyBootstrapReportToken,recordBootstrapReport,validateBootstrapReport} from './bootstrap-report.mjs';
const now=1700000000000,key='synthetic-report-key-not-a-credential'.repeat(2);
const workspace={id:'ws-11111111-1111-1111-1111-111111111111',generation:2,desired_state:'running',state:'starting',deleted_at:null};
const operation={id:'22222222-2222-2222-2222-222222222222',workspace_id:workspace.id,generation:2,action:'resume',status:'running',created_at:new Date(now-1000).toISOString(),context:{diskName:'synthetic-retained-disk'}};
const token=()=>issueBootstrapReportToken(workspace,operation,key,now);
const claims=()=>verifyBootstrapReportToken(token(),()=>key,now);
function fixture(){const w=structuredClone(workspace),op=structuredClone(operation),writes=[];let acquired=true;
 return {w,op,writes,setLocked:()=>{acquired=false;},query:async(sql,args)=>{
  if(sql.startsWith('SELECT pg_try_'))return {rows:[{acquired}]};
  if(sql.startsWith('SELECT id,generation'))return {rows:[w]};
  if(sql.startsWith('SELECT * FROM workspace_operation'))return {rows:[op]};
  writes.push([sql,args]);if(sql.startsWith('UPDATE workspace_operation')){op.context=JSON.parse(args[1]);if(args[2])op.status='failed';}if(sql.startsWith('UPDATE workspace SET'))w.state='error';return {rows:[]};
 }};
}
test('purpose-bound, workspace-bound and short-lived token rejects forged, altered, expired and cross-purpose values',()=>{
 assert.equal(claims().purpose,'bootstrap-report');
 for(const value of [token()+'x',token().replace(/^./,'Z'),token()+'.extra','not-a-token'])assert.throws(()=>verifyBootstrapReportToken(value,()=>key,now));
 assert.throws(()=>verifyBootstrapReportToken(token(),()=>key+'wrong',now));
 assert.throws(()=>verifyBootstrapReportToken(token(),()=>key,now+20*60*1000));
 const c={...claims(),purpose:'member-runtime-renewal'},payload=Buffer.from(JSON.stringify(c)).toString('base64url');
 const derived=createHmac('sha256',key).update(`bootstrap-report:v1:${workspace.id}`).digest();
 const signedWrongPurpose=payload+'.'+createHmac('sha256',derived).update(payload).digest('base64url');
 assert.throws(()=>verifyBootstrapReportToken(signedWrongPurpose,()=>key,now));
 assert.throws(()=>issueBootstrapReportToken(workspace,{...operation,action:'delete'},key,now));
});
test('body admits only bounded stage progress/failure, never ready, logs, secrets, or provider instructions',()=>{
 assert.deepEqual(validateBootstrapReport({stage:'artifact',status:'progress',sequence:1}),{stage:'artifact',status:'progress',sequence:1});
 for(const body of [{stage:'artifact',status:'ready',sequence:1},{stage:'artifact',status:'succeeded',sequence:1},{stage:'billing',status:'failed',sequence:1},{stage:'packages',status:'failed',sequence:65},{stage:'packages',status:'failed',sequence:1,error:'SECRET'},null])assert.throws(()=>validateBootstrapReport(body));
});
test('progress preserves lifecycle phase and disk context; replay and regression have zero writes',async()=>{
 const f=fixture();await recordBootstrapReport(f,claims(),{stage:'artifact',status:'progress',sequence:2},now);
 assert.equal(f.op.context.diskName,'synthetic-retained-disk');assert.equal(f.op.status,'running');assert.equal(f.w.state,'starting');
 const n=f.writes.length;
 for(const body of [{stage:'artifact',status:'progress',sequence:2},{stage:'packages',status:'progress',sequence:3}])await assert.rejects(recordBootstrapReport(f,claims(),body,now),{code:409});
 assert.equal(f.writes.length,n);
});
test('failure immediately records safe stage, but cannot assert readiness or mutate billing/provider',async()=>{
 const f=fixture();await recordBootstrapReport(f,claims(),{stage:'image',status:'failed',sequence:1},now);
 assert.equal(f.w.state,'error');assert.equal(f.op.status,'failed');assert.equal(f.writes.length,2);
 assert.ok(f.writes[0][1][3].includes('image'));assert.ok(f.writes.every(([sql])=>!sql.includes('credit')&&!sql.includes('session')));
 await assert.rejects(recordBootstrapReport(f,claims(),{stage:'host-services',status:'progress',sequence:2},now),{code:409});
});
test('stale generation, retry token, revoked operation and intentional stop/delete/ready reject before any write',async()=>{
 const changes=[f=>f.w.generation++,f=>f.op.generation++,f=>f.op.created_at=new Date(now).toISOString(),f=>f.op.status='failed',f=>f.op.action='delete',f=>f.w.desired_state='stopped',f=>f.w.desired_state='deleted',f=>f.w.state='stopped',f=>f.w.state='stopping',f=>f.w.state='deleting',f=>f.w.state='ready',f=>f.w.deleted_at=new Date(now).toISOString(),f=>f.setLocked()];
 for(const change of changes){const f=fixture();change(f);await assert.rejects(recordBootstrapReport(f,claims(),{stage:'packages',status:'failed',sequence:1},now),{code:409});assert.equal(f.writes.length,0);}
});
test('new retry timestamp fences old reports and allows fresh sequence on a newly issued token',async()=>{
 const f=fixture();f.op.created_at=new Date(now).toISOString();f.op.context.bootstrapReport={startedAt:now-1000,stage:'image',sequence:4};
 const renewed=verifyBootstrapReportToken(issueBootstrapReportToken(f.w,f.op,key,now),()=>key,now);
 await recordBootstrapReport(f,renewed,{stage:'packages',status:'progress',sequence:1},now);assert.equal(f.op.context.bootstrapReport.sequence,1);
});
test('host-bootstrap completion is advisory only and cannot declare workspace ready or overwrite a finished report',async()=>{
 const f=fixture();await recordBootstrapReport(f,claims(),{stage:'host-services',status:'succeeded',sequence:6},now);
 assert.equal(f.op.context.bootstrapReport.status,'succeeded');assert.equal(f.op.status,'running');assert.equal(f.w.state,'starting');assert.equal(f.writes.length,1);
 for(const status of ['progress','failed','succeeded'])await assert.rejects(recordBootstrapReport(f,claims(),{stage:'host-services',status,sequence:7},now),{code:409});
 assert.equal(f.writes.length,1);
});

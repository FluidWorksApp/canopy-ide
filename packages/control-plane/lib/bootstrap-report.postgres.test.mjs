import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {issueBootstrapReportToken,verifyBootstrapReportToken,recordBootstrapReport} from './bootstrap-report.mjs';
const connectionString=process.env.CANOPY_SYNTHETIC_DATABASE_URL;
test('real Postgres persists replay fences, serializes worker reports, and honors intentional stop',{skip:!connectionString},async()=>{
 const url=new URL(connectionString);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55461');assert.equal(url.username,'canopy_validation');
 const require=createRequire(process.env.CANOPY_SYNTHETIC_PG_PACKAGE_JSON??new URL('../../../package.json',import.meta.url));const {Pool}=require('pg');const pool=new Pool({connectionString});
 const owner=randomUUID(),workspaceId='ws-'+randomUUID(),opId=randomUUID(),key='synthetic-only-bootstrap-key'.repeat(2);let a,b;
 try{
  a=await pool.connect();b=await pool.connect();
  await a.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)',[owner,owner+'@example.invalid']);
  const w=(await a.query("INSERT INTO workspace(id,owner_id,name,generation,state,desired_state) VALUES($1,$2,'Synthetic bootstrap test',3,'starting','running') RETURNING *",[workspaceId,owner])).rows[0];
  const op=(await a.query("INSERT INTO workspace_operation(id,workspace_id,owner_id,request_key,action,generation,status) VALUES($1,$2,$3,$4,'resume',3,'running') RETURNING *",[opId,workspaceId,owner,randomUUID()])).rows[0];
  const claims=verifyBootstrapReportToken(issueBootstrapReportToken(w,op,key),()=>key);
  await a.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[opId]);
  await b.query('BEGIN');await assert.rejects(recordBootstrapReport(b,claims,{stage:'packages',status:'progress',sequence:1}),{code:409});await b.query('ROLLBACK');
  await a.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[opId]);
  await b.query('BEGIN');await recordBootstrapReport(b,claims,{stage:'artifact',status:'progress',sequence:2});await b.query('COMMIT');
  assert.equal((await a.query('SELECT context FROM workspace_operation WHERE id=$1',[opId])).rows[0].context.bootstrapReport.sequence,2);
  await a.query('BEGIN');await assert.rejects(recordBootstrapReport(a,claims,{stage:'artifact',status:'progress',sequence:2}),{code:409});await a.query('ROLLBACK');
  await a.query("UPDATE workspace SET generation=4,desired_state='stopped',state='stopping' WHERE id=$1",[workspaceId]);
  await b.query('BEGIN');await assert.rejects(recordBootstrapReport(b,claims,{stage:'image',status:'failed',sequence:3}),{code:409});await b.query('ROLLBACK');
  assert.equal((await a.query('SELECT status FROM workspace_operation WHERE id=$1',[opId])).rows[0].status,'running');
  assert.equal((await a.query('SELECT state FROM workspace WHERE id=$1',[workspaceId])).rows[0].state,'stopping');
  // Execute the actual owner retry SQL against synthetic Postgres. Only stale
  // progress/deadline fields disappear; retained resource and authority fields
  // survive, and the old signed reporter cannot poison the retried operation.
  const packagePath=process.env.CANOPY_SYNTHETIC_PG_PACKAGE_JSON;assert.ok(packagePath);
  const {requestOperation}=await import(new URL('./lib/canopy/lifecycle.mjs',pathToFileURL(packagePath)));
  const preserved={diskName:'synthetic-retained-data',instanceName:'synthetic-trusted-instance',requesterId:owner,permissions:{projects:'selected',projectIds:['synthetic-app']},phaseStartedAt:new Date(0).toISOString(),bootstrapReport:{stage:'image',status:'failed',sequence:3,startedAt:claims.startedAt}};
  await a.query("UPDATE workspace SET generation=3,desired_state='running',state='error' WHERE id=$1",[workspaceId]);
  await a.query("UPDATE workspace_operation SET status='failed',context=$2::jsonb,last_error='Synthetic old failure' WHERE id=$1",[opId,JSON.stringify(preserved)]);
  await b.query('BEGIN');const retried=await requestOperation(b,owner,workspaceId,{action:'retry',requestKey:randomUUID()});await b.query('COMMIT');
  assert.equal(retried.status,'pending');assert.equal(retried.last_error,null);assert.equal(retried.context.bootstrapReport,undefined);assert.equal(retried.context.phaseStartedAt,undefined);
  assert.equal(retried.context.diskName,preserved.diskName);assert.equal(retried.context.instanceName,preserved.instanceName);assert.deepEqual(retried.context.permissions,preserved.permissions);assert.equal(retried.context.requesterId,owner);
  assert.notEqual(new Date(retried.created_at).getTime(),claims.startedAt);
  await a.query('BEGIN');await assert.rejects(recordBootstrapReport(a,claims,{stage:'image',status:'failed',sequence:4}),{code:409});await a.query('ROLLBACK');
  const fresh=verifyBootstrapReportToken(issueBootstrapReportToken({...w,generation:3},retried,key),()=>key);
  await b.query('BEGIN');await recordBootstrapReport(b,fresh,{stage:'packages',status:'progress',sequence:1});await b.query('COMMIT');
  const final=(await a.query('SELECT status,context FROM workspace_operation WHERE id=$1',[opId])).rows[0];assert.equal(final.status,'pending');assert.equal(final.context.bootstrapReport.sequence,1);assert.equal(final.context.diskName,preserved.diskName);
 }finally{
  if(a){await a.query('ROLLBACK');await a.query('SELECT pg_advisory_unlock_all()');await a.query('DELETE FROM workspace_operation WHERE workspace_id=$1',[workspaceId]);await a.query('DELETE FROM workspace WHERE id=$1',[workspaceId]);await a.query('DELETE FROM "user" WHERE id=$1',[owner]);a.release();}
  if(b){await b.query('ROLLBACK');b.release();}await pool.end();
 }
});

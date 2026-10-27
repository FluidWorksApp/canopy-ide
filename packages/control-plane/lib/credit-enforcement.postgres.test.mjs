import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {enforceAfterDebit,enforceCreditPolicy,deliverCreditNotices,grantCredit,requestMoreCredit,deliverCreditRequest,creditSummary,recordingMailer} from './credit-enforcement.mjs';
import {requestOperation} from './lifecycle.mjs';
// Runs against the synthetic validation database with the deployed control
// plane schema (canopy-website database/ORDER) already applied.
const connectionString=process.env.CANOPY_SYNTHETIC_DATABASE_URL;
const enforce={CANOPY_CREDIT_ENFORCEMENT:'enforce'};
// Notify is the default; this exercises the enforce flow (requestOperation and
// grantCredit read process.env).
process.env.CANOPY_CREDIT_ENFORCEMENT='enforce';

test('real Postgres credit enforcement: notices once per crossing, concurrent debits at the cutoff, sweep, start gate, grants and requests',{skip:!connectionString},async()=>{
 const url=new URL(connectionString);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55461');assert.equal(url.username,'canopy_validation');
 const require=createRequire(process.env.CANOPY_SYNTHETIC_PG_PACKAGE_JSON??new URL('../../../package.json',import.meta.url));const {Pool}=require('pg');
 const pool=new Pool({connectionString,max:6});
 const owner=randomUUID(),email=`${owner}@example.invalid`,[w1,w2]=['ws-'+randomUUID(),'ws-'+randomUUID()];
 const balance=async()=>(await pool.query('SELECT balance_usd::text b FROM credit_account WHERE user_id=$1',[owner])).rows[0].b;
 const notices=async()=>(await pool.query('SELECT level,delivery,cleared_at FROM credit_notice WHERE user_id=$1 ORDER BY created_at,level',[owner])).rows;
 const open=async()=>(await notices()).filter(n=>!n.cleared_at).map(n=>`${n.level}:${n.delivery}`).sort();
 let n=0;
 // The same statements and lock order as meterWorkspace, then the hook.
 async function debit(workspaceId,usd,client){
  const own=!client;client??=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspaceId]);
   await client.query('SELECT user_id FROM credit_account WHERE user_id=$1 FOR UPDATE',[owner]);
   const row=(await client.query("INSERT INTO credit_ledger(user_id,workspace_id,event_key,kind,amount_usd,quantity,description) VALUES($1,$2,$3,'usage',-$4::numeric,60,'Workspace running time') RETURNING amount_usd",[owner,workspaceId,`synthetic-usage:${workspaceId}:${++n}:${randomUUID()}`,usd])).rows[0];
   await client.query('UPDATE credit_account SET balance_usd=balance_usd+$2::numeric WHERE user_id=$1',[owner,row.amount_usd]);
   const result=await enforceAfterDebit(client,{userId:owner,workspaceId},{env:enforce});
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{if(own)client.release();}
 }
 const tx=async work=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 try{
  const schema=await readFile(new URL('../credit-schema.sql',import.meta.url),'utf8');await pool.query(schema);await pool.query(schema);// idempotent
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[owner,'Synthetic credit',email]);
  for(const id of [w1,w2])await pool.query("INSERT INTO workspace(id,owner_id,name,plan_id,state,desired_state,generation,provider) VALUES($1,$2,$3,'standard','ready','running',1,'lightsail')",[id,owner,`Synthetic ${id.slice(3,11)}`]);
  await pool.query("INSERT INTO credit_account(user_id,balance_usd) VALUES($1,6)",[owner]);

  // Low: one notice however many debits stay below $5.
  assert.deepEqual((await debit(w1,'2')).notices,['low']);
  assert.deepEqual((await debit(w1,'0.5')).notices,[]);
  assert.deepEqual(await open(),['low:pending']);
  // Zero supersedes the unsent low reminder: one email, the most severe.
  assert.deepEqual((await debit(w1,'4')).notices,['zero']);
  assert.deepEqual(await open(),['low:skipped','zero:pending']);
  const mail=recordingMailer();
  assert.equal(await deliverCreditNotices(pool,{send:mail,supportEmail:'support@example.invalid'}),1);
  assert.equal(await deliverCreditNotices(pool,{send:mail}),0,'a sent notice is never resent');
  assert.equal(mail.sent[0].to,email);assert.match(mail.sent[0].subject,/out of Canopy credit/);assert.match(mail.sent[0].text,/−\$0\.50/);

  // Two workspaces of one owner debited at the same moment across the cutoff.
  await pool.query('UPDATE credit_account SET balance_usd=-9 WHERE user_id=$1',[owner]);
  const [a,b]=[await pool.connect(),await pool.connect()];
  let results;try{results=await Promise.all([debit(w1,'0.6',a),debit(w2,'0.6',b)]);}finally{a.release();b.release();}
  assert.equal(await balance(),'-10.200000');
  assert.deepEqual(results.map(r=>r.paused).sort(),[null,'requested'],'only the debit that crossed the cutoff pauses its workspace');
  const paused=(await pool.query('SELECT level FROM credit_notice WHERE user_id=$1 AND level=$2',[owner,'paused'])).rows;
  assert.equal(paused.length,1,'one paused notice despite concurrent crossings');
  // The sweep pauses the owner's other running workspace, once.
  const sweep=await enforceCreditPolicy(pool,{env:enforce,send:mail,log:null});
  assert.equal(sweep.paused,1);assert.equal((await enforceCreditPolicy(pool,{env:enforce,log:null})).paused,0);
  const states=(await pool.query('SELECT id,desired_state FROM workspace WHERE owner_id=$1 ORDER BY id',[owner])).rows;
  assert.ok(states.every(w=>w.desired_state==='stopped'),'both workspaces are hibernating');
  const ops=(await pool.query("SELECT action,context FROM workspace_operation WHERE owner_id=$1",[owner])).rows;
  assert.equal(ops.length,2);assert.ok(ops.every(op=>op.action==='hibernate'&&op.context.creditPause.cutoffUsd==='-10'));
  assert.ok(mail.sent.some(m=>/paused/.test(m.subject)),'paused email delivered by the sweep');
  // Data is retained: hibernate, never delete.
  assert.ok(!ops.some(op=>op.action==='delete'));

  // Start gate: resume is refused while at or below the cutoff.
  await pool.query("UPDATE workspace_operation SET status='succeeded' WHERE owner_id=$1",[owner]);
  await pool.query("UPDATE workspace SET state='stopped' WHERE owner_id=$1",[owner]);
  await assert.rejects(tx(c=>requestOperation(c,owner,w1,{action:'resume',requestKey:randomUUID()})),e=>e.code===402&&e.reason==='credit_exhausted'&&e.balanceUsd==='-10.200000'&&e.toJSON().code==='credit_exhausted');
  // A stop is never blocked by the balance.
  await assert.doesNotReject(tx(c=>requestOperation(c,owner,w2,{action:'hibernate',requestKey:randomUUID()})));
  await pool.query("UPDATE workspace_operation SET status='succeeded' WHERE owner_id=$1",[owner]);

  // Request more credit: one per day reaches support.
  const first=await tx(c=>requestMoreCredit(c,{userId:owner,note:'Need it for a demo'}));
  const again=await tx(c=>requestMoreCredit(c,{userId:owner}));
  assert.equal(first.created,true);assert.equal(again.created,false);assert.equal(again.request.id,first.request.id);
  const support=recordingMailer();assert.equal(await deliverCreditRequest({send:support,supportEmail:'support@example.invalid',result:first}),true);
  assert.equal(await deliverCreditRequest({send:support,supportEmail:'support@example.invalid',result:again}),false);
  assert.equal(support.sent[0].to,'support@example.invalid');assert.match(support.sent[0].text,/Need it for a demo/);

  // Admin grant: one ledger row per request key, notices recover, access returns.
  const key=randomUUID();
  const granted=await tx(c=>grantCredit(c,{userId:owner,amountUsd:'15.25',reason:'Preview top-up',actor:'ops@example.invalid',requestKey:key}));
  assert.deepEqual([granted.applied,granted.balanceUsd,granted.status,granted.computeAllowed],[true,'5.050000','ok',true]);
  const replay=await tx(c=>grantCredit(c,{userId:owner,amountUsd:'15.25',reason:'Preview top-up',actor:'ops@example.invalid',requestKey:key}));
  assert.equal(replay.applied,false);assert.equal(await balance(),'5.050000');
  await assert.rejects(tx(c=>grantCredit(c,{userId:owner,amountUsd:'99',reason:'x',actor:'ops',requestKey:key})),{code:409});
  const ledger=(await pool.query("SELECT kind,amount_usd::text amount,actor,description FROM credit_ledger WHERE user_id=$1 AND event_key LIKE 'admin-grant:%'",[owner])).rows;
  assert.deepEqual(ledger,[{kind:'grant',amount:'15.250000',actor:'ops@example.invalid',description:'Credit grant: Preview top-up'}]);
  assert.deepEqual(await open(),[],'every notice cleared by the recovery');
  assert.ok((await pool.query('SELECT resolved_by FROM credit_request WHERE user_id=$1',[owner])).rows.every(r=>r.resolved_by==='ops@example.invalid'));
  await assert.doesNotReject(tx(c=>requestOperation(c,owner,w1,{action:'resume',requestKey:randomUUID()})));
  // Re-armed: dropping below $5 again sends a fresh low reminder.
  assert.deepEqual((await debit(w1,'0.1')).notices,['low']);
  const correction=await tx(c=>grantCredit(c,{userId:owner,amountUsd:'-1',reason:'Correction',actor:'ops'}));
  assert.equal(correction.applied,true);assert.equal((await pool.query("SELECT kind FROM credit_ledger WHERE event_key=$1",[correction.eventKey])).rows[0].kind,'adjustment');

  const summary=await creditSummary(pool,owner,{env:{...enforce,CANOPY_SUPPORT_EMAIL:'support@example.invalid'}});
  assert.equal(summary.status,'low');assert.equal(summary.creditRequestsEnabled,true);assert.equal(summary.policy.cutoffUsd,-10);
  assert.equal(summary.usageByWorkspace.length,2);assert.ok(summary.recentDebits.every(d=>Number(d.amount_usd)<0&&d.workspace_name.startsWith('Synthetic')));
 }finally{
  for(const sql of ['DELETE FROM credit_notice WHERE user_id=$1','DELETE FROM credit_request WHERE user_id=$1','DELETE FROM credit_ledger WHERE user_id=$1','DELETE FROM workspace_session WHERE owner_id=$1','DELETE FROM workspace_operation WHERE owner_id=$1','DELETE FROM workspace WHERE owner_id=$1','DELETE FROM credit_account WHERE user_id=$1','DELETE FROM "user" WHERE id=$1'])await pool.query(sql,[owner]).catch(()=>{});
  await pool.end();
 }
});

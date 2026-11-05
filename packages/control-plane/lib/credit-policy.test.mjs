import test from 'node:test';import assert from 'node:assert/strict';
import {accountPolicy,assertCanCreateWorkspace,noticeLevels,creditStatus,computeAllowed,amountToRestoreUsd,enforcementMode,assertComputeAllowed,CreditExhaustedError,formatUsd,CUTOFF_USD} from './credit-policy.mjs';
import {requestOperation} from './lifecycle.mjs';
import {enforceAfterDebit,syncCreditNotices,grantCredit,deleteWorkspaceForCredit} from './credit-enforcement.mjs';
import {creditNoticeEmail,creditRequestEmail} from './credit-email.mjs';
// Notify is the default; tests of blocking opt in explicitly.
const ENFORCE={CANOPY_CREDIT_ENFORCEMENT:'enforce'};

test('thresholds: alerts at 30%, 15% and 5% of the alert base, deleted at $0 inclusive',()=>{
 assert.deepEqual(noticeLevels('30.01','100'),[]);assert.deepEqual(noticeLevels('30','100'),['pct30']);
 assert.deepEqual(noticeLevels('15.01','100'),['pct30']);assert.deepEqual(noticeLevels('15','100'),['pct30','pct15']);
 assert.deepEqual(noticeLevels('5','100'),['pct30','pct15','pct5']);assert.deepEqual(noticeLevels('0.01','100'),['pct30','pct15','pct5']);
 assert.deepEqual(noticeLevels('0','100'),['pct30','pct15','pct5','paused']);assert.deepEqual(noticeLevels('-1','100'),['pct30','pct15','pct5','paused']);
 // An account that never held credit has nothing to measure.
 assert.deepEqual(noticeLevels('0','0'),['paused']);assert.deepEqual(noticeLevels('0'),['paused']);
 // A base behind the balance never fires an alert on a healthy account.
 assert.deepEqual(noticeLevels('50','10'),[]);assert.deepEqual(noticeLevels('50'),[]);
 assert.equal(creditStatus('12'),'ok');assert.equal(creditStatus('-64.48'),'paused');
 assert.equal(creditStatus('25','100'),'low');assert.equal(creditStatus('10','100'),'low');assert.equal(creditStatus('4','100'),'final');assert.equal(creditStatus('0','100'),'paused');
 assert.deepEqual(accountPolicy('40','100'),{lowUsd:30,zeroUsd:0,finalUsd:5,cutoffUsd:0,minimumUsd:5});
 assert.equal(computeAllowed('0.000001'),true);assert.equal(computeAllowed('0'),false);assert.equal(computeAllowed('-0.000001'),false);
 assert.throws(()=>creditStatus('nope'),/Invalid balance/);
});
test('the amount to restore access reaches the start floor',()=>{
 assert.equal(amountToRestoreUsd('-64.48'),'69.48');assert.equal(amountToRestoreUsd('0'),'5.00');assert.equal(amountToRestoreUsd('4.999'),'0.01');assert.equal(amountToRestoreUsd('5'),'0.00');assert.equal(amountToRestoreUsd('9'),'0.00');
 assert.equal(formatUsd('-64.48'),'−$64.48');assert.equal(formatUsd('1234.5'),'$1,234.50');assert.equal(formatUsd('-0.000001'),'$0.00');
});
test('enforcement mode defaults to notify (the rollout default) and accepts only known values',()=>{
 assert.equal(enforcementMode({}),'notify');assert.equal(enforcementMode({CANOPY_CREDIT_ENFORCEMENT:' Enforce '}),'enforce');assert.equal(enforcementMode({CANOPY_CREDIT_ENFORCEMENT:'off'}),'off');assert.equal(enforcementMode({CANOPY_CREDIT_ENFORCEMENT:'disable'}),'notify');
});
test('by default nothing is deleted, but the start floor still applies',async()=>{
 await assert.rejects(assertComputeAllowed(recorder('4.99'),'owner','resume',{env:{}}),{code:402});
 assert.equal(await assertComputeAllowed(recorder('5'),'owner','resume',{env:{}}),'5');
 const hook=recorder('-64.48');assert.equal((await enforceAfterDebit(hook,{userId:'u',workspaceId:'w'},{env:{}})).paused,null);assert.ok(!hook.sql.some(s=>/workspace_operation|FROM workspace/.test(s)));
});
test('a new workspace is refused below the floor, for an account with no balance row too',async()=>{
 const low=recorder('4.99');await assert.rejects(assertCanCreateWorkspace(low,'owner',{env:{}}),error=>error instanceof CreditExhaustedError&&error.code===402&&error.minimumUsd==='5.00'&&/at least \$5\.00/.test(error.message));assert.match(low.sql[0],/FOR UPDATE$/);
 await assert.rejects(assertCanCreateWorkspace(recorder(null),'owner',{env:{}}),{code:402});
 await assert.rejects(assertCanCreateWorkspace(recorder('0'),'owner',{env:ENFORCE}),{code:402});
 assert.equal(await assertCanCreateWorkspace(recorder('5'),'owner',{env:{}}),'5');
 assert.equal(await assertCanCreateWorkspace(recorder('0'),'owner',{env:{CANOPY_CREDIT_ENFORCEMENT:'off'}}),null);
});
function recorder(balance){const sql=[];return {sql,query:async(text,args)=>{sql.push(text);if(text.includes('FROM credit_account'))return {rows:balance==null?[]:[{balance,base:'100'}]};return {rows:[]};}};}
test('the start gate locks the credit account and refuses compute below the floor with a structured error',async()=>{
 const db=recorder('0');
 await assert.rejects(assertComputeAllowed(db,'owner','resume',{env:ENFORCE}),error=>error instanceof CreditExhaustedError&&error.code===402&&error.reason==='credit_exhausted'&&error.balanceUsd==='0'&&error.cutoffUsd===String(CUTOFF_USD)&&/at least \$5\.00/.test(error.message));
 assert.match(db.sql[0],/FOR UPDATE$/);
 assert.deepEqual(new CreditExhaustedError('-12.5').toJSON(),{error:new CreditExhaustedError('-12.5').message,code:'credit_exhausted',balanceUsd:'-12.5',cutoffUsd:'0',shared:false,minimumUsd:'5.00'});
 for(const action of ['retry','resize','grow-storage'])await assert.rejects(assertComputeAllowed(recorder('4'),'owner',action,{env:ENFORCE}),{code:402});
 // Stop and delete never consult the balance; off never blocks.
 for(const action of ['hibernate','delete']){const quiet=recorder('-50');assert.equal(await assertComputeAllowed(quiet,'owner',action,{env:ENFORCE}),null);assert.equal(quiet.sql.length,0);}
 assert.equal(await assertComputeAllowed(recorder('-50'),'owner','resume',{env:{CANOPY_CREDIT_ENFORCEMENT:'off'}}),null);
 await assert.rejects(assertComputeAllowed(recorder(null),'owner','resume',{env:ENFORCE}),{code:402},'an account with no balance row starts nothing');
});
test('requestOperation locks the workspace before the credit account (metering order) and creates nothing when refused',async t=>{
 const previous=process.env.CANOPY_CREDIT_ENFORCEMENT;process.env.CANOPY_CREDIT_ENFORCEMENT='enforce';t.after(()=>{if(previous===undefined)delete process.env.CANOPY_CREDIT_ENFORCEMENT;else process.env.CANOPY_CREDIT_ENFORCEMENT=previous;});
 const sql=[];const db={query:async text=>{sql.push(text);if(text.startsWith('SELECT * FROM workspace WHERE'))return {rows:[{id:'ws-1',owner_id:'owner',name:'W',state:'stopped',desired_state:'stopped',generation:1}]};if(text.includes('FROM credit_account'))return {rows:[{balance:'-10.5'}]};return {rows:[]};}};
 await assert.rejects(requestOperation(db,'owner','ws-1',{action:'resume',requestKey:'f9b67dc0-f389-4ddb-b6c9-bb9aff258e67'}),{code:402});
 const workspaceLock=sql.findIndex(s=>/FROM workspace WHERE .*FOR UPDATE/.test(s)),accountLock=sql.findIndex(s=>/FROM credit_account.*FOR UPDATE/.test(s));
 assert.ok(workspaceLock>=0&&accountLock>workspaceLock);
 assert.ok(!sql.some(s=>/^(UPDATE workspace|INSERT INTO workspace_operation)/.test(s)));
});
test('a debit hook in off mode does nothing; in notify mode it records notices but never pauses',async()=>{
 const off=recorder('-20');assert.deepEqual(await enforceAfterDebit(off,{userId:'u',workspaceId:'w'},{env:{CANOPY_CREDIT_ENFORCEMENT:'off'}}),{status:'ok',notices:[],paused:null});assert.equal(off.sql.length,0);
 const notify=recorder('-20');const result=await enforceAfterDebit(notify,{userId:'u',workspaceId:'w'},{env:{CANOPY_CREDIT_ENFORCEMENT:'notify'}});
 assert.equal(result.paused,null);assert.ok(!notify.sql.some(s=>/workspace_operation|FROM workspace/.test(s)));
 const insert=notify.sql.find(s=>s.startsWith('INSERT INTO credit_notice'));assert.ok(insert);
});
test('notify mode never opens a "paused" notice (its email would claim deletion)',async()=>{
 const calls=[];const db={query:async(text,args)=>{calls.push([text,args]);return {rows:text.includes('alert_base_usd')?[{base:'100'}]:[]};}};
 await syncCreditNotices(db,'u','-30',{env:{CANOPY_CREDIT_ENFORCEMENT:'notify'}});
 const insert=calls.find(([s])=>s.startsWith('INSERT INTO credit_notice'));assert.deepEqual(insert[1][1],['pct30','pct15','pct5']);
 const clear=calls.find(([s])=>s.startsWith('UPDATE credit_notice SET cleared_at'));assert.deepEqual(clear[1][1],['paused','low','zero','final']);
});
test('grant validation rejects zero, oversized, over-precise and unattributed grants before touching the ledger',async()=>{
 const db=recorder('0');
 for(const amountUsd of ['0','abc','10001','1.0000001',''])await assert.rejects(grantCredit(db,{userId:'u',amountUsd,reason:'r',actor:'a'}),{code:400});
 await assert.rejects(grantCredit(db,{userId:'u',amountUsd:'5',reason:'',actor:'a'}),{code:400});
 await assert.rejects(grantCredit(db,{userId:'u',amountUsd:'5',reason:'r',actor:' '}),{code:400});
 assert.equal(db.sql.length,0);
});

test('reminder emails carry the exact balance, what happens next and how to get credit, in text and HTML',()=>{
 for(const [level,balance,subject,next] of [['pct30','30','30% of your Canopy credit left',/permanently deleted/],['pct15','15','15% of your Canopy credit left',/permanently deleted/],['pct5','5','Final notice',/permanently deleted/],['paused','-4.48','being deleted',/at least \$9\.48/]]){
  const mail=creditNoticeEmail({level,balanceUsd:balance,supportEmail:'help@example.invalid'});
  assert.match(mail.subject,new RegExp(subject));assert.match(mail.text,next);assert.match(mail.text,/Request more credit/);assert.match(mail.text,/help@example\.invalid/);
  assert.match(mail.html,/^<!doctype html>/);assert.ok(mail.html.includes(mail.text.match(/Balance: (\S+)/)[1]));
 }
 const paused=creditNoticeEmail({level:'paused',balanceUsd:'-10.2'});assert.match(paused.text,/can’t be undone/);assert.doesNotMatch(paused.text,/undefined|kept/);
 assert.throws(()=>creditNoticeEmail({level:'other',balanceUsd:'1'}),/Invalid/);
 assert.throws(()=>creditNoticeEmail({level:'pct30',balanceUsd:'1',accountUrl:'javascript:alert(1)'}),/Invalid/);
});
test('credit request email escapes user-provided text and names the grant command',()=>{
 const mail=creditRequestEmail({name:'<b>Sam</b>',email:'sam@example.invalid',balanceUsd:'-64.48',note:'<script>x</script>',requestId:'req-1'});
 assert.match(mail.subject,/sam@example\.invalid.*−\$64\.48/);assert.ok(!mail.html.includes('<script>'));assert.ok(!mail.html.includes('<b>Sam'));assert.match(mail.text,/grant-credit\.mjs --email sam@example\.invalid/);
});
test('a refused delete is deferred to the sweep and never aborts the caller (metering debits every workspace in one transaction)',async()=>{
 const sql=[];const db={query:async text=>{sql.push(text);if(text.startsWith('SELECT id,owner_id'))return {rows:[{id:'w',owner_id:'u',desired_state:'running',deleted_at:null}]};return {rows:[]};}};
 for(const code of [400,409,410])assert.equal(await deleteWorkspaceForCredit(db,'u','w',{request:async()=>{throw Object.assign(Error('refused'),{code});},log:null}),'deferred');
 assert.equal(sql.filter(s=>s==='ROLLBACK TO SAVEPOINT credit_pause').length,3);
 await assert.rejects(deleteWorkspaceForCredit(db,'u','w',{request:async()=>{throw Error('connection lost');},log:null}),/connection lost/);
});
test('a delete waits for an operation already in flight (the worker meters while holding its lock)',async()=>{
 const sql=[];let requested=false;const db={query:async text=>{sql.push(text);if(text.startsWith('SELECT id,owner_id'))return {rows:[{id:'w',owner_id:'u',desired_state:'running',deleted_at:null}]};if(text.startsWith('SELECT action FROM workspace_operation'))return {rows:[{action:'resume'}]};return {rows:[]};}};
 assert.equal(await deleteWorkspaceForCredit(db,'u','w',{request:async()=>{requested=true;},log:null}),'deferred');
 assert.equal(requested,false);assert.ok(!sql.some(s=>s.startsWith('SAVEPOINT')));
});

// Billing policy (website tests/credit-billing.test.mjs covers the metering side).
test('a start needs the floor, or one billing interval above the cutoff when that costs more',async()=>{
 const {startMinimumUsd,startAllowed,BILLING_INTERVAL_SECONDS}=await import('./credit-policy.mjs');
 assert.equal(BILLING_INTERVAL_SECONDS,300);assert.equal(startMinimumUsd(null),5);assert.equal(startMinimumUsd('1.2'),5);assert.ok(Math.abs(startMinimumUsd('120')-10)<1e-9);
 assert.equal(startAllowed('5','1.2'),true);assert.equal(startAllowed('4.99','1.2'),false);
 await assert.rejects(assertComputeAllowed(recorder('4.99'),'owner','resume',{env:ENFORCE,usdPerHour:()=>'1.2'}),error=>error.minimumUsd==='5.00'&&/at least \$5\.00/.test(error.message));
 assert.equal(new CreditExhaustedError('0.05',{shared:true}).toJSON().minimumUsd,undefined);
});
test('paused storage is charged by default; hold skips it only while enforce has paused the account',async()=>{
 const {pausedStorageBilling,purchaseEnabled}=await import('./credit-policy.mjs');const {storageChargeHeld}=await import('./credit-enforcement.mjs');
 assert.equal(pausedStorageBilling({}),'charge');assert.equal(pausedStorageBilling({CANOPY_PAUSED_STORAGE_BILLING:'hold'}),'hold');
 const hold={...ENFORCE,CANOPY_PAUSED_STORAGE_BILLING:'hold'};
 assert.equal(await storageChargeHeld(recorder('-20'),'u',{env:ENFORCE}),false);assert.equal(await storageChargeHeld(recorder('-20'),'u',{env:{CANOPY_PAUSED_STORAGE_BILLING:'hold'}}),false);
 assert.equal(await storageChargeHeld(recorder('1'),'u',{env:hold}),false);assert.equal(await storageChargeHeld(recorder('-20'),'u',{env:hold}),true);
 assert.equal(purchaseEnabled({}),false);
});

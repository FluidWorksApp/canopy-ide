import test from 'node:test';import assert from 'node:assert/strict';
import {noticeLevels,creditStatus,computeAllowed,amountToRestoreUsd,enforcementMode,assertComputeAllowed,CreditExhaustedError,formatUsd,CUTOFF_USD} from './credit-policy.mjs';
import {requestOperation} from './lifecycle.mjs';
import {enforceAfterDebit,syncCreditNotices,grantCredit} from './credit-enforcement.mjs';
import {creditNoticeEmail,creditRequestEmail} from './credit-email.mjs';

test('thresholds: low below $5, zero at $0, final at -$5, paused at -$10 inclusive',()=>{
 assert.deepEqual(noticeLevels('5'),[]);assert.deepEqual(noticeLevels('4.999999'),['low']);
 assert.deepEqual(noticeLevels('0'),['low','zero']);assert.deepEqual(noticeLevels('-4.99'),['low','zero']);
 assert.deepEqual(noticeLevels('-5'),['low','zero','final']);assert.deepEqual(noticeLevels(-10),['low','zero','final','paused']);
 assert.equal(creditStatus('12'),'ok');assert.equal(creditStatus('-64.48'),'paused');
 assert.equal(computeAllowed('-9.999999'),true);assert.equal(computeAllowed('-10'),false);assert.equal(computeAllowed('-10.000001'),false);
 assert.throws(()=>creditStatus('nope'),/Invalid balance/);
});
test('the amount to restore access is the smallest cent amount that lifts the balance above the cutoff',()=>{
 assert.equal(amountToRestoreUsd('-64.48'),'54.49');assert.equal(amountToRestoreUsd('-10'),'0.01');assert.equal(amountToRestoreUsd('-10.0001'),'0.01');assert.equal(amountToRestoreUsd('-9'),'0.00');
 assert.equal(formatUsd('-64.48'),'−$64.48');assert.equal(formatUsd('1234.5'),'$1,234.50');assert.equal(formatUsd('-0.000001'),'$0.00');
});
test('enforcement mode defaults to enforce and accepts only known values',()=>{
 assert.equal(enforcementMode({}),'enforce');assert.equal(enforcementMode({CANOPY_CREDIT_ENFORCEMENT:' Notify '}),'notify');assert.equal(enforcementMode({CANOPY_CREDIT_ENFORCEMENT:'off'}),'off');assert.equal(enforcementMode({CANOPY_CREDIT_ENFORCEMENT:'disable'}),'enforce');
});

function recorder(balance){const sql=[];return {sql,query:async(text,args)=>{sql.push(text);if(text.includes('FROM credit_account'))return {rows:balance==null?[]:[{balance}]};return {rows:[]};}};}
test('the start gate locks the credit account and refuses compute at the cutoff with a structured error',async()=>{
 const db=recorder('-10');
 await assert.rejects(assertComputeAllowed(db,'owner','resume',{env:{}}),error=>error instanceof CreditExhaustedError&&error.code===402&&error.reason==='credit_exhausted'&&error.balanceUsd==='-10'&&error.cutoffUsd===String(CUTOFF_USD)&&/−\$10\.00/.test(error.message));
 assert.match(db.sql[0],/FOR UPDATE$/);
 assert.deepEqual(new CreditExhaustedError('-12.5').toJSON(),{error:new CreditExhaustedError('-12.5').message,code:'credit_exhausted',balanceUsd:'-12.5',cutoffUsd:'-10',shared:false});
 for(const action of ['retry','resize','grow-storage'])await assert.rejects(assertComputeAllowed(recorder('-11'),'owner',action,{env:{}}),{code:402});
 // Stop and delete never consult the balance; notify/off never block.
 for(const action of ['hibernate','delete']){const quiet=recorder('-50');assert.equal(await assertComputeAllowed(quiet,'owner',action,{env:{}}),null);assert.equal(quiet.sql.length,0);}
 assert.equal(await assertComputeAllowed(recorder('-50'),'owner','resume',{env:{CANOPY_CREDIT_ENFORCEMENT:'notify'}}),null);
 // No account row yet means a zero balance, which may start.
 assert.equal(await assertComputeAllowed(recorder(null),'owner','resume',{env:{}}),'0');
});
test('requestOperation locks the workspace before the credit account (metering order) and creates nothing when refused',async()=>{
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
test('notify mode never opens a "paused" notice (its email would claim compute stopped)',async()=>{
 const calls=[];const db={query:async(text,args)=>{calls.push([text,args]);return {rows:[]};}};
 await syncCreditNotices(db,'u','-30',{env:{CANOPY_CREDIT_ENFORCEMENT:'notify'}});
 const insert=calls.find(([s])=>s.startsWith('INSERT INTO credit_notice'));assert.deepEqual(insert[1][1],['low','zero','final']);
 const clear=calls.find(([s])=>s.startsWith('UPDATE credit_notice SET cleared_at'));assert.deepEqual(clear[1][1],['paused']);
});
test('grant validation rejects zero, oversized, over-precise and unattributed grants before touching the ledger',async()=>{
 const db=recorder('0');
 for(const amountUsd of ['0','abc','10001','1.0000001',''])await assert.rejects(grantCredit(db,{userId:'u',amountUsd,reason:'r',actor:'a'}),{code:400});
 await assert.rejects(grantCredit(db,{userId:'u',amountUsd:'5',reason:'',actor:'a'}),{code:400});
 await assert.rejects(grantCredit(db,{userId:'u',amountUsd:'5',reason:'r',actor:' '}),{code:400});
 assert.equal(db.sql.length,0);
});

test('reminder emails carry the exact balance, what happens next and how to get credit, in text and HTML',()=>{
 for(const [level,balance,subject,next] of [['low','4.2','running low',/reaches −\$10\.00/],['zero','-0.5','out of Canopy credit',/\$9\.50 of running time left/],['final','-6.25','Final notice',/\$3\.75 of running time/],['paused','-64.48','paused',/at least \$54\.49/]]){
  const mail=creditNoticeEmail({level,balanceUsd:balance,supportEmail:'help@example.invalid'});
  assert.match(mail.subject,new RegExp(subject));assert.match(mail.text,next);assert.match(mail.text,/Request more credit/);assert.match(mail.text,/help@example\.invalid/);
  assert.match(mail.html,/^<!doctype html>/);assert.ok(mail.html.includes(mail.text.match(/Balance: (\S+)/)[1]));
 }
 const paused=creditNoticeEmail({level:'paused',balanceUsd:'-10.2'});assert.match(paused.text,/nothing was deleted/);assert.doesNotMatch(paused.text,/undefined/);
 assert.throws(()=>creditNoticeEmail({level:'other',balanceUsd:'1'}),/Invalid/);
 assert.throws(()=>creditNoticeEmail({level:'low',balanceUsd:'1',accountUrl:'javascript:alert(1)'}),/Invalid/);
});
test('credit request email escapes user-provided text and names the grant command',()=>{
 const mail=creditRequestEmail({name:'<b>Sam</b>',email:'sam@example.invalid',balanceUsd:'-64.48',note:'<script>x</script>',requestId:'req-1'});
 assert.match(mail.subject,/sam@example\.invalid.*−\$64\.48/);assert.ok(!mail.html.includes('<script>'));assert.ok(!mail.html.includes('<b>Sam'));assert.match(mail.text,/grant-credit\.mjs --email sam@example\.invalid/);
});

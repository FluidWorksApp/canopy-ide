// Add funds and admin grants: the pure parts. The deployed handlers and the
// Stripe signature check are tested in the website service
// (tests/credit-purchase.test.mjs, tests/credit-admin.test.mjs).
import test from 'node:test';import assert from 'node:assert/strict';
import {purchaseEnabled,purchaseOptions,purchaseCents,checkoutSessionParams,createCreditCheckout,applyCheckoutEvent,PURCHASE_PURPOSE} from './credit-purchase.mjs';
import {creditAdminEmails,isCreditAdmin,adminGrantCredit,listCreditAccounts} from './credit-admin.mjs';
import {creditNoticeEmail} from './credit-email.mjs';

// Secret-shaped values are built at runtime so history scanners don't flag them.
const ENV={CANOPY_CREDIT_PURCHASE_ENABLED:'true',STRIPE_SECRET_KEY:['sk','test','a1'.repeat(12)].join('_'),STRIPE_WEBHOOK_SECRET:['whsec','b2'.repeat(16)].join('_')};
const user={id:'u-1',email:'sam@example.invalid'};

test('purchasing needs the switch and both Stripe secrets; amounts are $5 to $500 in cents',()=>{
 assert.equal(purchaseEnabled({}),false);assert.equal(purchaseEnabled({...ENV,STRIPE_WEBHOOK_SECRET:''}),false);assert.equal(purchaseEnabled(ENV),true);
 assert.deepEqual(purchaseOptions(ENV),{enabled:true,currency:'USD',presetsUsd:[10,25,50,100],minUsd:5,maxUsd:500});
 assert.equal(purchaseCents('12.34'),1234);assert.equal(purchaseCents(100),10000);
 for(const bad of [4.99,'500.01','12.345','-10',null])assert.throws(()=>purchaseCents(bad),{code:400});
});
test('the checkout session charges the chosen USD amount, sends a receipt and tags the Canopy user',async()=>{
 const params=checkoutSessionParams({user,cents:2500,origin:'https://canopyide.dev'});
 assert.equal(params.line_items[0].price_data.unit_amount,2500);assert.equal(params.payment_intent_data.receipt_email,user.email);
 assert.deepEqual(params.metadata,{purpose:PURCHASE_PURPOSE,canopy_user_id:'u-1'});assert.equal(params.success_url,'https://canopyide.dev/workspaces?funds=added');
 await assert.rejects(createCreditCheckout({},{user,amountUsd:10,env:{}}),{code:503});
 const created=[];const stripe={checkout:{sessions:{create:async p=>{created.push(p);return {id:'cs_test_1',url:'https://checkout.stripe.com/c/pay/cs_test_1'};}}}};
 assert.deepEqual(await createCreditCheckout(stripe,{user,amountUsd:'25',env:ENV,origin:'https://canopyide.dev'}),{url:'https://checkout.stripe.com/c/pay/cs_test_1',sessionId:'cs_test_1',amountUsd:'25.00',expiresAt:null});
});

function ledgerDb(){
 const ledger=new Map();let balance=-12;
 return {ledger,balance:()=>balance,async query(text,args=[]){
  if(text.startsWith('SELECT id FROM "user"'))return {rows:args[0]==='u-1'?[{id:'u-1'}]:[]};
  if(text.startsWith('SELECT id,email FROM "user"'))return {rows:[{id:'u-1',email:'sam@example.invalid'}]};
  if(text.startsWith('INSERT INTO credit_ledger')){if(ledger.has(args[1]))return {rows:[]};ledger.set(args[1],{kind:args[2],amount:args[3],description:args[4],actor:args[5]});return {rows:[{amount:args[3]}]};}
  if(text.startsWith('UPDATE credit_account SET balance_usd'))balance+=Number(args[1]);
  if(text.startsWith('SELECT user_id,amount_usd::numeric'))return {rows:[{same:true}]};
  if(text.startsWith('SELECT balance_usd::text balance'))return {rows:[{balance:String(balance)}]};
  return {rows:[]};}};
}
const event=({id='evt_1',paid=true,userId='u-1',purpose=PURCHASE_PURPOSE}={})=>({id,type:'checkout.session.completed',data:{object:{id:'cs_test_session_1',mode:'payment',payment_status:paid?'paid':'unpaid',currency:'usd',amount_total:2500,payment_intent:'pi_1',client_reference_id:userId,metadata:{purpose,canopy_user_id:userId}}}});
test('a paid checkout credits what Stripe charged, once; other events credit nothing',async()=>{
 const db=ledgerDb();
 assert.equal((await applyCheckoutEvent(db,event())).applied,true);assert.equal((await applyCheckoutEvent(db,event({id:'evt_2'}))).applied,false);
 assert.equal(db.balance(),13);assert.deepEqual(db.ledger.get('purchase:cs_test_session_1'),{kind:'grant',amount:'25.00',description:'Funds added: Stripe payment pi_1',actor:'stripe:evt_1'});
 const quiet={warn(){}};
 for(const [e,reason] of [[event({paid:false}),'not-paid'],[event({purpose:'other'}),'not-canopy-credit'],[event({userId:'gone'}),'unknown-user']])assert.equal((await applyCheckoutEvent(ledgerDb(),e,{log:quiet})).reason,reason);
});
test('admin grants are limited to CANOPY_ADMIN_EMAILS and record the admin as actor',async()=>{
 const env={CANOPY_ADMIN_EMAILS:'Ops@example.invalid'};
 assert.deepEqual([...creditAdminEmails(env)],['ops@example.invalid']);assert.equal(isCreditAdmin({email:'OPS@example.invalid'},env),true);assert.equal(isCreditAdmin({email:'sam@example.invalid'},env),false);assert.equal(isCreditAdmin({email:'ops@example.invalid'},{}),false);
 const db=ledgerDb();const result=await adminGrantCredit(db,{admin:{email:'ops@example.invalid'},body:{email:'sam@example.invalid',amountUsd:'20',reason:'Support',requestKey:'ticket-12345'}});
 assert.equal(result.applied,true);assert.equal(db.ledger.get('admin-grant:ticket-12345').actor,'admin:ops@example.invalid');
 await assert.rejects(adminGrantCredit(db,{admin:{email:'ops@example.invalid'},body:{amountUsd:'5',reason:'x'}}),{code:400});
 const calls=[];const listed=await listCreditAccounts({query:async(sql,args)=>{calls.push(args);return {rows:[{user_id:'u-1',email:'sam@example.invalid',name:'Sam',balance_usd:'-64.48',running_workspaces:0,open_request_at:null,updated_at:null}]};}},{below:'-10'});
 assert.deepEqual(calls[0],[-10,200]);assert.equal(listed.accounts[0].amountToRestoreUsd,'54.49');
 await assert.rejects(listCreditAccounts({query:async()=>({rows:[]})},{below:'lots'}),{code:400});
});
test('reminder emails name Add funds only when it is configured',()=>{
 assert.match(creditNoticeEmail({level:'zero',balanceUsd:'-1'}).text,/Request more credit/);
 assert.match(creditNoticeEmail({level:'zero',balanceUsd:'-1',addFunds:true}).text,/choose Add funds/);
});

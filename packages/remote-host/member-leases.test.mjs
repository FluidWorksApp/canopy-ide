import test from 'node:test';
import assert from 'node:assert/strict';
import {MemberLeases} from './member-leases.mjs';
test('revocation and expiry stop member processes without an active client stream',async()=>{
 let now=0,allowed=true;const stopped=[];
 const leases=new MemberLeases({now:()=>now,authorize:async()=>{if(!allowed)throw Error('Revoked');},stop:async runtime=>stopped.push(runtime.id)});
 try{
  const runtime={id:'member-a'};await leases.open(runtime,{expiresAt:100},'one',async()=>{});
  allowed=false;await leases.checkAll();assert.deepEqual(stopped,['member-a']);assert.equal(leases.entries.size,0);
  allowed=true;await leases.open(runtime,{expiresAt:100},'two',async()=>{});now=101;
  await leases.checkAll();assert.deepEqual(stopped,['member-a','member-a']);
  await assert.rejects(leases.open(runtime,{expiresAt:100},'old',async()=>assert.fail('must not run')),/expired/);
 }finally{leases.close();}
});
test('failed stops are retained and retried before allowing another open',async()=>{
 let allowed=true,fail=true,stops=0;
 const leases=new MemberLeases({authorize:async()=>{if(!allowed)throw Error('offline');},stop:async()=>{stops++;if(fail)throw Error('Docker unavailable');}});
 try{
  const runtime={id:'member-a'},principal={expiresAt:Date.now()+60000};
  await leases.open(runtime,principal,'one',async()=>{});allowed=false;
  await leases.checkAll();assert.equal(leases.entries.size,1);
  allowed=true;await assert.rejects(leases.open(runtime,principal,'two',async()=>assert.fail('must not run')));
  fail=false;await leases.checkAll();assert.equal(leases.entries.size,0);assert.equal(stops,3);
 }finally{leases.close();}
});
test('new authorization serializes behind an in-flight revocation check',async()=>{
 let release,hold=false;const stopped=[];
 const leases=new MemberLeases({authorize:async()=>{if(hold)await new Promise(resolve=>{release=resolve;});},stop:async r=>stopped.push(r.id)});
 try{
  const runtime={id:'member-a'},principal={expiresAt:Date.now()+60000};await leases.open(runtime,principal,'old',async()=>{});
  hold=true;const check=leases.checkAll();await new Promise(resolve=>setImmediate(resolve));
  const renewed=leases.open(runtime,principal,'new',async()=>{});hold=false;release();await Promise.all([check,renewed]);
  assert.equal(leases.entries.get(runtime.id).bearer,'new');assert.deepEqual(stopped,[]);
 }finally{leases.close();}
});
test('stream renewal preserves identity and permissions and excludes stopped or expired leases',async()=>{
 let now=10;const leases=new MemberLeases({now:()=>now,authorize:async()=>{},stop:async()=>{}});
 const original={memberId:'alice',workspaceId:'workspace',accessVersion:1,scope:'drive',expiresAt:20};
 const grant={memberPrincipal:original,expiresAt:20,bearer:'old',tokenSha256:'binding'};
 try{
  await leases.open({id:'alice'}, {...original,expiresAt:100},'new',async()=>{});
  assert.deepEqual(leases.renewedGrant(grant),{...grant,memberPrincipal:{...original,expiresAt:100},expiresAt:100,bearer:'new'});
  for(const changed of [{memberId:'bob'},{workspaceId:'other'},{accessVersion:2},{scope:'admin'}]){
   const other={...grant,memberPrincipal:{...original,...changed}};
   assert.equal(leases.renewedGrant(other),other);
  }
  leases.entries.get('alice').stopping=true;assert.equal(leases.renewedGrant(grant),grant);
  leases.entries.get('alice').stopping=false;now=100;assert.equal(leases.renewedGrant(grant),grant);
 }finally{leases.close();}
});
test('a second IDE cannot shorten a renewed lease with an older credential',async()=>{
 let now=0;const stopped=[];const leases=new MemberLeases({now:()=>now,authorize:async()=>{},stop:async r=>stopped.push(r.id)});
 const runtime={id:'alice'},principal={memberId:'alice',workspaceId:'workspace',accessVersion:1,scope:'drive',expiresAt:200};
 try{
  await leases.open(runtime,principal,'fresh',async()=>{});
  await leases.open(runtime,{...principal,expiresAt:100},'older',async()=>{});
  now=150;await leases.checkAll();assert.deepEqual(stopped,[]);
  assert.equal(leases.entries.get('alice').bearer,'fresh');
  now=200;await leases.checkAll();assert.deepEqual(stopped,['alice']);
 }finally{leases.close();}
});
test('detached renewal requires trusted running container, fresh same access and bounded time since actual IDE admission',async()=>{
 let now=0,running=true,allowed=true,renewals=0;const stopped=[],principal={workspaceId:'workspace',memberId:'alice',accessVersion:1,scope:'drive',expiresAt:50000};
 const leases=new MemberLeases({now:()=>now,maxDetachedMs:100000,authorize:async()=>{if(!allowed)throw Error('Revoked');},stop:async runtime=>stopped.push(runtime.id),inspectRunning:async()=>running,renew:async(runtime,p)=>{renewals++;return {principal:{...p,expiresAt:now+120000},bearer:'fresh'};}});
 try{
  await leases.open({id:'member-a'},principal,'initial',async()=>{});now=40000;await leases.checkAll();assert.equal(renewals,1);assert.equal(leases.entries.get('member-a').bearer,'fresh');assert.equal(leases.entries.get('member-a').lastClientAt,0);
  now=110000;await leases.checkAll();assert.deepEqual(stopped,['member-a']);assert.equal(renewals,1);
  now=0;await leases.open({id:'member-b'},principal,'initial',async()=>{});running=false;await leases.checkAll();assert.deepEqual(stopped,['member-a','member-b']);assert.equal(renewals,1);
  running=true;await leases.open({id:'member-c'},principal,'initial',async()=>{});allowed=false;await leases.checkAll();assert.deepEqual(stopped,['member-a','member-b','member-c']);
 }finally{leases.close();}
});

import test from 'node:test';import assert from 'node:assert/strict';import {memberAuthority} from './member-authority.mjs';
const p={workspaceId:'ws-a',memberId:'alice',accessVersion:2,scope:'drive'};
test('authority rejects forged bindings, errors and oversized responses',async()=>{
 for(const body of [{allowed:true,...p,memberId:'bob'},{allowed:true,...p,workspaceId:'ws-b'},{allowed:true,...p,accessVersion:1},{allowed:true,...p,scope:'admin'},{allowed:false,...p},'x'.repeat(5000)]){
  const check=memberAuthority('https://canopyide.dev/api/member-access',{fetchImpl:async()=>new Response(JSON.stringify(body))});assert.equal(await check(p,'Bearer test'),false);
 }
 const check=memberAuthority('https://canopyide.dev/api/member-access',{fetchImpl:async(_url,opts)=>{assert.equal(opts.redirect,'error');assert.ok(opts.signal);return new Response(JSON.stringify({allowed:true,...p}));}});assert.equal(await check(p,'Bearer test'),true);
 assert.equal(await memberAuthority('https://canopyide.dev/api/member-access',{fetchImpl:async()=>{throw Error('offline');}})(p,'Bearer test'),false);
 for(const endpoint of ['http://canopyide.dev/api/member-access','https://user:pass@canopyide.dev/api/member-access','https://canopyide.dev/arbitrary'])assert.throws(()=>memberAuthority(endpoint));
});
test('authority returns validated project policy only for matching authenticated bindings',async()=>{
 const projectAccess={allRead:false,allWrite:false,selected:[{id:'app',writable:true}]};
 const check=body=>memberAuthority('https://canopyide.dev/api/member-access',{fetchImpl:async()=>new Response(JSON.stringify(body))})(p,'Bearer test');
 assert.deepEqual(await check({allowed:true,...p,projectAccess}),{projectAccess});
 assert.equal(await check({allowed:true,...p,projectAccess:{...projectAccess,allWrite:true}}),false);
 assert.equal(await check({allowed:true,...p,projectAccess:{...projectAccess,selected:[{id:'../owner',writable:true}]}}),false);
 assert.equal(await check({allowed:true,...p,projectAccess,padding:'x'.repeat(32768)}),false);
});
test('Git identity only travels with authenticated current membership and is validated',async()=>{
 const projectAccess={allRead:true,allWrite:true,selected:[]},gitIdentity={name:'Ada',email:'ada@example.invalid'};
 const check=body=>memberAuthority('https://canopyide.dev/api/member-access',{fetchImpl:async()=>new Response(JSON.stringify(body))})(p,'Bearer test');
 assert.deepEqual(await check({allowed:true,...p,projectAccess,gitIdentity}),{projectAccess,gitIdentity});
 assert.equal(await check({allowed:true,...p,projectAccess,gitIdentity:{...gitIdentity,name:'Injected\nAuthor'}}),false);
});
test('shared resource policy is carried only with matching identity and valid independent scopes',async()=>{
 const projectAccess={allRead:true,allWrite:false,selected:[]},sharedAccess={git:{allRead:false,allWrite:false,selected:[{id:'app',writable:true}]},agents:{allRead:false,allWrite:false,selected:[]}};
 const check=body=>memberAuthority('https://canopyide.dev/api/member-access',{fetchImpl:async()=>Response.json(body)})(p,'Bearer test');
 assert.deepEqual(await check({allowed:true,...p,projectAccess,sharedAccess}),{projectAccess,sharedAccess});
 for(const invalid of [{...sharedAccess,billing:projectAccess},{git:projectAccess},{...sharedAccess,git:{...projectAccess,allRead:false,allWrite:true}},{...sharedAccess,agents:{...projectAccess,selected:[{id:'../secret',writable:true}]}}])assert.equal(await check({allowed:true,...p,projectAccess,sharedAccess:invalid}),false);
});
test('a slow control plane is waited for, not treated as a denial',async()=>{
 const check=memberAuthority('https://canopyide.dev/api/member-access',{fetchImpl:async(_url,opts)=>{await new Promise(r=>setTimeout(r,3200));assert.equal(opts.signal.aborted,false);return Response.json({allowed:true,...p});}});
 assert.equal(await check(p,'Bearer test'),true);
});
test('allowed answers are reused briefly per credential; denials and expiry are not cached',async()=>{
 let clock=1_000_000,calls=0,body={allowed:true,...p};
 const check=memberAuthority('https://canopyide.dev/api/member-access',{now:()=>clock,fetchImpl:async()=>{calls++;return Response.json(body);}});
 const live={...p,expiresAt:clock+120_000};
 assert.equal(await check(live,'Bearer one'),true);assert.equal(await check(live,'Bearer one'),true);assert.equal(calls,1);
 await Promise.all([check(live,'Bearer two'),check(live,'Bearer two')]);assert.equal(calls,2);
 clock+=30_000;body={allowed:false,...p};
 assert.equal(await check(live,'Bearer one'),false);assert.equal(await check(live,'Bearer one'),false);assert.equal(calls,4);
 body={allowed:true,...p};const ending={...p,expiresAt:clock+1};
 assert.equal(await check(ending,'Bearer three'),true);clock+=2;assert.equal(await check(ending,'Bearer three'),true);assert.equal(calls,6);
 assert.equal(await check({...live,scope:'view'},'Bearer one'),false);
});

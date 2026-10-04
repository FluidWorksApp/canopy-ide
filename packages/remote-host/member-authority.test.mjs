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

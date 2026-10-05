import test from 'node:test';import assert from 'node:assert/strict';import {credentialAuthority} from './credential-authority.mjs';
const ws={id:'workspace',projectMounts:[{id:'app',writable:true},{id:'secret',writable:true}],desiredState:'running'};
const p={workspaceId:ws.id,memberId:'alice',expiresAt:200,bearer:'Bearer synthetic'};
const ctx={workspaceId:ws.id,memberId:p.memberId,projectId:'app',operation:'git:fetch'};
const none={allRead:false,allWrite:false,selected:[]},read={allRead:true,allWrite:false,selected:[]},app={...none,selected:[{id:'app',writable:true}]};
test('live resource authority intersects shared grant with trusted project mount',async()=>{
 let current={projectAccess:read,sharedAccess:{git:app,agents:app}},lookups=0;
 const authorize=credentialAuthority({workspaces:[ws],now:()=>100,authorizeMember:async(principal,bearer)=>{assert.equal(bearer,p.bearer);return current;},bindings:async()=>{lookups++;return 'owner-account';}});
 assert.equal((await authorize(p,ctx)).accountId,'owner-account');
 assert.equal(await authorize(p,{...ctx,operation:'git:push'}),null); // mount is read-only
 assert.equal(await authorize(p,{...ctx,projectId:'secret'}),null);
 current={...current,projectAccess:app};assert.ok(await authorize(p,{...ctx,operation:'agents:claude'}));
 current=false;assert.equal(await authorize(p,ctx),null);assert.equal(lookups,2);
});
test('expired, forged, missing or stopped contexts cannot resolve account bindings',async()=>{
 let calls=0;const authorize=credentialAuthority({workspaces:[ws],now:()=>100,authorizeMember:async()=>{calls++;return {projectAccess:app,sharedAccess:{git:app,agents:app}};},bindings:async()=>{throw Error('Must not load');}});
 for(const [principal,context] of [[{...p,expiresAt:99},ctx],[{...p,workspaceId:'other'},ctx],[{...p,memberId:'bob'},ctx],[{...p,bearer:undefined},ctx],[p,{...ctx,operation:'billing'}],[p,{...ctx,operation:'toString'}],[p,{...ctx,operation:'__proto__'}]])assert.equal(await authorize(principal,context),null);
 ws.desiredState='stopped';assert.equal(await authorize(p,ctx),null);ws.desiredState='running';assert.equal(calls,0);
});

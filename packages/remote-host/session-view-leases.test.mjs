import test from 'node:test';import assert from 'node:assert/strict';import {SessionViewLeases} from './session-view-leases.mjs';
test('observed view renewals stay bound to workspace/member/version/scope and cannot mint credentials',()=>{
 const cache=new SessionViewLeases({now:()=>10});const original={workspaceId:'ws',memberId:'alice',accessVersion:1,scope:'view',expiresAt:100},grant={memberPrincipal:original,expiresAt:100,bearer:'original'};
 for(const changed of [{workspaceId:'other'},{memberId:'bob'},{accessVersion:2},{scope:'drive'}])cache.observe({...original,...changed,expiresAt:200},'different');assert.equal(cache.renewedGrant(grant),grant);
 cache.observe({...original,expiresAt:200},'renewed');assert.equal(cache.renewedGrant(grant).bearer,'renewed');assert.equal(cache.renewedGrant(grant).expiresAt,200);cache.observe({...original,expiresAt:150},'older');assert.equal(cache.renewedGrant(grant).bearer,'renewed');
});
test('view credential cache is bounded and expired records cannot keep a stream alive',()=>{
 let now=10;const cache=new SessionViewLeases({now:()=>now,maxEntries:2});for(const memberId of ['a','b','c'])cache.observe({workspaceId:'ws',memberId,accessVersion:1,scope:'view',expiresAt:20},memberId);assert.equal(cache.entries.size,2);now=30;const grant={memberPrincipal:{workspaceId:'ws',memberId:'c',accessVersion:1,scope:'view'},expiresAt:15};assert.equal(cache.renewedGrant(grant),grant);
});

import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,chmod} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {CredentialTickets} from './credential-tickets.mjs';import {authenticate} from './policy.mjs';
const key='k'.repeat(48),now=100000,ws='ws-11111111-1111-4111-8111-111111111111',body=new TextEncoder().encode('synthetic-request'),digest=createHash('sha256').update(body).digest('hex');
const p={workspaceId:ws,memberId:'alice',accessVersion:1,scope:'drive',expiresAt:now+120000},g={...p,projectId:'app',operation:'agents:claude',accountId:'owner-account'};
async function fixture(run){const root=await mkdtemp(path.join(os.tmpdir(),'broker-tickets-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
test('ticket is purpose-bound and cannot authenticate as a management credential',()=>fixture(async root=>{
 const tickets=await CredentialTickets.initialize(root,key,{now:()=>now}),token=tickets.issue(p,g,{bodySha256:digest});
 assert.throws(()=>authenticate({managedSession:{key,workspaceId:ws},principals:[{id:'managed-account',workspaces:[ws]}]},'Bearer '+token));
 const claims=await tickets.consume(token,p,body);assert.equal(claims.accountId,g.accountId);assert.equal(claims.operation,g.operation);
}));
test('durable replay rejection survives restart and concurrent consumption',()=>fixture(async root=>{
 const tickets=await CredentialTickets.initialize(root,key,{now:()=>now}),token=tickets.issue(p,g,{bodySha256:digest});
 const results=await Promise.allSettled([tickets.consume(token,p,body),tickets.consume(token,p,body)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const restarted=await CredentialTickets.initialize(root,key,{now:()=>now});await assert.rejects(restarted.consume(token,p,body),/already used/);
}));
test('forged member, workspace, grant version, scope, payload, mode, signature and expiry are rejected',()=>fixture(async root=>{
 let time=now;const tickets=await CredentialTickets.initialize(root,key,{now:()=>time}),token=tickets.issue(p,g,{bodySha256:digest});
 for(const principal of [{...p,memberId:'bob'},{...p,workspaceId:ws.replace('11111111','22222222')},{...p,accessVersion:2},{...p,scope:'view'}])await assert.rejects(tickets.consume(token,principal,body));
 await assert.rejects(tickets.consume(token,p,new Uint8Array([1])));await assert.rejects(tickets.consume(token,p,body,{advertise:true}));await assert.rejects(tickets.consume(token.replace('ey','ez'),p,body));
 time+=30001;await assert.rejects(tickets.consume(token,p,body));
}));
test('unsafe journal permissions fail closed',()=>fixture(async root=>{await chmod(root,0o755);await assert.rejects(CredentialTickets.initialize(root,key));}));

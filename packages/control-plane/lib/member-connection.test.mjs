import test from 'node:test';
import assert from 'node:assert/strict';
import {memberConnection} from './member-connection.mjs';
import {verifyMemberToken} from './member-access.mjs';
const workspace={id:'ws-11111111-1111-4111-8111-111111111111',name:'Shared',provider:'lightsail',endpoint:'https://workspace.example',generation:4,sharing_generation:4};
const options={clientId:'11111111-1111-4111-8111-111111111111',key:'synthetic',now:100000};
const db=(role='member',sessions='private')=>({query:async sql=>{
 if(sql.startsWith('SELECT state'))return {rows:[{state:'ready',desired_state:'running',generation:4}]};
 if(sql.includes('connection_lease'))return {rows:[{id:options.clientId}]};
 if(sql.includes('owner_id'))return {rows:[{owner_id:'owner',organization_id:null}]};
 return {rows:[{role,source:'direct',permissions:{projects:'all',sessions},access_version:1}]};
}});
test('member connection issues short-lived member credentials, never owner credentials',async()=>{
 const result=await memberConnection(db(),'alice',workspace,options);
 const claims=verifyMemberToken(result.connection.token,()=>options.key,options.now);
 assert.equal(claims.version,2);assert.equal(claims.memberId,'alice');assert.equal(claims.scope,'drive');assert.equal(claims.expires,220);
});
test('unverified or recreated hosts and viewers cannot obtain an executable member connection',async()=>{
 for(const sharing_generation of [null,3])await assert.rejects(memberConnection(db(),'alice',{...workspace,sharing_generation},options),/not ready/);
 await assert.rejects(memberConnection(db('viewer'),'alice',workspace,options),/development access/);
});
test('stale sharing attestation cannot issue a token for a newer generation',async()=>{
 const source=db();let leases=0;
 const changed={query:async(sql,...args)=>{
  if(sql.startsWith('SELECT state'))return {rows:[{state:'ready',desired_state:'running',generation:5}]};
  if(sql.includes('connection_lease'))leases++;
  return source.query(sql,...args);
 }};
 await assert.rejects(memberConnection(changed,'alice',workspace,options),/not ready/);
 assert.equal(leases,0);
});
test('explicit shared-session connection preserves real viewer scope and generation gates',async()=>{
 const result=await memberConnection(db('viewer','view'),'alice',workspace,{...options,readOnly:true});const claims=verifyMemberToken(result.connection.token,()=>options.key,options.now);assert.equal(claims.scope,'view');
 await assert.rejects(memberConnection(db('viewer'),'alice',workspace,{...options,readOnly:true}),/session viewing access/);
 await assert.rejects(memberConnection(db('viewer','view'),'alice',{...workspace,sharing_generation:3},{...options,readOnly:true}),/not ready/);
 const developer=await memberConnection(db('member','interact'),'alice',workspace,{...options,readOnly:true});assert.equal(verifyMemberToken(developer.connection.token,()=>options.key,options.now).scope,'drive');
});
test('workspace browsing issues only view scope for current viewers and never changes lifecycle generation',async()=>{
 const result=await memberConnection(db('viewer'),'alice',workspace,{...options,viewWorkspace:true});assert.equal(result.connection.scope,'view');assert.equal(verifyMemberToken(result.connection.token,()=>options.key,options.now).scope,'view');assert.equal(workspace.generation,4);
 await assert.rejects(memberConnection(db('viewer'),'alice',{...workspace,sharing_generation:3},{...options,viewWorkspace:true}),/not ready/);
});

import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import {verifyMemberRenewalRequest,renewMemberRuntime} from './member-runtime-renewal.mjs';
import {accessVersion,verifyMemberToken} from './member-access.mjs';
const key='synthetic-workspace-key-123456789012345',now=100000,workspaceId='ws-11111111-1111-4111-8111-111111111111';
const grant={source:'direct',role:'member',access_version:1,permissions:{projects:'selected',projectIds:['app'],git:'personal',agents:'personal',sessions:'private'}};
const claims={version:1,purpose:'member-runtime-renewal',workspaceId,memberId:'alice',scope:'drive',accessVersion:accessVersion([grant],4),generation:4,expires:130,nonce:'a'.repeat(32)};
const sign=(c=claims,k=key)=>{const request=Buffer.from(JSON.stringify(c)).toString('base64url');return {request,signature:createHmac('sha256',k).update(request).digest('base64url')};};
function fixture(changes={},grants=[grant]){const seen=new Set(),workspace={id:workspaceId,owner_id:'owner',provider:'lightsail',state:'ready',desired_state:'running',generation:4,sharing_generation:4,instance_name:'synthetic-instance',endpoint:'https://workspace.example',...changes};const db={query:async(sql,args)=>{
 if(sql.startsWith('SELECT * FROM workspace'))return {rows:[workspace]};
 if(sql.startsWith('SELECT state'))return {rows:[workspace]};
 if(sql.startsWith('SELECT owner_id'))return {rows:[workspace]};
 if(sql.includes('FROM workspace_member'))return {rows:grants};
 if(sql.startsWith('SELECT count'))return {rows:[{n:seen.size}]};
 if(sql.startsWith('INSERT INTO member_runtime')){if(seen.has(args[1]))return {rows:[]};seen.add(args[1]);return {rows:[{nonce:args[1]}]};}
 return {rows:[]};
 }};const instance={name:workspace.instance_name,state:{name:'running'},tags:[{key:'canopy-workspace',value:workspaceId},{key:'managed-by',value:'canopy'}]};return {db,instance,options:{key,providerFor:()=>({instance:async()=>instance}),expectedEndpoint:()=> 'https://workspace.example',now:()=>now}};}
test('fresh purpose-bound host proofs verify with exactly their workspace key',()=>{
 assert.deepEqual(verifyMemberRenewalRequest(sign(),id=>{assert.equal(id,workspaceId);return key;},now),claims);
 for(const changed of [{purpose:'runtime-policy'},{version:2},{expires:100},{expires:131},{nonce:'wrong'},{memberId:'other',extra:'claim'}])assert.throws(()=>verifyMemberRenewalRequest(sign({...claims,...changed}),()=>key,now));
 assert.throws(()=>verifyMemberRenewalRequest(sign(),()=>key+'other',now));
 assert.throws(()=>verifyMemberRenewalRequest({...sign(),bearer:'container'},()=>key,now));
});
test('renewal returns only a short V2 credential for the original actor, version and scope',async()=>{
 const f=fixture(),result=await renewMemberRuntime(f.db,claims,f.options),token=verifyMemberToken(result.token,()=>key,now);
 assert.equal(token.version,2);assert.equal(token.memberId,'alice');assert.equal(token.accessVersion,claims.accessVersion);assert.equal(token.scope,'drive');assert.equal(token.expires,220);assert.deepEqual(Object.keys(result).sort(),['accessVersion','memberId','scope','token','workspaceId']);
 await assert.rejects(renewMemberRuntime(f.db,claims,f.options),/unavailable/);
});
test('intentional shutdown, stale generation/attestation, owner credentials and mismatched provider identity fail closed',async()=>{
 for(const change of [{desired_state:'stopped'},{state:'starting'},{generation:5},{sharing_generation:null},{owner_id:'alice'},{provider:'ec2'},{endpoint:'https://other.example'}]){const f=fixture(change);await assert.rejects(renewMemberRuntime(f.db,claims,f.options));}
 for(const mutate of [i=>{i.state.name='stopped';},i=>{i.name='other';},i=>{i.tags=[];},i=>{i.tags[0].value='other-workspace';}]){const f=fixture();mutate(f.instance);await assert.rejects(renewMemberRuntime(f.db,claims,f.options));}
});
test('removed/rejoined grants, role or project changes never renew an old actor',async()=>{
 for(const grants of [[],[{...grant,access_version:2}],[{...grant,permissions:{projects:'all'}}],[{...grant,role:'viewer'}]]){const f=fixture({},grants);await assert.rejects(renewMemberRuntime(f.db,claims,f.options));}
 const f=fixture();await assert.rejects(renewMemberRuntime(f.db,{...claims,scope:'view'},f.options));
});
test('concurrent copies of the same renewal proof admit exactly one token',async()=>{
 const f=fixture();const results=await Promise.allSettled([renewMemberRuntime(f.db,claims,f.options),renewMemberRuntime(f.db,claims,f.options)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});

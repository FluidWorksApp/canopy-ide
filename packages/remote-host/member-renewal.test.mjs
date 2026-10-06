import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {memberRenewal} from './member-renewal.mjs';
const id='ws-11111111-1111-4111-8111-111111111111',key='k'.repeat(48),workspace={id,generation:2},config={workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key,memberRenewalUrl:'https://canopyide.dev/api/member-runtime-renewal'}},principal={workspaceId:id,memberId:'alice',accessVersion:3,scope:'drive'},runtime={id:'member-a',parentWorkspaceId:id};
function result(changes={}){const claims={version:2,...principal,expires:Math.floor(Date.now()/1000)+120,...changes},payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return {token:payload+'.'+createHmac('sha256',key).update(payload).digest('base64url'),...principal};}
test('host detached renewal signs a purpose/generation/nonce-bound request and accepts only same actor/version/scope tokens',async()=>{
 const nonces=[];let changed={};const renew=memberRenewal(config,{fetchImpl:async(url,options)=>{assert.equal(url,'https://canopyide.dev/api/member-runtime-renewal');assert.equal(options.redirect,'error');const body=JSON.parse(options.body);assert.equal(body.signature,createHmac('sha256',key).update(body.request).digest('base64url'));const claims=JSON.parse(Buffer.from(body.request,'base64url').toString());assert.equal(claims.purpose,'member-runtime-renewal');assert.equal(claims.generation,2);assert.equal(claims.memberId,'alice');nonces.push(claims.nonce);return Response.json(result(changed));}});
 const renewed=await renew(runtime,principal);assert.equal(renewed.principal.memberId,'alice');assert.ok(renewed.bearer.startsWith('Bearer '));await renew(runtime,principal);assert.notEqual(nonces[0],nonces[1]);
 for(const value of [{memberId:'bob'},{accessVersion:4},{scope:'view'},{version:undefined}]){changed=value;await assert.rejects(renew(runtime,principal),/Member renewal unavailable/);}
});
test('stopped desired state cannot sign or request detached renewal',async()=>{
 const renew=memberRenewal({...config,workspaces:[{...workspace,desiredState:'stopped'}]},{fetchImpl:async()=>assert.fail('No network call')});await assert.rejects(renew(runtime,principal));
});
test('forged hanging response is deadline-bound and collaboration IDs cannot use external member renewal',async()=>{
 const renew=memberRenewal(config,{timeoutMs:20,fetchImpl:async()=>new Promise(()=>{})});await assert.rejects(renew(runtime,principal),/Member renewal unavailable/);
 const blocked=memberRenewal(config,{fetchImpl:async()=>assert.fail('No network call')});await assert.rejects(blocked(runtime,{...principal,memberId:'collaboration:fake'}));
});

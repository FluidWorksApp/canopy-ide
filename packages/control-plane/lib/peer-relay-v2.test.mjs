import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {createHmac,createPrivateKey,createPublicKey,diffieHellman,hkdfSync,createDecipheriv,generateKeyPairSync,sign,verify,randomUUID} from 'node:crypto';
import {relayEnvelope,envelopeHeader,hostRegistration,PERSON_LIFETIME_MS,WORKSPACE_LIFETIME_MS} from './peer-messaging.mjs';
import {verifyServiceHostToken} from './service-host-auth.mjs';
import {principalAuthority,accessSnapshot,accessVerifyKeys,setTeamDelivery,SNAPSHOT_TTL_MS} from './workspace-service-access.mjs';

const vectorPath=[new URL('../../../src/teamMessaging/fixtures/relay-v2-vector.json',import.meta.url)].find(u=>existsSync(u));
const team='11111111-1111-4111-8111-111111111111',ws='ws-22222222-2222-4222-8222-222222222222';
function device(user){const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const jwk=publicKey.export({format:'jwk'});const id=randomUUID();return {id,user_id:user,privateKey,public_keys:{signing:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},agreement:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}}};}
function envelope(from,to,{version=2,kind='job',workspace=ws,created=Date.now(),life=WORKSPACE_LIFETIME_MS}={}){
 const eph=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'});
 const e={version,id:randomUUID(),...(version===2?{kind}:{}),from:{team,user:from.user_id,device:from.id},to:{team,user:to.user_id,device:to.id,...(workspace?{workspace}:{})},created,expires:created+life,ephemeral:{kty:'EC',crv:'P-256',x:eph.x,y:eph.y},iv:Buffer.alloc(12,7).toString('base64'),ciphertext:Buffer.from('opaque').toString('base64')};
 e.signature=sign('sha256',Buffer.from(JSON.stringify([envelopeHeader(e,e.ephemeral),e.ciphertext])),{key:from.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 return e;
}
const alice=device('user-alice'),host=device('user-owner');

test('v1 person traffic keeps exactly five minutes',()=>{
 const e=envelope(alice,host,{version:1,workspace:null,life:PERSON_LIFETIME_MS});
 const stored=relayEnvelope({teamId:team,envelope:e},'user-alice',alice,host);
 assert.equal(stored.version,1);assert.equal(stored.kind,undefined);assert.equal(stored.to.workspace,undefined);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{version:1,workspace:null,life:PERSON_LIFETIME_MS+1})},'user-alice',alice,host),/Invalid relay envelope/);
 // A v1 envelope cannot smuggle a seven-day lifetime through a workspace field.
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{version:1,life:WORKSPACE_LIFETIME_MS})},'user-alice',alice,host),/Invalid relay envelope/);
});

test('v2 workspace traffic lives up to seven days and binds kind and workspace',()=>{
 const e=envelope(alice,host);const stored=relayEnvelope({teamId:team,envelope:{...e,extra:'plaintext'}},'user-alice',alice,host);
 assert.deepEqual(stored.to,{team,user:'user-owner',device:host.id,workspace:ws});assert.equal(stored.kind,'job');assert.equal(stored.extra,undefined);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{life:WORKSPACE_LIFETIME_MS+1})},'user-alice',alice,host),/Invalid relay envelope/);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{life:0})},'user-alice',alice,host),/Invalid relay envelope/);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{workspace:null})},'user-alice',alice,host),/Invalid relay envelope/);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{kind:'telepathy'})},'user-alice',alice,host),/Invalid relay envelope/);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{workspace:'../etc'})},'user-alice',alice,host),/Invalid relay envelope/);
 // v2 chat without a workspace keeps the person window.
 relayEnvelope({teamId:team,envelope:envelope(alice,host,{kind:'chat',workspace:null,life:PERSON_LIFETIME_MS})},'user-alice',alice,host);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:envelope(alice,host,{kind:'chat',workspace:null,life:WORKSPACE_LIFETIME_MS})},'user-alice',alice,host),/Invalid relay envelope/);
 // Workspace and kind are signed: rewriting either breaks the signature.
 assert.throws(()=>relayEnvelope({teamId:team,envelope:{...e,to:{...e.to,workspace:'ws-33333333-3333-4333-8333-333333333333'}}},'user-alice',alice,host),/signature/);
 assert.throws(()=>relayEnvelope({teamId:team,envelope:{...e,kind:'mesh'}},'user-alice',alice,host),/signature/);
});

test('unknown envelope versions are rejected',()=>{
 for(const version of [0,3,'2',null])assert.throws(()=>relayEnvelope({teamId:team,envelope:{...envelope(alice,host),version}},'user-alice',alice,host),/Invalid relay envelope/);
});

test('the shared v2 vector verifies at the relay and decrypts with the documented KDF',{skip:!vectorPath},async()=>{
 const vector=JSON.parse(await readFile(vectorPath,'utf8'));assert.equal(vector.testOnly,true);
 const sender={id:vector.sender.address.device,public_keys:vector.sender.publicKeys},recipient={id:vector.recipient.address.device,user_id:vector.recipient.address.user};
 for(const {name,plaintext,envelope:e} of vector.vectors){
  const stored=relayEnvelope({teamId:e.from.team,envelope:e},vector.sender.address.user,sender,recipient,vector.created);
  assert.equal(stored.kind,name);assert.equal(stored.to.workspace,vector.workspace);
  const header=envelopeHeader(e,e.ephemeral);
  const shared=diffieHellman({privateKey:createPrivateKey({key:vector.recipient.agreementPrivateJwk,format:'jwk'}),publicKey:createPublicKey({key:e.ephemeral,format:'jwk'})});
  const key=Buffer.from(hkdfSync('sha256',shared,Buffer.from('canopy-im-v1'),Buffer.from(header),32));
  const data=Buffer.from(e.ciphertext,'base64'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));
  decipher.setAAD(Buffer.from(header));decipher.setAuthTag(data.subarray(data.length-16));
  const text=Buffer.concat([decipher.update(data.subarray(0,data.length-16)),decipher.final()]).toString();
  assert.deepEqual(JSON.parse(text),typeof plaintext==='string'?JSON.parse(plaintext):plaintext);
  assert.equal(JSON.parse(text).kind,name);
 }
});

test('host registration names exactly the authenticated workspace',()=>{
 const keys={agreement:alice.public_keys.agreement,signing:alice.public_keys.signing};
 assert.deepEqual(hostRegistration(ws,{deviceId:alice.id,keys,workspaceIds:[ws]}).signing,keys.signing);
 for(const workspaceIds of [[],[ws,ws],['ws-33333333-3333-4333-8333-333333333333'],undefined])assert.throws(()=>hostRegistration(ws,{deviceId:alice.id,keys,workspaceIds}),/only the workspace/);
 const created=Date.now(),proof=sign('sha256',Buffer.from(JSON.stringify(['canopy-host-device-v1',ws,alice.id,created,keys.agreement.x,keys.agreement.y,keys.signing.x,keys.signing.y])),{key:alice.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 hostRegistration(ws,{deviceId:alice.id,keys,workspaceIds:[ws],created,proof});
 assert.throws(()=>hostRegistration(ws,{deviceId:alice.id,keys,workspaceIds:[ws],created:created+1,proof}),/signature/);
});

test('host credentials are purpose-bound, short-lived and keyed per workspace',()=>{
 const key='k'.repeat(48),now=Date.now(),wsId='ws-'+randomUUID();
 const token=(claims,k=key)=>{const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${payload}.${createHmac('sha256',k).update(payload).digest('base64url')}`;};
 const claims={version:1,kind:'peer-relay',workspaceId:wsId,generation:4,expires:Math.floor(now/1000)+60};
 assert.equal(verifyServiceHostToken(token(claims),()=>key,'peer-relay',now).generation,4);
 assert.throws(()=>verifyServiceHostToken(token(claims),()=>key,'workspace-access-snapshot',now),/Invalid host credential/);
 assert.throws(()=>verifyServiceHostToken(token({...claims,kind:'runtime-policy',version:3}),()=>key,'peer-relay',now),/Invalid host credential/);
 assert.throws(()=>verifyServiceHostToken(token({...claims,expires:Math.floor(now/1000)+600}),()=>key,'peer-relay',now),/Invalid host credential/);
 assert.throws(()=>verifyServiceHostToken(token({...claims,expires:Math.floor(now/1000)-1}),()=>key,'peer-relay',now),/Invalid host credential/);
 assert.throws(()=>verifyServiceHostToken(token(claims,'x'.repeat(48)),()=>key,'peer-relay',now),/Invalid host credential/);
});

test('principal authority keeps each grant whole',()=>{
 const g=(role,permissions)=>({role,permissions});
 assert.deepEqual(principalAuthority([g('member',{projects:'all',sessions:'interact'})]),{sessionsInteract:true,projects:'all'});
 // A viewer cannot interact even with an interact switch; a project-scoped
 // interact grant does not inherit a separate workspace-wide grant's scope.
 assert.deepEqual(principalAuthority([g('viewer',{projects:'all',sessions:'interact'})]),{sessionsInteract:false,projects:[]});
 assert.deepEqual(principalAuthority([g('member',{projects:'all',sessions:'view'}),g('member',{projects:'selected',projectIds:['b','a'],sessions:'interact'})]),{sessionsInteract:true,projects:['a','b']});
 assert.deepEqual(principalAuthority([g('member',{projects:'all',sessions:'private'})]),{sessionsInteract:false,projects:[]});
});

function fakeDb(handlers){return {calls:[],async query(sql,params){this.calls.push([sql,params]);for(const [match,rows] of handlers)if(match.test(sql))return {rows:typeof rows==='function'?rows(params):rows};return {rows:[]};}};}
test('access snapshots are signed over the exact payload bytes',async()=>{
 const {privateKey}=generateKeyPairSync('ed25519'),signing={kid:'test-2026',key:privateKey},now=1_800_000_000_000;
 const db=fakeDb([[/FROM workspace WHERE id=\$1 AND deleted_at IS NULL$/,[{id:ws,owner_id:'owner',team_delivery:true,access_revision:'42'}]],[/FROM peer_device/,[{id:host.id}]],[/UNION/,[{user_id:'owner'},{user_id:'viewer'},{user_id:'dev'}]],[/SELECT owner_id,organization_id FROM workspace/,[{owner_id:'owner',organization_id:null}]],[/FROM workspace_member WHERE workspace_id=\$1 AND user_id=\$2/,params=>params[1]==='dev'?[{role:'member',permissions:{projects:'all',sessions:'interact'},access_version:1}]:[{role:'viewer',permissions:{projects:'all',sessions:'view'},access_version:1}]]]);
 const body=await accessSnapshot(db,{workspaceId:ws,signing,now});
 const keys=accessVerifyKeys(signing),raw=Buffer.from(keys['test-2026'],'base64');assert.equal(raw.length,32);
 const publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:raw.toString('base64url')},format:'jwk'});
 const bytes=Buffer.from(body.payload,'base64');assert.equal(verify(null,bytes,publicKey,Buffer.from(body.signature,'base64')),true);
 const snapshot=JSON.parse(bytes.toString('utf8'));
 assert.deepEqual(snapshot,{v:1,kid:'test-2026',workspaceId:ws,serviceDevice:host.id,revision:42,issuedAt:now,expiresAt:now+SNAPSHOT_TTL_MS,teamDelivery:true,ownerUserId:'owner',principals:[{userId:'owner',sessionsInteract:true,projects:'all'},{userId:'viewer',sessionsInteract:false,projects:[]},{userId:'dev',sessionsInteract:true,projects:'all'}]});
 assert.equal(verify(null,Buffer.from(JSON.stringify({...snapshot,teamDelivery:false})),publicKey,Buffer.from(body.signature,'base64')),false);
});

test('only the owner toggles teammate delivery, and it is audited',async()=>{
 const db=fakeDb([[/FOR UPDATE/,[{id:ws,owner_id:'owner'}]]]);
 await assert.rejects(()=>setTeamDelivery(db,'teammate',{workspaceId:ws,enabled:true}),/Only the workspace owner/);
 await assert.rejects(()=>setTeamDelivery(db,'owner',{workspaceId:ws,enabled:'yes'}),/on or off/);
 assert.deepEqual(await setTeamDelivery(db,'owner',{workspaceId:ws,enabled:true}),{teamDelivery:true});
 assert.ok(db.calls.some(([sql,params])=>/workspace_access_audit/.test(sql)&&params[2]==='team-delivery-on'));
});

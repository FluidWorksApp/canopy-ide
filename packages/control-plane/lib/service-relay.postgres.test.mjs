import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID,generateKeyPairSync,sign,createPublicKey,verify} from 'node:crypto';import {createRequire} from 'node:module';
import {peerAction,hostPeerAction,envelopeHeader,WORKSPACE_LIFETIME_MS,PERSON_LIFETIME_MS} from './peer-messaging.mjs';
import {currentHostWorkspace} from './service-host-auth.mjs';
import {accessSnapshot,setTeamDelivery} from './workspace-service-access.mjs';
const connectionString=process.env.CANOPY_SYNTHETIC_DATABASE_URL;
function identity(){const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const {x,y}=publicKey.export({format:'jwk'});const jwk={kty:'EC',crv:'P-256',x,y};return {id:randomUUID(),privateKey,keys:{agreement:jwk,signing:jwk}};}
const signB64=(key,text)=>sign('sha256',Buffer.from(text),{key,dsaEncoding:'ieee-p1363'}).toString('base64');
function registration(user,d){const created=Date.now();return {action:'register',deviceId:d.id,created,keys:d.keys,proof:signB64(d.privateKey,JSON.stringify(['canopy-device-v1',user,d.id,created,d.keys.agreement.x,d.keys.agreement.y,d.keys.signing.x,d.keys.signing.y]))};}
function envelope(team,from,fromUser,to,toUser,{version=2,kind='job',workspace,life=WORKSPACE_LIFETIME_MS}={}){
 const created=Date.now(),eph=identity().keys.agreement;
 const e={version,id:randomUUID(),...(version===2?{kind}:{}),from:{team,user:fromUser,device:from.id},to:{team,user:toUser,device:to.id,...(workspace?{workspace}:{})},created,expires:created+life,ephemeral:eph,iv:Buffer.alloc(12,1).toString('base64'),ciphertext:Buffer.from('sealed').toString('base64')};
 e.signature=signB64(from.privateKey,JSON.stringify([envelopeHeader(e,eph),e.ciphertext]));return e;
}
test('real Postgres relay v2, host devices, caps, revision triggers and snapshots',{skip:!connectionString},async()=>{
 assert.equal(new URL(connectionString).hostname,'127.0.0.1');assert.equal(new URL(connectionString).port,'55461');assert.equal(new URL(connectionString).username,'canopy_validation');
 const require=createRequire(process.env.CANOPY_SYNTHETIC_PG_PACKAGE_JSON??new URL('../../../package.json',import.meta.url));const {Pool}=require('pg');const pool=new Pool({connectionString});const db=await pool.connect();
 try{await db.query('BEGIN');await db.query(await readFile(new URL('../service-relay-schema.sql',import.meta.url),'utf8'));
 const [owner,alice,bob,carol]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()],org=randomUUID(),team=randomUUID(),ws='ws-'+randomUUID();
 for(const id of [owner,alice,bob,carol])await db.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)',[id,id+'@example.invalid']);
 await db.query('INSERT INTO organization(id,name,created_by) VALUES($1,$2,$3)',[org,'Synthetic org',owner]);
 await db.query("INSERT INTO organization_member(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member')",[org,owner,alice,bob,carol]);
 await db.query("INSERT INTO workspace(id,owner_id,name,organization_id,state,desired_state,generation) VALUES($1,$2,'Synthetic relay',$3,'ready','running',7)",[ws,owner,org]);
 await db.query('INSERT INTO team(id,name,owner_id,organization_id) VALUES($1,$2,$3,$4)',[team,'Synthetic team',owner,org]);
 await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')",[team,owner,alice,bob]);
 const revision=async()=>Number((await db.query('SELECT access_revision FROM workspace WHERE id=$1',[ws])).rows[0].access_revision);
 const start=await revision();
 await db.query("INSERT INTO workspace_member(workspace_id,user_id,role,permissions) VALUES($1,$2,'member',$3)",[ws,alice,JSON.stringify({projects:'all',sessions:'interact'})]);
 const granted=await revision();assert.ok(granted>start);

 const aliceDevice=identity(),bobDevice=identity(),ownerDevice=identity(),hostDevice=identity();
 for(const [user,d] of [[alice,aliceDevice],[bob,bobDevice],[owner,ownerDevice]])await peerAction(db,{id:user},registration(user,d));
 const w=await currentHostWorkspace(db,{workspaceId:ws,generation:7});
 await assert.rejects(()=>currentHostWorkspace(db,{workspaceId:ws,generation:6}),/not current/);
 const reg={kind:'peer-host-registration',workspaceId:ws,generation:7},relayClaims={kind:'peer-relay',workspaceId:ws,generation:7};
 await assert.rejects(()=>hostPeerAction(db,reg,w,{action:'register-host',deviceId:hostDevice.id,keys:hostDevice.keys,workspaceIds:['ws-'+randomUUID()]}),/only the workspace/);
 await assert.rejects(()=>hostPeerAction(db,relayClaims,w,{action:'register-host',deviceId:hostDevice.id,keys:hostDevice.keys,workspaceIds:[ws]}),/Invalid host credential/);
 assert.deepEqual(await hostPeerAction(db,reg,w,{action:'register-host',deviceId:hostDevice.id,keys:hostDevice.keys,workspaceIds:[ws]}),{registered:true});
 assert.deepEqual(await hostPeerAction(db,reg,w,{action:'register-host',deviceId:hostDevice.id,keys:hostDevice.keys,workspaceIds:[ws]}),{registered:true});
 // A user device id cannot be re-registered as a host, nor a host as a user device.
 await assert.rejects(()=>hostPeerAction(db,reg,w,{action:'register-host',deviceId:aliceDevice.id,keys:aliceDevice.keys,workspaceIds:[ws]}),/cannot be replaced/);
 await assert.rejects(()=>peerAction(db,{id:owner},registration(owner,hostDevice)),/cannot be replaced/);

 const aliceDirectory=await peerAction(db,{id:alice},{action:'directory',teamId:team,deviceId:aliceDevice.id});
 assert.deepEqual(aliceDirectory.hosts.map(h=>[h.id,h.kind,h.workspaceIds]),[[hostDevice.id,'host',[ws]]]);
 assert.ok(aliceDirectory.devices.every(d=>d.kind==='user'&&d.workspaceIds.length===0));
 assert.deepEqual((await peerAction(db,{id:bob},{action:'directory',teamId:team,deviceId:bobDevice.id})).hosts,[]);

 const job=envelope(team,aliceDevice,alice,hostDevice,owner,{workspace:ws});
 assert.deepEqual(await peerAction(db,{id:alice},{action:'relay',teamId:team,deviceId:aliceDevice.id,recipientDevice:hostDevice.id,envelope:job}),{queued:true});
 await assert.rejects(()=>peerAction(db,{id:bob},{action:'relay',teamId:team,deviceId:bobDevice.id,recipientDevice:hostDevice.id,envelope:envelope(team,bobDevice,bob,hostDevice,owner,{workspace:ws})}),/do not have access/);
 await assert.rejects(()=>peerAction(db,{id:alice},{action:'relay',teamId:team,deviceId:aliceDevice.id,recipientDevice:hostDevice.id,envelope:envelope(team,aliceDevice,alice,hostDevice,owner,{workspace:'ws-'+randomUUID()})}),/does not serve/);
 await assert.rejects(()=>peerAction(db,{id:alice},{action:'relay',teamId:team,deviceId:aliceDevice.id,recipientDevice:hostDevice.id,envelope:envelope(team,aliceDevice,alice,hostDevice,owner,{version:1,life:PERSON_LIFETIME_MS})}),/does not serve/);
 // v1 person chat keeps working beside v2.
 assert.deepEqual(await peerAction(db,{id:alice},{action:'relay',teamId:team,deviceId:aliceDevice.id,recipientDevice:bobDevice.id,envelope:envelope(team,aliceDevice,alice,bobDevice,bob,{version:1,life:PERSON_LIFETIME_MS})}),{queued:true});
 assert.equal((await peerAction(db,{id:bob},{action:'poll',teamId:team,deviceId:bobDevice.id})).envelopes[0].envelope.version,1);
 await assert.rejects(()=>peerAction(db,{id:alice},{action:'relay',teamId:team,deviceId:aliceDevice.id,recipientDevice:bobDevice.id,envelope:envelope(team,aliceDevice,alice,bobDevice,bob,{workspace:ws})}),/workspace host/);

 const polled=await hostPeerAction(db,relayClaims,w,{action:'poll',deviceId:hostDevice.id});
 assert.equal(polled.envelopes.length,1);assert.equal(polled.envelopes[0].envelope.kind,'job');assert.deepEqual(polled.envelopes[0].sender,{id:aliceDevice.id,userId:alice,kind:'user',workspaceIds:[],publicKeys:aliceDevice.keys});
 // A credential for another workspace on the same device sees nothing of this one.
 const otherWs='ws-'+randomUUID();await db.query("INSERT INTO workspace(id,owner_id,name,state,desired_state,generation) VALUES($1,$2,'Other synthetic',$3,'running',1)",[otherWs,owner,'ready']);
 await db.query('UPDATE peer_device SET workspace_ids=array_append(workspace_ids,$2) WHERE id=$1',[hostDevice.id,otherWs]);
 const otherW=await currentHostWorkspace(db,{workspaceId:otherWs,generation:1});
 assert.deepEqual((await hostPeerAction(db,{...relayClaims,workspaceId:otherWs,generation:1},otherW,{action:'poll',deviceId:hostDevice.id})).envelopes,[]);
 await hostPeerAction(db,{...relayClaims,workspaceId:otherWs,generation:1},otherW,{action:'ack',deviceId:hostDevice.id,ids:[polled.envelopes[0].id]});
 assert.equal((await hostPeerAction(db,relayClaims,w,{action:'poll',deviceId:hostDevice.id})).envelopes.length,1);
 await hostPeerAction(db,relayClaims,w,{action:'ack',deviceId:hostDevice.id,ids:[polled.envelopes[0].id]});
 assert.equal((await hostPeerAction(db,relayClaims,w,{action:'poll',deviceId:hostDevice.id})).envelopes.length,0);

 const hostDirectory=await hostPeerAction(db,relayClaims,w,{action:'directory',deviceId:hostDevice.id,teamId:team});
 assert.ok(hostDirectory.devices.some(d=>d.id===hostDevice.id&&d.kind==='host'));
 const status=envelope(team,hostDevice,owner,aliceDevice,alice,{kind:'job-status',workspace:ws});
 assert.deepEqual(await hostPeerAction(db,relayClaims,w,{action:'relay',deviceId:hostDevice.id,teamId:team,recipientDevice:aliceDevice.id,envelope:status}),{queued:true});
 await assert.rejects(()=>hostPeerAction(db,relayClaims,w,{action:'relay',deviceId:hostDevice.id,teamId:team,recipientDevice:bobDevice.id,envelope:envelope(team,hostDevice,owner,bobDevice,bob,{kind:'job-status',workspace:ws})}),/no access/);
 const alicePoll=await peerAction(db,{id:alice},{action:'poll',teamId:team,deviceId:aliceDevice.id});
 assert.equal(alicePoll.envelopes[0].envelope.kind,'job-status');assert.equal(alicePoll.envelopes[0].sender.kind,'host');
 await peerAction(db,{id:alice},{action:'ack',teamId:team,deviceId:aliceDevice.id,ids:[alicePoll.envelopes[0].id]});
 // A team the owner is not on carries no host traffic.
 const lonely=randomUUID();await db.query('INSERT INTO team(id,name,owner_id,organization_id) VALUES($1,$2,$3,$4)',[lonely,'No owner',alice,org]);await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'owner')",[lonely,alice]);
 await assert.rejects(()=>hostPeerAction(db,relayClaims,w,{action:'directory',deviceId:hostDevice.id,teamId:lonely}),/Team not found/);

 // Per-recipient caps: 1000 envelopes, then 32 MiB.
 await db.query("INSERT INTO peer_relay(team_id,sender_device,recipient_device,envelope,expires_at,size_bytes) SELECT $1,$2,$3,jsonb_build_object('id',gen_random_uuid()),now()+interval '1 day',10 FROM generate_series(1,1000)",[team,ownerDevice.id,hostDevice.id]);
 await assert.rejects(()=>peerAction(db,{id:alice},{action:'relay',teamId:team,deviceId:aliceDevice.id,recipientDevice:hostDevice.id,envelope:envelope(team,aliceDevice,alice,hostDevice,owner,{workspace:ws})}),/Recipient queue is full/);
 await db.query('DELETE FROM peer_relay WHERE recipient_device=$1',[hostDevice.id]);
 await db.query("INSERT INTO peer_relay(team_id,sender_device,recipient_device,envelope,expires_at,size_bytes) VALUES($1,$2,$3,'{\"id\":\"big\"}',now()+interval '1 day',$4)",[team,ownerDevice.id,hostDevice.id,32*1024*1024-100]);
 await assert.rejects(()=>peerAction(db,{id:alice},{action:'relay',teamId:team,deviceId:aliceDevice.id,recipientDevice:hostDevice.id,envelope:envelope(team,aliceDevice,alice,hostDevice,owner,{workspace:ws})}),/Recipient queue is full/);
 await db.query('DELETE FROM peer_relay WHERE recipient_device=$1',[hostDevice.id]);

 // Signed snapshot: complete grant evaluation and a revision every input moves.
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),signing={kid:'synthetic',key:privateKey};
 const read=async()=>{const body=await accessSnapshot(db,{workspaceId:ws,signing});const bytes=Buffer.from(body.payload,'base64');assert.equal(verify(null,bytes,publicKey,Buffer.from(body.signature,'base64')),true);return JSON.parse(bytes);};
 let snapshot=await read();
 assert.equal(snapshot.serviceDevice,hostDevice.id);assert.equal(snapshot.teamDelivery,false);assert.equal(snapshot.ownerUserId,owner);
 assert.deepEqual(snapshot.principals.find(p=>p.userId===alice),{userId:alice,sessionsInteract:true,projects:'all'});
 assert.equal(snapshot.principals.some(p=>p.userId===bob),false);
 const bumps=[];const step=async(label,fn)=>{const before=await revision();await fn();const after=await revision();assert.ok(after>before,`${label} must bump the revision`);bumps.push(label);};
 await step('team delivery',()=>setTeamDelivery(db,owner,{workspaceId:ws,enabled:true}));
 await assert.rejects(()=>setTeamDelivery(db,alice,{workspaceId:ws,enabled:false}),/Only the workspace owner/);
 assert.equal((await read()).teamDelivery,true);
 await step('team grant',()=>db.query("INSERT INTO workspace_team_access(workspace_id,team_id,role,permissions) VALUES($1,$2,'viewer',$3)",[ws,team,JSON.stringify({projects:'all',sessions:'interact'})]));
 snapshot=await read();assert.deepEqual(snapshot.principals.find(p=>p.userId===bob),{userId:bob,sessionsInteract:false,projects:[]});
 await step('team membership removal',()=>db.query('UPDATE team_member SET removed_at=now() WHERE team_id=$1 AND user_id=$2',[team,bob]));
 assert.equal((await read()).principals.some(p=>p.userId===bob),false);
 await step('organization grant',()=>db.query("INSERT INTO workspace_organization_access(workspace_id,organization_id,role,permissions) VALUES($1,$2,'member',$3)",[ws,org,JSON.stringify({projects:'selected',projectIds:['app'],sessions:'interact'})]));
 assert.deepEqual((await read()).principals.find(p=>p.userId===carol),{userId:carol,sessionsInteract:true,projects:['app']});
 await step('organization membership removal',()=>db.query('UPDATE organization_member SET removed_at=now() WHERE organization_id=$1 AND user_id=$2',[org,carol]));
 assert.equal((await read()).principals.some(p=>p.userId===carol),false);
 await step('direct revoke',()=>db.query('UPDATE workspace_member SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2',[ws,alice]));
 assert.deepEqual((await read()).principals.find(p=>p.userId===alice),{userId:alice,sessionsInteract:true,projects:['app']});
 await step('grant row deleted',()=>db.query('DELETE FROM workspace_organization_access WHERE workspace_id=$1',[ws]));
 assert.deepEqual((await read()).principals.find(p=>p.userId===alice),{userId:alice,sessionsInteract:false,projects:[]});
 const unrelated=await revision();await db.query("UPDATE workspace SET name='Renamed synthetic' WHERE id=$1",[ws]);assert.equal(await revision(),unrelated);
 assert.ok((await read()).revision>granted);

 // Host replacement: the new device takes the workspace; the old one, serving nothing else, is revoked.
 await db.query('UPDATE peer_device SET workspace_ids=ARRAY[$2]::text[] WHERE id=$1',[hostDevice.id,ws]);
 const replacement=identity();
 await hostPeerAction(db,reg,w,{action:'register-host',deviceId:replacement.id,keys:replacement.keys,workspaceIds:[ws]});
 const old=(await db.query('SELECT revoked_at,workspace_ids FROM peer_device WHERE id=$1',[hostDevice.id])).rows[0];assert.ok(old.revoked_at);assert.deepEqual(old.workspace_ids,[]);
 await assert.rejects(()=>hostPeerAction(db,relayClaims,w,{action:'poll',deviceId:hostDevice.id}),/does not serve/);
 assert.equal((await read()).serviceDevice,replacement.id);
 }finally{await db.query('ROLLBACK');db.release();await pool.end();}
});

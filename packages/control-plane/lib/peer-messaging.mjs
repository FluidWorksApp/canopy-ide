import {createPublicKey,verify} from 'node:crypto';
import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const workspaceId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
export const ENVELOPE_KINDS=['chat','mesh','job','job-status'];
export const PERSON_LIFETIME_MS=300000,WORKSPACE_LIFETIME_MS=604800000;
export const RECIPIENT_MAX_ENVELOPES=1000,RECIPIENT_MAX_BYTES=32*1024*1024,SENDER_MAX_ENVELOPES=200;
function publicKey(jwk){
 if(!jwk||jwk.kty!=='EC'||jwk.crv!=='P-256'||typeof jwk.x!=='string'||typeof jwk.y!=='string'||jwk.x.length!==43||jwk.y.length!==43||jwk.d)fail(400,'Invalid device key');
 const value={kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y};try{createPublicKey({key:value,format:'jwk'});}catch{fail(400,'Invalid device key');}return value;
}
function signature(key,data,encoded){
 if(typeof encoded!=='string'||encoded.length>100)return false;
 const sig=Buffer.from(encoded,'base64');if(sig.length!==64||sig.toString('base64')!==encoded)return false;
 return verify('sha256',Buffer.from(data),{key:createPublicKey({key,format:'jwk'}),dsaEncoding:'ieee-p1363'},sig);
}
const deviceKeys=input=>({agreement:publicKey(input.keys?.agreement),signing:publicKey(input.keys?.signing)});
export function registrationProof(userId,input,now=Date.now()){
 if(!uuid(input.deviceId)||!Number.isSafeInteger(input.created)||Math.abs(now-input.created)>60000)fail(400,'Device registration expired');
 const keys=deviceKeys(input);
 const value=JSON.stringify(['canopy-device-v1',userId,input.deviceId,input.created,keys.agreement.x,keys.agreement.y,keys.signing.x,keys.signing.y]);
 if(!signature(keys.signing,value,input.proof))fail(403,'Device signature is invalid');return keys;
}
export function hostRegistration(workspace,input,now=Date.now()){
 if(!uuid(input.deviceId))fail(400,'Invalid device');
 if(!Array.isArray(input.workspaceIds)||input.workspaceIds.length!==1||input.workspaceIds[0]!==workspace)fail(403,'A host registers only the workspace it is authenticated for');
 const keys=deviceKeys(input);
 if(input.proof!==undefined){
  if(!Number.isSafeInteger(input.created)||Math.abs(now-input.created)>60000)fail(400,'Device registration expired');
  const value=JSON.stringify(['canopy-host-device-v1',workspace,input.deviceId,input.created,keys.agreement.x,keys.agreement.y,keys.signing.x,keys.signing.y]);
  if(!signature(keys.signing,value,input.proof))fail(403,'Device signature is invalid');
 }
 return keys;
}
export function envelopeHeader(e,key){
 const from=[e.from.team,e.from.user,e.from.device];
 if(e.version===1)return JSON.stringify([1,e.id,from,[e.to.team,e.to.user,e.to.device],e.created,e.expires,key.x,key.y,e.iv]);
 return JSON.stringify([2,e.id,from,[e.to.team,e.to.user,e.to.device,e.to.workspace??null],e.kind,e.created,e.expires,key.x,key.y,e.iv]);
}
// Version 1 keeps exactly five minutes. Version 2 binds kind and workspace in
// the signed header; only workspace traffic may live up to seven days.
export function relayEnvelope(input,userId,sender,recipient,now=Date.now()){
 const e=input.envelope;
 if(!e||Buffer.byteLength(JSON.stringify(e))>50000||(e.version!==1&&e.version!==2)||!uuid(e.id)||e.from?.team!==input.teamId||e.to?.team!==input.teamId||e.from?.user!==userId||e.from?.device!==sender.id||e.to?.user!==recipient.user_id||e.to?.device!==recipient.id||!Number.isSafeInteger(e.created)||!Number.isSafeInteger(e.expires)||e.created>now+30000||e.expires<=now)fail(400,'Invalid relay envelope');
 const workspace=e.version===2?e.to.workspace??null:null;
 if(e.version===2){
  if(!ENVELOPE_KINDS.includes(e.kind)||workspace!==null&&!workspaceId(workspace)||e.kind!=='chat'&&workspace===null)fail(400,'Invalid relay envelope');
 }
 const life=e.expires-e.created;
 if(workspace===null?life!==PERSON_LIFETIME_MS:life<=0||life>WORKSPACE_LIFETIME_MS)fail(400,'Invalid relay envelope');
 if(typeof e.iv!=='string'||Buffer.from(e.iv,'base64').length!==12||typeof e.ciphertext!=='string'||e.ciphertext.length>42700)fail(400,'Invalid relay encoding');
 const key=publicKey(e.ephemeral);
 if(!signature(sender.public_keys.signing,JSON.stringify([envelopeHeader(e,key),e.ciphertext]),e.signature))fail(403,'Message signature is invalid');
 // Drop unknown fields: relay storage never accepts an accidental plaintext body.
 const to={team:e.to.team,user:e.to.user,device:e.to.device};
 if(workspace!==null)to.workspace=workspace;
 return {version:e.version,id:e.id,...(e.version===2?{kind:e.kind}:{}),from:{team:e.from.team,user:e.from.user,device:e.from.device},to,created:e.created,expires:e.expires,ephemeral:key,iv:e.iv,ciphertext:e.ciphertext,signature:e.signature};
}
const canAccess=async(db,workspace,userId)=>allowsWorkspaceAccess(await workspaceAccess(db,workspace,userId),{action:'view'});
const deviceView=d=>({id:d.id,user_id:d.user_id,public_keys:d.public_keys,last_seen_at:d.last_seen_at,kind:d.kind??'user',workspaceIds:d.workspace_ids??[]});
const senderView=row=>({id:row.sender_id,userId:row.sender_user,kind:row.sender_kind,workspaceIds:row.sender_workspaces??[],publicKeys:row.sender_keys});
// Recipient caps hold because the caller locked the recipient device row.
async function enqueue(db,teamId,sender,recipient,envelope,senderCap=SENDER_MAX_ENVELOPES){
 if((await db.query('SELECT count(*)::int n FROM peer_relay WHERE sender_device=$1 AND expires_at>now()',[sender.id])).rows[0].n>=senderCap)fail(429,'Message queue is full');
 const size=Buffer.byteLength(JSON.stringify(envelope));
 const queued=(await db.query('SELECT count(*)::int n,coalesce(sum(size_bytes),0)::bigint b FROM peer_relay WHERE recipient_device=$1 AND expires_at>now()',[recipient.id])).rows[0];
 if(queued.n>=RECIPIENT_MAX_ENVELOPES||Number(queued.b)+size>RECIPIENT_MAX_BYTES)fail(429,'Recipient queue is full');
 await db.query('INSERT INTO peer_relay(team_id,sender_device,recipient_device,envelope,expires_at,size_bytes) VALUES($1,$2,$3,$4,to_timestamp($5),$6) ON CONFLICT DO NOTHING',[teamId,sender.id,recipient.id,envelope,envelope.expires/1000,size]);
}
const POLL_COLUMNS='r.id,r.envelope,d.id sender_id,d.user_id sender_user,d.kind sender_kind,d.workspace_ids sender_workspaces,d.public_keys sender_keys';
// A host sender stays deliverable while it serves the envelope's workspace and
// its owner is still on the team; a user sender while they are on the team.
const LIVE_SENDER=`d.revoked_at IS NULL AND EXISTS(SELECT 1 FROM active_team_member m WHERE m.user_id=d.user_id AND m.team_id=r.team_id)
 AND (d.kind='user' OR r.envelope->'to'->>'workspace'=ANY(d.workspace_ids))`;
// The HTTP caller must wrap each action in a transaction. Team locks serialize
// relay acceptance/delivery with membership removal; device locks fence revoke.
export async function peerAction(db,user,input){
 const {action,teamId,deviceId}=input;
 if(action==='register'){
  const keys=registrationProof(user.id,input);
  await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE',[user.id]);
  const existing=(await db.query('SELECT * FROM peer_device WHERE id=$1 FOR UPDATE',[deviceId])).rows[0];
  if(existing){
   // JSONB key order is not stable; compare the canonical coordinates instead.
   if(existing.user_id!==user.id||existing.revoked_at||(existing.kind??'user')!=='user'||['agreement','signing'].some(k=>['x','y'].some(c=>existing.public_keys[k]?.[c]!==keys[k][c])))fail(409,'Device identity cannot be replaced');
   return {registered:true};
  }
  if((await db.query("SELECT count(*)::int n FROM peer_device WHERE user_id=$1 AND revoked_at IS NULL AND kind='user'",[user.id])).rows[0].n>=10)fail(409,'Remove an old device before adding another');
  await db.query("INSERT INTO peer_device(id,user_id,public_keys,kind) VALUES($1,$2,$3,'user')",[deviceId,user.id,keys]);return {registered:true};
 }
 if(!uuid(deviceId))fail(400,'Invalid device');
 if(action==='revoke'){
  await db.query("UPDATE peer_device SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND kind='user'",[deviceId,user.id]);
  await db.query("DELETE FROM peer_relay WHERE (sender_device=$1 OR recipient_device=$1) AND EXISTS(SELECT 1 FROM peer_device WHERE id=$1 AND user_id=$2 AND kind='user')",[deviceId,user.id]);return {revoked:true};
 }
 if(!uuid(teamId))fail(400,'Choose a team');
 await db.query('SELECT id FROM team WHERE id=$1 FOR UPDATE',[teamId]);
 if(!(await db.query('SELECT 1 FROM active_team_member WHERE team_id=$1 AND user_id=$2 AND removed_at IS NULL',[teamId,user.id])).rows.length)fail(404,'Team not found');
 const sender=(await db.query("SELECT * FROM peer_device WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND kind='user' FOR UPDATE",[deviceId,user.id])).rows[0];if(!sender)fail(403,'Device is not registered');
 await db.query('UPDATE peer_device SET last_seen_at=now() WHERE id=$1',[deviceId]);
 await db.query('DELETE FROM peer_relay WHERE expires_at<=now() AND team_id=$1',[teamId]);
 if(action==='directory'){
  const rows=(await db.query('SELECT d.id,d.user_id,d.public_keys,d.last_seen_at,d.kind,d.workspace_ids FROM peer_device d JOIN active_team_member m ON m.user_id=d.user_id WHERE m.team_id=$1 AND m.removed_at IS NULL AND d.revoked_at IS NULL ORDER BY d.created_at',[teamId])).rows;
  const hosts=[];
  for(const host of rows.filter(d=>d.kind==='host')){
   const visible=[];for(const ws of host.workspace_ids)if(await canAccess(db,ws,user.id))visible.push(ws);
   if(visible.length)hosts.push(deviceView({...host,workspace_ids:visible}));
  }
  return {members:(await db.query('SELECT u.id,u.name FROM active_team_member m JOIN "user" u ON u.id=m.user_id WHERE m.team_id=$1 AND m.removed_at IS NULL',[teamId])).rows,devices:rows.filter(d=>d.kind!=='host').map(deviceView),hosts};
 }
 if(action==='relay'){
  if(!uuid(input.recipientDevice))fail(400,'Invalid recipient');
  const recipient=(await db.query('SELECT d.* FROM peer_device d JOIN active_team_member m ON m.user_id=d.user_id WHERE d.id=$1 AND d.revoked_at IS NULL AND m.team_id=$2 AND m.removed_at IS NULL FOR UPDATE OF d',[input.recipientDevice,teamId])).rows[0];if(!recipient)fail(404,'Recipient unavailable');
  const envelope=relayEnvelope(input,user.id,sender,recipient);
  const workspace=envelope.to.workspace;
  if(recipient.kind==='host'){
   if(!workspace||!recipient.workspace_ids.includes(workspace))fail(400,'That host does not serve this workspace');
   if(!await canAccess(db,workspace,user.id))fail(403,'You do not have access to this workspace');
  }else if(workspace)fail(400,'Workspace traffic goes to the workspace host');
  await enqueue(db,teamId,sender,recipient,envelope);return {queued:true};
 }
 if(action==='poll')return {envelopes:(await db.query(`SELECT ${POLL_COLUMNS} FROM peer_relay r JOIN peer_device d ON d.id=r.sender_device WHERE r.team_id=$1 AND r.recipient_device=$2 AND r.expires_at>now() AND ${LIVE_SENDER} ORDER BY r.created_at LIMIT 100`,[teamId,deviceId])).rows.map(row=>({id:row.id,envelope:row.envelope,sender:senderView(row)}))};
 if(action==='ack'){
  if(!Array.isArray(input.ids)||input.ids.length>100||!input.ids.every(uuid))fail(400,'Invalid delivery acknowledgement');
  await db.query('DELETE FROM peer_relay WHERE team_id=$1 AND recipient_device=$2 AND id=ANY($3::uuid[])',[teamId,deviceId,input.ids]);return {acknowledged:true};
 }
 fail(400,'Unknown peer action');
}
// Host device actions, authenticated by a host credential whose claims were
// verified by the caller (see service-host-auth.mjs) for a current workspace
// row `w`. Registration uses kind 'peer-host-registration'; the rest 'peer-relay'.
export async function hostPeerAction(db,claims,w,input){
 const {action,deviceId}=input;const ws=claims.workspaceId;
 if(action==='register-host'){
  if(claims.kind!=='peer-host-registration')fail(401,'Invalid host credential');
  const keys=hostRegistration(ws,input);
  const existing=(await db.query('SELECT * FROM peer_device WHERE id=$1 FOR UPDATE',[deviceId])).rows[0];
  if(existing){
   if(existing.kind!=='host'||existing.user_id!==w.owner_id||existing.revoked_at||['agreement','signing'].some(k=>['x','y'].some(c=>existing.public_keys[k]?.[c]!==keys[k][c])))fail(409,'Device identity cannot be replaced');
   await db.query('UPDATE peer_device SET workspace_ids=CASE WHEN $2=ANY(workspace_ids) THEN workspace_ids ELSE array_append(workspace_ids,$2) END,last_seen_at=now() WHERE id=$1',[deviceId,ws]);
  }else await db.query("INSERT INTO peer_device(id,user_id,public_keys,kind,workspace_ids) VALUES($1,$2,$3,'host',ARRAY[$4]::text[])",[deviceId,w.owner_id,keys,ws]);
  // One host serves a workspace. A replaced host loses it; once it serves
  // nothing it is revoked and its queued ciphertext is dropped.
  const replaced=(await db.query("UPDATE peer_device SET workspace_ids=array_remove(workspace_ids,$2) WHERE kind='host' AND id<>$1 AND $2=ANY(workspace_ids) RETURNING id,workspace_ids",[deviceId,ws])).rows;
  const retired=replaced.filter(d=>!d.workspace_ids.length).map(d=>d.id);
  if(retired.length){
   await db.query('UPDATE peer_device SET revoked_at=now() WHERE id=ANY($1::uuid[])',[retired]);
   await db.query('DELETE FROM peer_relay WHERE sender_device=ANY($1::uuid[]) OR recipient_device=ANY($1::uuid[])',[retired]);
  }
  return {registered:true};
 }
 if(claims.kind!=='peer-relay')fail(401,'Invalid host credential');
 if(!uuid(deviceId))fail(400,'Invalid device');
 const device=(await db.query("SELECT * FROM peer_device WHERE id=$1 AND kind='host' AND revoked_at IS NULL FOR UPDATE",[deviceId])).rows[0];
 if(!device||!device.workspace_ids.includes(ws)||device.user_id!==w.owner_id)fail(403,'Device does not serve this workspace');
 await db.query('UPDATE peer_device SET last_seen_at=now() WHERE id=$1',[deviceId]);
 if(action==='poll'){
  await db.query("DELETE FROM peer_relay WHERE recipient_device=$1 AND expires_at<=now()",[deviceId]);
  return {envelopes:(await db.query(`SELECT ${POLL_COLUMNS} FROM peer_relay r JOIN peer_device d ON d.id=r.sender_device WHERE r.recipient_device=$1 AND r.envelope->'to'->>'workspace'=$2 AND r.expires_at>now() AND ${LIVE_SENDER} ORDER BY r.created_at LIMIT 100`,[deviceId,ws])).rows.map(row=>({id:row.id,envelope:row.envelope,sender:senderView(row)}))};
 }
 if(action==='ack'){
  if(!Array.isArray(input.ids)||input.ids.length>100||!input.ids.every(uuid))fail(400,'Invalid delivery acknowledgement');
  await db.query("DELETE FROM peer_relay WHERE recipient_device=$1 AND envelope->'to'->>'workspace'=$2 AND id=ANY($3::uuid[])",[deviceId,ws,input.ids]);return {acknowledged:true};
 }
 const {teamId}=input;
 if(!uuid(teamId))fail(400,'Choose a team');
 await db.query('SELECT id FROM team WHERE id=$1 FOR UPDATE',[teamId]);
 if(!(await db.query('SELECT 1 FROM active_team_member WHERE team_id=$1 AND user_id=$2 AND removed_at IS NULL',[teamId,w.owner_id])).rows.length)fail(404,'Team not found');
 if(action==='directory')return {
  members:(await db.query('SELECT u.id,u.name FROM active_team_member m JOIN "user" u ON u.id=m.user_id WHERE m.team_id=$1 AND m.removed_at IS NULL',[teamId])).rows,
  devices:(await db.query('SELECT d.id,d.user_id,d.public_keys,d.last_seen_at,d.kind,d.workspace_ids FROM peer_device d JOIN active_team_member m ON m.user_id=d.user_id WHERE m.team_id=$1 AND m.removed_at IS NULL AND d.revoked_at IS NULL ORDER BY d.created_at',[teamId])).rows.map(deviceView),
 };
 if(action==='relay'){
  if(!uuid(input.recipientDevice))fail(400,'Invalid recipient');
  const recipient=(await db.query("SELECT d.* FROM peer_device d JOIN active_team_member m ON m.user_id=d.user_id WHERE d.id=$1 AND d.revoked_at IS NULL AND d.kind='user' AND m.team_id=$2 AND m.removed_at IS NULL FOR UPDATE OF d",[input.recipientDevice,teamId])).rows[0];if(!recipient)fail(404,'Recipient unavailable');
  const envelope=relayEnvelope(input,w.owner_id,device,recipient);
  if(envelope.version!==2||envelope.to.workspace!==ws)fail(400,'A host sends only its own workspace traffic');
  if(!await canAccess(db,ws,recipient.user_id))fail(403,'Recipient has no access to this workspace');
  await enqueue(db,teamId,device,recipient,envelope,RECIPIENT_MAX_ENVELOPES);return {queued:true};
 }
 fail(400,'Unknown peer action');
}

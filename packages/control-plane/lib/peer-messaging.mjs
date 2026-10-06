import {createPublicKey,verify} from 'node:crypto';
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function publicKey(jwk){
 if(!jwk||jwk.kty!=='EC'||jwk.crv!=='P-256'||typeof jwk.x!=='string'||typeof jwk.y!=='string'||jwk.x.length!==43||jwk.y.length!==43||jwk.d)fail(400,'Invalid device key');
 const value={kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y};try{createPublicKey({key:value,format:'jwk'});}catch{fail(400,'Invalid device key');}return value;
}
function signature(key,data,encoded){
 if(typeof encoded!=='string'||encoded.length>100)return false;
 const sig=Buffer.from(encoded,'base64');if(sig.length!==64||sig.toString('base64')!==encoded)return false;
 return verify('sha256',Buffer.from(data),{key:createPublicKey({key,format:'jwk'}),dsaEncoding:'ieee-p1363'},sig);
}
export function registrationProof(userId,input,now=Date.now()){
 if(!uuid(input.deviceId)||!Number.isSafeInteger(input.created)||Math.abs(now-input.created)>60000)fail(400,'Device registration expired');
 const keys={agreement:publicKey(input.keys?.agreement),signing:publicKey(input.keys?.signing)};
 const value=JSON.stringify(['canopy-device-v1',userId,input.deviceId,input.created,keys.agreement.x,keys.agreement.y,keys.signing.x,keys.signing.y]);
 if(!signature(keys.signing,value,input.proof))fail(403,'Device signature is invalid');return keys;
}
export function relayEnvelope(input,userId,sender,recipient,now=Date.now()){
 const e=input.envelope;if(!e||Buffer.byteLength(JSON.stringify(e))>50000||e.version!==1||!uuid(e.id)||e.from?.team!==input.teamId||e.to?.team!==input.teamId||e.from?.user!==userId||e.from?.device!==sender.id||e.to?.user!==recipient.user_id||e.to?.device!==recipient.id||!Number.isSafeInteger(e.created)||!Number.isSafeInteger(e.expires)||e.created>now+30000||e.expires<=now||e.expires-e.created!==300000)fail(400,'Invalid relay envelope');
 if(typeof e.iv!=='string'||Buffer.from(e.iv,'base64').length!==12||typeof e.ciphertext!=='string'||e.ciphertext.length>42700)fail(400,'Invalid relay encoding');
 const key=publicKey(e.ephemeral),header=JSON.stringify([1,e.id,[e.from.team,e.from.user,e.from.device],[e.to.team,e.to.user,e.to.device],e.created,e.expires,key.x,key.y,e.iv]);
 if(!signature(sender.public_keys.signing,JSON.stringify([header,e.ciphertext]),e.signature))fail(403,'Message signature is invalid');
 // Drop unknown fields: relay storage never accepts an accidental plaintext body.
 return {version:1,id:e.id,from:{team:e.from.team,user:e.from.user,device:e.from.device},to:{team:e.to.team,user:e.to.user,device:e.to.device},created:e.created,expires:e.expires,ephemeral:key,iv:e.iv,ciphertext:e.ciphertext,signature:e.signature};
}
// The HTTP caller must wrap each action in a transaction. Team locks serialize
// relay acceptance/delivery with membership removal; device locks fence revoke.
export async function peerAction(db,user,input){
 const {action,teamId,deviceId}=input;
 if(action==='register'){
  const keys=registrationProof(user.id,input);
  await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE',[user.id]);
  const existing=(await db.query('SELECT * FROM peer_device WHERE id=$1 FOR UPDATE',[deviceId])).rows[0];
  if(existing){if(existing.user_id!==user.id||existing.revoked_at||JSON.stringify(existing.public_keys)!==JSON.stringify(keys)){
    // JSONB key order is not stable; compare the canonical coordinates instead.
    if(existing.user_id!==user.id||existing.revoked_at||['agreement','signing'].some(k=>['x','y'].some(c=>existing.public_keys[k]?.[c]!==keys[k][c])))fail(409,'Device identity cannot be replaced');
   }return {registered:true};}
  if((await db.query('SELECT count(*)::int n FROM peer_device WHERE user_id=$1 AND revoked_at IS NULL',[user.id])).rows[0].n>=10)fail(409,'Remove an old device before adding another');
  await db.query('INSERT INTO peer_device(id,user_id,public_keys) VALUES($1,$2,$3)',[deviceId,user.id,keys]);return {registered:true};
 }
 if(!uuid(deviceId))fail(400,'Invalid device');
 if(action==='revoke'){
  await db.query('UPDATE peer_device SET revoked_at=now() WHERE id=$1 AND user_id=$2',[deviceId,user.id]);
  await db.query('DELETE FROM peer_relay WHERE (sender_device=$1 OR recipient_device=$1) AND EXISTS(SELECT 1 FROM peer_device WHERE id=$1 AND user_id=$2)',[deviceId,user.id]);return {revoked:true};
 }
 if(!uuid(teamId))fail(400,'Choose a team');
 await db.query('SELECT id FROM team WHERE id=$1 FOR UPDATE',[teamId]);
 if(!(await db.query('SELECT 1 FROM active_team_member WHERE team_id=$1 AND user_id=$2 AND removed_at IS NULL',[teamId,user.id])).rows.length)fail(404,'Team not found');
 const sender=(await db.query('SELECT * FROM peer_device WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE',[deviceId,user.id])).rows[0];if(!sender)fail(403,'Device is not registered');
 await db.query('UPDATE peer_device SET last_seen_at=now() WHERE id=$1',[deviceId]);
 await db.query('DELETE FROM peer_relay WHERE expires_at<=now() AND team_id=$1',[teamId]);
 if(action==='directory')return {members:(await db.query('SELECT u.id,u.name FROM active_team_member m JOIN "user" u ON u.id=m.user_id WHERE m.team_id=$1 AND m.removed_at IS NULL',[teamId])).rows,devices:(await db.query('SELECT d.id,d.user_id,d.public_keys,d.last_seen_at FROM peer_device d JOIN active_team_member m ON m.user_id=d.user_id WHERE m.team_id=$1 AND m.removed_at IS NULL AND d.revoked_at IS NULL ORDER BY d.created_at',[teamId])).rows};
 if(action==='relay'){
  if(!uuid(input.recipientDevice))fail(400,'Invalid recipient');
  const recipient=(await db.query('SELECT d.* FROM peer_device d JOIN active_team_member m ON m.user_id=d.user_id WHERE d.id=$1 AND d.revoked_at IS NULL AND m.team_id=$2 AND m.removed_at IS NULL FOR UPDATE OF d',[input.recipientDevice,teamId])).rows[0];if(!recipient)fail(404,'Recipient unavailable');
  const envelope=relayEnvelope(input,user.id,sender,recipient);
  if((await db.query('SELECT count(*)::int n FROM peer_relay WHERE sender_device=$1 AND expires_at>now()',[deviceId])).rows[0].n>=200)fail(429,'Message queue is full');
  await db.query('INSERT INTO peer_relay(team_id,sender_device,recipient_device,envelope,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5)) ON CONFLICT DO NOTHING',[teamId,deviceId,recipient.id,envelope,envelope.expires/1000]);return {queued:true};
 }
 if(action==='poll')return {envelopes:(await db.query('SELECT r.id,r.envelope FROM peer_relay r JOIN peer_device d ON d.id=r.sender_device JOIN active_team_member m ON m.user_id=d.user_id AND m.team_id=r.team_id WHERE r.team_id=$1 AND r.recipient_device=$2 AND r.expires_at>now() AND d.revoked_at IS NULL AND m.removed_at IS NULL ORDER BY r.created_at LIMIT 100',[teamId,deviceId])).rows};
 if(action==='ack'){
  if(!Array.isArray(input.ids)||input.ids.length>100||!input.ids.every(uuid))fail(400,'Invalid delivery acknowledgement');
  await db.query('DELETE FROM peer_relay WHERE team_id=$1 AND recipient_device=$2 AND id=ANY($3::uuid[])',[teamId,deviceId,input.ids]);return {acknowledged:true};
 }
 fail(400,'Unknown peer action');
}

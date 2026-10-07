import {createHash, timingSafeEqual, randomUUID} from 'node:crypto';
import {newDeviceToken, tokenHash} from './policy.mjs';
export const pkceChallenge = verifier => createHash('sha256').update(verifier).digest('base64url');
export function validChallenge(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
export function matchesVerifier(challenge, verifier) {
 if (!validChallenge(challenge) || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
 return timingSafeEqual(Buffer.from(challenge), Buffer.from(pkceChallenge(verifier)));
}
export async function startPairing(client, {challenge, deviceName}) {
 if (!validChallenge(challenge) || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80) throw Error('Invalid device request');
 const id = randomUUID();
 await client.query('INSERT INTO device_pairing(id,challenge,device_name) VALUES($1,$2,$3)',[id,challenge,deviceName.trim()]);
 return {id, expiresIn:600, interval:3};
}
// Caller holds a transaction. Row locks serialize approval and token consumption.
export async function approvePairing(client, {id, userId}) {
 const result = await client.query('UPDATE device_pairing SET user_id=$2 WHERE id=$1 AND user_id IS NULL AND consumed_at IS NULL AND expires_at>now() RETURNING id',[id,userId]);
 return result.rowCount === 1;
}
export async function consumePairing(client, {id, verifier}) {
 const result = await client.query('SELECT *,expires_at>now() valid FROM device_pairing WHERE id=$1 FOR UPDATE',[id]);
 const row = result.rows[0];
 if (!row || !row.valid || row.consumed_at || !matchesVerifier(row.challenge, verifier)) return {status:'expired'};
 if (!row.user_id) return {status:'pending'};
 const token = newDeviceToken();
 await client.query('INSERT INTO device_token(token_hash,user_id,device_id,device_name,expires_at) VALUES($1,$2,$3,$4,now()+interval \'90 days\')',[tokenHash(token),row.user_id,id,row.device_name]);
 await client.query('UPDATE device_pairing SET consumed_at=now() WHERE id=$1',[id]);
 return {status:'approved',token};
}

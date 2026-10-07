// Throwaway replica database: apply canopy-website's database/ORDER in order
// (every file is idempotent), then seed one verified user with a desktop
// device token, as the desktop app's pairing would leave it. No production
// data is ever read.
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
const pool=new pg.Pool({connectionString:process.env.CANOPY_DATABASE_URL});
for(let attempt=0;;attempt++){try{await pool.query('SELECT 1');break;}catch(error){if(attempt>60)throw error;await new Promise(r=>setTimeout(r,1000));}}
const order=readFileSync('/website/database/ORDER','utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
for(const file of order){await pool.query(readFileSync(`/website/database/${file}`,'utf8'));console.log('[db] applied',file);}
// database/ORDER does not cover every additive migration the code relies on
// (e.g. migrations/shared-runtime.sql adds workspace.sharing_generation, read
// by every worker pass). They are idempotent; apply them all afterwards.
if(existsSync('/website/migrations'))for(const file of readdirSync('/website/migrations').filter(f=>f.endsWith('.sql')).sort()){await pool.query(readFileSync(`/website/migrations/${file}`,'utf8'));console.log('[db] applied migrations/'+file);}
const token=process.env.REPLICA_DEVICE_TOKEN;
if(!/^[A-Za-z0-9_-]{64}$/.test(token??''))throw Error('REPLICA_DEVICE_TOKEN must be 64 URL-safe characters');
const userId=randomUUID();
await pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT(email) DO NOTHING',[userId,'Replica owner','owner@replica.invalid']);
const user=(await pool.query('SELECT id FROM "user" WHERE email=$1',['owner@replica.invalid'])).rows[0];
await pool.query("INSERT INTO device_token(token_hash,user_id,device_id,device_name,expires_at) VALUES($1,$2,'replica-desktop','Replica desktop',now()+interval '30 days') ON CONFLICT(user_id,device_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at",[createHash('sha256').update(token).digest('hex'),user.id]);
console.log('[db] seeded user',user.id);
await pool.end();

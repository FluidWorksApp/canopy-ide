#!/usr/bin/env node
// Grant (or correct) a user's Canopy credit balance from an operator shell.
//
//   CANOPY_DATABASE_URL=… node scripts/grant-credit.mjs --email sam@example.com --amount 25 --reason "Preview top-up"
//
// --amount      US dollars, up to six decimals; negative for a correction
// --email|--user  who receives it (email, or user id)
// --reason      recorded on the ledger row the user sees
// --actor       who granted it (default: cli:<os user>)
// --request-key makes a retried command a no-op (default: random)
// --dry-run     show the result, then roll back
//
// Writes one credit_ledger row and moves credit_account.balance_usd under the
// account lock, clears reminders the new balance recovers past and closes open
// credit requests. Paused workspaces are not started; the user resumes them.
// In the control-plane deployment this lives at scripts/grant-credit.mjs and
// imports ../lib/canopy/credit-enforcement.mjs. See docs/credits.md.
import {createRequire} from 'node:module';
import {userInfo} from 'node:os';
import {parseArgs} from 'node:util';
import {grantCredit} from '../lib/credit-enforcement.mjs';
import {formatUsd} from '../lib/credit-policy.mjs';

const {values}=parseArgs({options:{email:{type:'string'},user:{type:'string'},amount:{type:'string'},reason:{type:'string'},actor:{type:'string'},'request-key':{type:'string'},'dry-run':{type:'boolean'}}});
const fail=message=>{console.error(message);process.exit(1);};
if(!process.env.CANOPY_DATABASE_URL)fail('Set CANOPY_DATABASE_URL to the control plane database.');
if(!values.email===!values.user)fail('Pass exactly one of --email or --user.');
if(!values.amount||!values.reason)fail('Pass --amount and --reason.');
const {Pool}=createRequire(`${process.cwd()}/package.json`)('pg');
const pool=new Pool({connectionString:process.env.CANOPY_DATABASE_URL,max:1});
const client=await pool.connect();
try{
 await client.query('BEGIN');
 const user=(await client.query('SELECT id,email FROM "user" WHERE '+(values.email?'lower(email)=lower($1)':'id=$1'),[values.email??values.user])).rows[0];
 if(!user)throw Object.assign(Error('No user with that email or id.'),{code:404});
 const before=(await client.query('SELECT balance_usd::text b FROM credit_account WHERE user_id=$1',[user.id])).rows[0]?.b??'0';
 const result=await grantCredit(client,{userId:user.id,amountUsd:values.amount,reason:values.reason,actor:values.actor??process.env.CANOPY_OPERATOR??`cli:${userInfo().username}`,...(values['request-key']?{requestKey:values['request-key']}:{})});
 await client.query(values['dry-run']?'ROLLBACK':'COMMIT');
 console.log(`${values['dry-run']?'[dry run, rolled back] ':''}${result.applied?'Granted':'Already applied:'} ${formatUsd(values.amount)} to ${user.email}. Balance ${formatUsd(before)} -> ${formatUsd(result.balanceUsd)} (${result.status}${result.computeAllowed?'':', workspaces still paused'}). Ledger key ${result.eventKey}.`);
}catch(error){await client.query('ROLLBACK').catch(()=>{});fail(error.message);}
finally{client.release();await pool.end();}

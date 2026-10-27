// Credit enforcement: reminder notices, pausing compute at the cutoff, admin
// grants, credit requests and the account summary. Thresholds live in
// credit-policy.mjs; operations and wiring are in docs/credits.md.
//
// Lock order everywhere is workspace -> credit_account, the same order usage
// metering takes, so enforcement can run beside debits without deadlocking.
// Paths that touch only the account (notices, grants) lock only the account.
import {randomUUID} from 'node:crypto';
import {requestOperation} from './lifecycle.mjs';
import {CREDIT_POLICY,CUTOFF_USD,LOW_USD,NOTICE_LEVELS,amountToRestoreUsd,computeAllowed,creditStatus,enforcementMode,noticeLevels} from './credit-policy.mjs';
import {creditNoticeEmail,creditRequestEmail} from './credit-email.mjs';

const severity=level=>NOTICE_LEVELS.indexOf(level);
// Only a managed (metered) workspace is paused; a legacy connection has no
// compute the control plane owns. to_jsonb keeps this valid on databases
// created before the provider column.
const MANAGED="COALESCE(to_jsonb(w)->>'provider','lightsail')='lightsail'";

/** Open a notice for every level the balance has crossed and close the ones it
 * has recovered past (re-arming them). Returns the levels newly crossed.
 * Concurrent callers are fenced by the partial unique index; at most one open
 * notice exists per user and level. Only the most severe pending notice is
 * emailed, so a jump from +$20 to -$12 sends one email, not four. */
export async function syncCreditNotices(client,userId,balanceUsd,{env=process.env}={}){
 const mode=enforcementMode(env);if(mode==='off')return [];
 // In notify mode nothing is paused, so the "paused" email would be untrue.
 const active=noticeLevels(balanceUsd).filter(level=>mode==='enforce'||level!=='paused');
 const recovered=NOTICE_LEVELS.filter(level=>!active.includes(level));
 await client.query("UPDATE credit_notice SET cleared_at=now(),delivery=CASE WHEN delivery='pending' THEN 'skipped' ELSE delivery END WHERE user_id=$1 AND cleared_at IS NULL AND level=ANY($2::text[])",[userId,recovered]);
 if(!active.length)return [];
 const crossed=(await client.query('INSERT INTO credit_notice(user_id,level,balance_usd) SELECT $1,level,$3::numeric FROM unnest($2::text[]) AS level ON CONFLICT(user_id,level) WHERE cleared_at IS NULL DO NOTHING RETURNING level',[userId,active,String(balanceUsd)])).rows.map(row=>row.level);
 if(crossed.length){
  const pending=(await client.query("SELECT id,level FROM credit_notice WHERE user_id=$1 AND cleared_at IS NULL AND delivery='pending'",[userId])).rows;
  const keep=pending.reduce((best,row)=>!best||severity(row.level)>severity(best.level)?row:best,null);
  const skip=pending.filter(row=>row!==keep).map(row=>row.id);
  if(skip.length)await client.query("UPDATE credit_notice SET delivery='skipped' WHERE id=ANY($1::uuid[])",[skip]);
 }
 return crossed.sort((a,b)=>severity(a)-severity(b));
}

/** Hibernate one workspace for an exhausted balance. The caller holds the
 * transaction (and normally the workspace and account locks). Uses a savepoint
 * so a refused lifecycle request never aborts the caller's debit. Returns
 * 'requested' | 'already-stopping' | 'deferred'. */
export async function pauseWorkspaceForCredit(client,ownerId,workspaceId,{balanceUsd}={}){
 const w=(await client.query('SELECT id,owner_id,desired_state,deleted_at FROM workspace WHERE id=$1 FOR UPDATE',[workspaceId])).rows[0];
 if(!w||w.owner_id!==ownerId||w.deleted_at||w.desired_state!=='running')return 'already-stopping';
 const active=(await client.query("SELECT action FROM workspace_operation WHERE workspace_id=$1 AND status IN('pending','running')",[workspaceId])).rows[0];
 if(active&&['hibernate','delete'].includes(active.action))return 'already-stopping';
 await client.query('SAVEPOINT credit_pause');
 try{
  const operation=await requestOperation(client,ownerId,workspaceId,{action:'hibernate',confirmInterrupt:true,requestKey:randomUUID()});
  if(operation?.id)await client.query('UPDATE workspace_operation SET context=context||$2::jsonb WHERE id=$1',[operation.id,JSON.stringify({creditPause:{balanceUsd:balanceUsd==null?null:String(balanceUsd),cutoffUsd:String(CUTOFF_USD)}})]);
  await client.query('RELEASE SAVEPOINT credit_pause');return 'requested';
 }catch(error){
  await client.query('ROLLBACK TO SAVEPOINT credit_pause');
  // A provider step in progress (409) is retried by the next sweep.
  if(error?.code===409)return 'deferred';
  throw error;
 }
}

/** Call from the debit path right after the balance update, in the same
 * transaction, while the workspace and credit_account rows are locked (as
 * meterWorkspace holds them). Records crossed notices and, at or below the
 * cutoff, hibernates the debited workspace. The owner's other workspaces are
 * paused by their own next debit or by the sweep. */
export async function enforceAfterDebit(client,{userId,workspaceId},{env=process.env}={}){
 const mode=enforcementMode(env);if(mode==='off')return {status:'ok',notices:[],paused:null};
 const row=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1',[userId])).rows[0];
 const balance=row?.balance??'0';
 const notices=await syncCreditNotices(client,userId,balance,{env});
 const paused=mode==='enforce'&&workspaceId&&!computeAllowed(balance)?await pauseWorkspaceForCredit(client,userId,workspaceId,{balanceUsd:balance}):null;
 return {balanceUsd:balance,status:creditStatus(balance),notices,paused};
}

async function inTransaction(pool,work){
 const client=await pool.connect();
 try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
 catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
}

/** Periodic sweep, called by the existing reconcile cron after metering. It
 * catches anything the debit path missed: notices for balances changed by
 * other paths, workspaces started before the cutoff was crossed, and email
 * deliveries that failed earlier. Idempotent; safe to run concurrently. */
export async function enforceCreditPolicy(pool,{env=process.env,send=null,accountUrl,supportEmail=env.CANOPY_SUPPORT_EMAIL,limit=100,log=console}={}){
 const mode=enforcementMode(env);const result={mode,noticed:0,paused:0,deferred:0,emailed:0};
 if(mode==='off')return result;
 const accounts=(await pool.query('SELECT user_id FROM credit_account WHERE balance_usd<$1 UNION SELECT user_id FROM credit_notice WHERE cleared_at IS NULL LIMIT $2',[LOW_USD,limit])).rows;
 for(const {user_id:userId} of accounts){
  try{
   result.noticed+=await inTransaction(pool,async client=>{
    const row=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1 FOR UPDATE SKIP LOCKED',[userId])).rows[0];
    return row?(await syncCreditNotices(client,userId,row.balance,{env})).length:0;
   });
  }catch(error){log?.warn?.('Credit notice sweep failed for one account',error?.message);}
 }
 if(mode==='enforce'){
  const running=(await pool.query(`SELECT w.id,w.owner_id FROM workspace w JOIN credit_account a ON a.user_id=w.owner_id WHERE a.balance_usd<=$1 AND w.deleted_at IS NULL AND w.desired_state='running' AND ${MANAGED} LIMIT $2`,[CUTOFF_USD,limit])).rows;
  for(const w of running){
   try{
    const outcome=await inTransaction(pool,async client=>{
     // Same order as metering: workspace first, then the account.
     if(!(await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE SKIP LOCKED',[w.id])).rows.length)return 'deferred';
     const row=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1 FOR UPDATE',[w.owner_id])).rows[0];
     if(!row||computeAllowed(row.balance))return 'recovered';
     return pauseWorkspaceForCredit(client,w.owner_id,w.id,{balanceUsd:row.balance});
    });
    if(outcome==='requested')result.paused++;else if(outcome==='deferred')result.deferred++;
   }catch(error){log?.warn?.('Credit pause failed for one workspace',error?.message);}
  }
 }
 if(send)result.emailed=await deliverCreditNotices(pool,{send,accountUrl,supportEmail,log});
 return result;
}

/** Send pending reminder emails (outbox). Claims rows with SKIP LOCKED and a
 * ten-minute lease so concurrent crons never send one notice twice; a failed
 * send is retried up to five times. Notices older than three days are not sent
 * (the account page and the next crossing still show the state). */
export async function deliverCreditNotices(pool,{send,accountUrl,supportEmail,limit=20,log=console}){
 if(typeof send!=='function')return 0;
 const claimed=(await pool.query(`UPDATE credit_notice n SET claimed_at=now(),delivery_attempts=n.delivery_attempts+1 FROM "user" u
  WHERE u.id=n.user_id AND n.id IN (SELECT id FROM credit_notice WHERE delivery='pending' AND cleared_at IS NULL AND delivery_attempts<5 AND created_at>now()-interval '3 days' AND (claimed_at IS NULL OR claimed_at<now()-interval '10 minutes') ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
  RETURNING n.id,n.level,n.balance_usd::text balance,n.delivery_attempts attempts,u.email`,[limit])).rows;
 let sent=0;
 for(const notice of claimed){
  try{
   await send({to:notice.email,...creditNoticeEmail({level:notice.level,balanceUsd:notice.balance,...(accountUrl?{accountUrl}:{}),supportEmail})});
   await pool.query("UPDATE credit_notice SET delivery='sent',sent_at=now(),last_error=NULL WHERE id=$1 AND delivery='pending'",[notice.id]);sent++;
  }catch(error){
   const message=String(error?.message??error).slice(0,200);
   await pool.query("UPDATE credit_notice SET last_error=$2,delivery=CASE WHEN delivery_attempts>=5 THEN 'failed' ELSE delivery END,claimed_at=NULL WHERE id=$1",[notice.id,message]);
   log?.warn?.('Credit reminder email failed',message);
  }
 }
 return sent;
}

/** The email adapter. Pass the service's existing sender (the website's
 * lib/canopy/email.mjs sendEmail, SES) and a from address; without a from
 * address no adapter is returned and notices stay queued, never lost. */
export function creditMailer({sendEmail,from}){
 if(typeof sendEmail!=='function'||!from)return null;
 return message=>sendEmail({from,...message});
}
/** Test and local-development adapter: records instead of sending. */
export function recordingMailer(){const sent=[];const send=async message=>{sent.push(message);return {messageId:`recorded-${sent.length}`};};send.sent=sent;return send;}

const DECIMAL=/^-?\d{1,7}(?:\.\d{1,6})?$/;
/** Admin credit grant (or a negative correction). Writes one ledger row and
 * moves the balance under the account lock; replaying the same requestKey is a
 * no-op. Clears notices the new balance recovers past and closes open credit
 * requests. It never starts a workspace: the user resumes when ready. */
export async function grantCredit(client,{userId,amountUsd,reason,actor,requestKey=randomUUID(),maxUsd=10000}){
 const amount=String(amountUsd??'').trim();
 if(!DECIMAL.test(amount)||Number(amount)===0||Math.abs(Number(amount))>maxUsd)throw Object.assign(Error(`Choose a non-zero amount up to $${maxUsd} with at most six decimal places`),{code:400});
 if(typeof reason!=='string'||!reason.trim()||reason.length>200)throw Object.assign(Error('Give a reason of at most 200 characters'),{code:400});
 if(typeof actor!=='string'||!actor.trim()||actor.length>200)throw Object.assign(Error('Record who is granting the credit'),{code:400});
 if(typeof requestKey!=='string'||!/^[\w:.-]{8,120}$/.test(requestKey))throw Object.assign(Error('Invalid request key'),{code:400});
 const user=(await client.query('SELECT id FROM "user" WHERE id=$1',[userId])).rows[0];
 if(!user)throw Object.assign(Error('User not found'),{code:404});
 await client.query('INSERT INTO credit_account(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
 await client.query('SELECT user_id FROM credit_account WHERE user_id=$1 FOR UPDATE',[userId]);
 const eventKey=`admin-grant:${requestKey}`;const kind=Number(amount)>0?'grant':'adjustment';
 const inserted=(await client.query('INSERT INTO credit_ledger(user_id,event_key,kind,amount_usd,description,actor) VALUES($1,$2,$3,$4::numeric,$5,$6) ON CONFLICT(event_key) DO NOTHING RETURNING amount_usd::text amount',[userId,eventKey,kind,amount,`${kind==='grant'?'Credit grant':'Balance correction'}: ${reason.trim()}`,actor.trim()])).rows[0];
 let applied=false;
 if(inserted){await client.query('UPDATE credit_account SET balance_usd=balance_usd+$2::numeric,updated_at=now() WHERE user_id=$1',[userId,amount]);applied=true;}
 else{
  const previous=(await client.query('SELECT user_id,amount_usd::numeric=$3::numeric same FROM credit_ledger WHERE event_key=$1 AND user_id=$2',[eventKey,userId,amount])).rows[0];
  if(!previous?.same)throw Object.assign(Error('Request key already used for a different grant'),{code:409});
 }
 const balance=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1',[userId])).rows[0].balance;
 await syncCreditNotices(client,userId,balance);
 if(applied&&kind==='grant')await client.query('UPDATE credit_request SET resolved_at=now(),resolved_by=$2 WHERE user_id=$1 AND resolved_at IS NULL',[userId,actor.trim()]);
 return {applied,eventKey,balanceUsd:balance,status:creditStatus(balance),computeAllowed:computeAllowed(balance)};
}

/** Record a "Request more credit" from the desktop. One request per user per
 * day reaches support; repeats return the open request. The caller sends the
 * email after commit with deliverCreditRequest. */
export async function requestMoreCredit(client,{userId,note}){
 if(note!=null&&(typeof note!=='string'||note.length>1000))throw Object.assign(Error('Keep the note under 1,000 characters'),{code:400});
 const user=(await client.query('SELECT id,name,email FROM "user" WHERE id=$1 FOR UPDATE',[userId])).rows[0];
 if(!user)throw Object.assign(Error('User not found'),{code:404});
 const recent=(await client.query("SELECT id,created_at FROM credit_request WHERE user_id=$1 AND created_at>now()-interval '1 day' ORDER BY created_at DESC LIMIT 1",[userId])).rows[0];
 if(recent)return {created:false,request:recent,user};
 const balance=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1',[userId])).rows[0]?.balance??'0';
 const request=(await client.query('INSERT INTO credit_request(user_id,balance_usd,note) VALUES($1,$2::numeric,$3) RETURNING id,created_at,balance_usd::text balance',[userId,balance,note?.trim()||null])).rows[0];
 return {created:true,request,user,balanceUsd:balance,note:note?.trim()||null};
}
export async function deliverCreditRequest({send,supportEmail,result}){
 if(!result?.created||typeof send!=='function'||!supportEmail)return false;
 try{await send({to:supportEmail,...creditRequestEmail({name:result.user.name,email:result.user.email,balanceUsd:result.balanceUsd,note:result.note,requestId:result.request.id})});return true;}
 catch{return false;}
}

/** Body additions for GET /api/credits. The desktop keeps working without
 * them (it mirrors the thresholds), so the API and app can deploy in any order. */
export async function creditSummary(db,userId,{env=process.env}={}){
 const balance=(await db.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1',[userId])).rows[0]?.balance??'0';
 const recentDebits=(await db.query("SELECT l.occurred_at,l.amount_usd::text amount_usd,l.quantity::text quantity,l.workspace_id,COALESCE(w.name,l.workspace_id) workspace_name,l.description FROM credit_ledger l LEFT JOIN workspace w ON w.id=l.workspace_id WHERE l.user_id=$1 AND l.kind='usage' ORDER BY l.occurred_at DESC LIMIT 25",[userId])).rows;
 const usageByWorkspace=(await db.query("SELECT l.workspace_id,COALESCE(max(w.name),l.workspace_id) workspace_name,(-sum(l.amount_usd))::text usd,max(l.occurred_at) last_at FROM credit_ledger l LEFT JOIN workspace w ON w.id=l.workspace_id WHERE l.user_id=$1 AND l.kind='usage' AND l.occurred_at>now()-interval '30 days' GROUP BY l.workspace_id ORDER BY sum(l.amount_usd) ASC LIMIT 20",[userId])).rows;
 const lastRequest=(await db.query('SELECT created_at FROM credit_request WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[userId])).rows[0]?.created_at??null;
 const mode=enforcementMode(env);
 return {balanceUsd:balance,status:creditStatus(balance),computeAllowed:mode!=='enforce'||computeAllowed(balance),amountToRestoreUsd:amountToRestoreUsd(balance),policy:CREDIT_POLICY,enforcement:mode,recentDebits,usageByWorkspace,lastCreditRequestAt:lastRequest,creditRequestsEnabled:Boolean(env.CANOPY_SUPPORT_EMAIL)};
}

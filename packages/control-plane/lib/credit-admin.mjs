// Credit administration over HTTP: grant credit and list accounts by balance.
// There is no admin role in the schema (roles exist only inside teams and
// organizations), so admins are the verified emails in CANOPY_ADMIN_EMAILS.
// Every grant goes through grantCredit and records `admin:<email>` as the
// ledger actor. The CLI (scripts/grant-credit.mjs) stays the database path.
import {grantCredit} from './credit-enforcement.mjs';
import {LOW_USD,amountToRestoreUsd,creditStatus} from './credit-policy.mjs';

/** The admin allowlist: comma, space or newline separated, case-insensitive. */
export function creditAdminEmails(env=process.env){return new Set(String(env.CANOPY_ADMIN_EMAILS??'').split(/[\s,;]+/).map(email=>email.trim().toLowerCase()).filter(email=>email.includes('@')));}
/** A signed-in principal (verified email) on the allowlist. */
export function isCreditAdmin(user,env=process.env){return typeof user?.email==='string'&&creditAdminEmails(env).has(user.email.trim().toLowerCase());}

/** Grant from an admin request body: {email | userId, amountUsd, reason, requestKey?}. */
export async function adminGrantCredit(client,{admin,body}){
 const email=typeof body?.email==='string'?body.email.trim():'',userId=typeof body?.userId==='string'?body.userId.trim():'';
 if(!email&&!userId)throw Object.assign(Error('Name the account by email or userId'),{code:400});
 const user=(await client.query(email?'SELECT id,email FROM "user" WHERE lower(email)=lower($1)':'SELECT id,email FROM "user" WHERE id=$1',[email||userId])).rows[0];
 if(!user)throw Object.assign(Error('No account with that email'),{code:404});
 const result=await grantCredit(client,{userId:user.id,amountUsd:body.amountUsd,reason:body.reason,actor:`admin:${admin.email}`,...(body.requestKey==null?{}:{requestKey:body.requestKey})});
 return {...result,userId:user.id,email:user.email};
}

/** Accounts below a balance (default: the low-balance threshold), lowest first,
 * with what each needs to restore access, running workspaces and the open
 * credit request. */
export async function listCreditAccounts(db,{below=LOW_USD,limit=200}={}){
 const threshold=below==null||below===''?LOW_USD:Number(below);
 if(!Number.isFinite(threshold)||Math.abs(threshold)>1e6)throw Object.assign(Error('`below` must be a dollar amount'),{code:400});
 const rows=(await db.query(`SELECT u.id user_id,u.email,u.name,a.balance_usd::text balance_usd,a.updated_at,
  (SELECT count(*)::int FROM workspace w WHERE w.owner_id=a.user_id AND w.deleted_at IS NULL AND w.desired_state='running') running_workspaces,
  (SELECT r.created_at FROM credit_request r WHERE r.user_id=a.user_id AND r.resolved_at IS NULL ORDER BY r.created_at DESC LIMIT 1) open_request_at
  FROM credit_account a JOIN "user" u ON u.id=a.user_id WHERE a.balance_usd<$1 ORDER BY a.balance_usd ASC LIMIT $2`,[threshold,Math.max(1,Math.min(500,limit))])).rows;
 return {belowUsd:threshold,accounts:rows.map(row=>({userId:row.user_id,email:row.email,name:row.name,balanceUsd:row.balance_usd,status:creditStatus(row.balance_usd),amountToRestoreUsd:amountToRestoreUsd(row.balance_usd),runningWorkspaces:row.running_workspaces,openRequestAt:row.open_request_at,updatedAt:row.updated_at}))};
}

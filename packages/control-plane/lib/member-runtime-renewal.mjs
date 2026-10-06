import {createHmac,timingSafeEqual} from 'node:crypto';
import {memberAccessSnapshot,memberToken} from './member-access.mjs';
const reject=(code=403)=>{throw Object.assign(Error('Member renewal unavailable'),{code});};
/** This purpose-bound host proof is not a user/container bearer credential. */
export function verifyMemberRenewalRequest(input,keyForWorkspace,now=Date.now()){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||typeof input.request!=='string'||input.request.length>2048||!/^[A-Za-z0-9_-]+$/.test(input.request)||typeof input.signature!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.signature))reject(401);
 let claims;try{const decoded=Buffer.from(input.request,'base64url');if(decoded.toString('base64url')!==input.request)reject(401);claims=JSON.parse(decoded.toString('utf8'));}catch{reject(401);}
 const keys=['version','purpose','workspaceId','memberId','accessVersion','scope','generation','expires','nonce'],seconds=Math.floor(now/1000);
 if(!claims||Array.isArray(claims)||Object.keys(claims).length!==keys.length||keys.some(key=>!Object.hasOwn(claims,key))||claims.version!==1||claims.purpose!=='member-runtime-renewal'||!/^ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(claims.workspaceId??'')||typeof claims.memberId!=='string'||!claims.memberId||claims.memberId.length>256||/[\x00-\x1f]/.test(claims.memberId)||!Number.isSafeInteger(claims.accessVersion)||claims.accessVersion<1||!['view','drive'].includes(claims.scope)||!Number.isSafeInteger(claims.generation)||claims.generation<0||!Number.isSafeInteger(claims.expires)||claims.expires<=seconds||claims.expires>seconds+30||typeof claims.nonce!=='string'||!/^[a-f0-9]{32}$/.test(claims.nonce))reject(401);
 let expected;try{const key=keyForWorkspace(claims.workspaceId);if(typeof key!=='string'||key.length<32)reject(401);expected=createHmac('sha256',key).update(input.request).digest();}catch{reject(401);}
 const actual=Buffer.from(input.signature,'base64url');if(actual.toString('base64url')!==input.signature||actual.length!==expected.length||!timingSafeEqual(actual,expected))reject(401);
 return claims;
}
/** Caller owns a transaction and commits before returning the credential. The
 * workspace row lock orders renewal against intentional shutdown/recreation;
 * the unique durable nonce fences concurrent requests and process restarts. */
export async function renewMemberRuntime(db,claims,{key,providerFor,expectedEndpoint,now=Date.now}){
 const workspace=(await db.query('SELECT * FROM workspace WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[claims.workspaceId])).rows[0];
 const generation=Number(workspace?.generation);
 if(!workspace||workspace.id!==claims.workspaceId||typeof workspace.owner_id!=='string'||!workspace.owner_id||workspace.owner_id===claims.memberId||workspace.provider!=='lightsail'||workspace.state!=='ready'||workspace.desired_state!=='running'||!Number.isSafeInteger(generation)||generation!==claims.generation||workspace.sharing_generation==null||Number(workspace.sharing_generation)!==generation||typeof workspace.instance_name!=='string'||!workspace.instance_name||workspace.endpoint!==expectedEndpoint(workspace))reject();
 const instance=await providerFor(workspace).instance(workspace.instance_name);
 if(!instance||instance.name!==workspace.instance_name||instance.state?.name!=='running'||!instance.tags?.some(t=>t.key==='canopy-workspace'&&t.value===workspace.id)||!instance.tags?.some(t=>t.key==='managed-by'&&t.value==='canopy'))reject();
 // Current direct/team/org membership epochs and exact effective scope are part
 // of accessVersion. A rejoined member can never revive an old runtime actor.
 const current=await memberAccessSnapshot(db,workspace.id,claims.memberId);
 if(!current||current.accessVersion!==claims.accessVersion||current.scope!==claims.scope||Number(current.generation)!==generation||claims.expires<=Math.floor(now()/1000))reject();
 await db.query('DELETE FROM member_runtime_renewal_nonce WHERE workspace_id=$1 AND expires_at<=to_timestamp($2)',[workspace.id,Math.floor(now()/1000)]);
 const count=(await db.query('SELECT count(*)::int AS n FROM member_runtime_renewal_nonce WHERE workspace_id=$1',[workspace.id])).rows[0]?.n;
 if(!Number.isInteger(count)||count>=4096)reject();
 const admitted=await db.query('INSERT INTO member_runtime_renewal_nonce(workspace_id,nonce,member_id,generation,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5)) ON CONFLICT DO NOTHING RETURNING nonce',[workspace.id,claims.nonce,claims.memberId,generation,claims.expires]);
 if(admitted.rows.length!==1)reject();
 if(claims.expires<=Math.floor(now()/1000))reject();
 // Normal V2 actor credential only: no owner token or expanded grant list.
 return {token:memberToken(claims,key,now()),workspaceId:workspace.id,memberId:claims.memberId,accessVersion:claims.accessVersion,scope:claims.scope};
}

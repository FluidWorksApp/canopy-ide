import {workspaceAccess} from './workspace-access.mjs';
import {sharingPolicy} from './team-policy.mjs';
import {sharedResourceAccess} from './shared-resource-access.mjs';
import {sessionAccess} from './session-access.mjs';
import {projectAccess} from './project-access.mjs';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export function memberToken(claims,key,now=Date.now()){
 const value={version:2,workspaceId:claims.workspaceId,memberId:claims.memberId,accessVersion:claims.accessVersion,scope:claims.scope,expires:Math.floor(now/1000)+120};
 validate(value,now);const payload=Buffer.from(JSON.stringify(value)).toString('base64url');
 return `${payload}.${createHmac('sha256',key).update(payload).digest('base64url')}`;
}
function validate(c,now){if(c?.version!==2||typeof c.workspaceId!=='string'||!/^ws-[a-f0-9-]{36}$/.test(c.workspaceId)||typeof c.memberId!=='string'||!c.memberId||c.memberId.length>256||!Number.isSafeInteger(c.accessVersion)||c.accessVersion<1||!['view','drive'].includes(c.scope)||!Number.isSafeInteger(c.expires)||c.expires<=Math.floor(now/1000)||c.expires>Math.floor(now/1000)+300)throw Error('Invalid member credential');}
export function verifyMemberToken(token,keyForWorkspace,now=Date.now()){
 if(typeof token!=='string'||token.length>1024)throw Error('Invalid member credential');
 const [payload,signature,extra]=token.split('.');if(!payload||!signature||extra)throw Error('Invalid member credential');
 let claims;try{claims=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw Error('Invalid member credential');}validate(claims,now);
 const expected=createHmac('sha256',keyForWorkspace(claims.workspaceId)).update(payload).digest(),actual=Buffer.from(signature,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('Invalid member credential');return claims;
}
// Bind credentials to the complete current grants, membership epochs and machine
// generation. Revoke/rejoin and resize/recreate never revive an old credential.
export function accessVersion(grants,generation){
 const rows=grants.map(g=>[g.source,g.team_id??g.organization_id??null,g.role,g.access_version??0,g.team_joined_at??null,g.organizationJoinedAt??null,sharingPolicy(g.permissions)]);
 rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return Number.parseInt(createHash('sha256').update(JSON.stringify([generation,rows])).digest('hex').slice(0,13),16)||1;
}
export async function memberAccessSnapshot(db,workspaceId,memberId){
 const workspace=(await db.query('SELECT state,desired_state,generation FROM workspace WHERE id=$1 AND deleted_at IS NULL',[workspaceId])).rows[0];
 if(!workspace||workspace.state!=='ready'||workspace.desired_state!=='running')return null;
 const grants=await workspaceAccess(db,workspaceId,memberId);
 if(!grants.length||grants.some(g=>g.role==='owner'))return null;
 // Execution takes place in the member's private runtime. Its project mounts
 // are independently constrained by this policy and the trusted host catalog.
 // A narrow writer plus a broad viewer can execute, but only its selected
 // writable projects are mounted read/write.
 const access=projectAccess(grants);
 const scope=access.allWrite||access.selected.some(p=>p.writable)?'drive':access.allRead||access.selected.length?'view':null;
 if(!scope)return null;
 return {scope,accessVersion:accessVersion(grants,workspace.generation),projectAccess:access,sharedAccess:sharedResourceAccess(grants),sessionAccess:sessionAccess(grants),generation:workspace.generation};
}
export async function liveMemberAccess(db,claims){
 const current=await memberAccessSnapshot(db,claims.workspaceId,claims.memberId);
 return !!current&&current.accessVersion===claims.accessVersion&&current.scope===claims.scope;
}

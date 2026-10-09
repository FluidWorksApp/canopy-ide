import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
import {sharingPolicy} from './team-policy.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status,code:status});};
export const SNAPSHOT_TTL_MS=15*60*1000,SNAPSHOT_REFRESH_MS=5*60*1000,MAX_SNAPSHOT_PRINCIPALS=400,MAX_SNAPSHOT_BYTES=64*1024;

export function accessSigningKey(env=process.env){
 const pem=env.CANOPY_ACCESS_SIGNING_KEY,kid=env.CANOPY_ACCESS_SIGNING_KID;
 if(!pem||!kid||!/^[A-Za-z0-9._-]{1,64}$/.test(kid))throw Error('Access snapshot signing is not configured');
 const key=createPrivateKey(pem.includes('\\n')?pem.replace(/\\n/g,'\n'):pem);
 if(key.asymmetricKeyType!=='ed25519')throw Error('Access snapshot signing key must be Ed25519');
 return {kid,key};
}
/** The daemon's verify-key map: kid → base64 raw 32-byte Ed25519 public key. */
export function accessVerifyKeys({kid,key}){
 return {[kid]:Buffer.from(createPublicKey(key).export({format:'jwk'}).x,'base64url').toString('base64')};
}

// Each grant is evaluated on its own: a session-interact grant on one project
// never combines with a workspace-wide grant that lacks session interaction.
export function principalAuthority(grants){
 const interacting=grants.filter(g=>allowsWorkspaceAccess([g],{action:'connect',resource:'sessions:interact'}));
 if(!interacting.length)return {sessionsInteract:false,projects:[]};
 if(interacting.some(g=>g.role==='owner'||sharingPolicy(g.permissions).projects==='all'))return {sessionsInteract:true,projects:'all'};
 return {sessionsInteract:true,projects:[...new Set(interacting.flatMap(g=>sharingPolicy(g.permissions).projectIds))].sort()};
}

export async function workspacePrincipals(db,workspace){
 const candidates=(await db.query(`SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND revoked_at IS NULL
 UNION SELECT m.user_id FROM workspace_team_access a JOIN team_member m ON m.team_id=a.team_id AND m.removed_at IS NULL WHERE a.workspace_id=$1 AND a.revoked_at IS NULL
 UNION SELECT o.user_id FROM workspace_organization_access a JOIN organization_member o ON o.organization_id=a.organization_id AND o.removed_at IS NULL WHERE a.workspace_id=$1 AND a.revoked_at IS NULL
 ORDER BY 1 LIMIT $2`,[workspace.id,MAX_SNAPSHOT_PRINCIPALS+2])).rows.map(r=>r.user_id).filter(id=>id!==workspace.owner_id);
 if(candidates.length>MAX_SNAPSHOT_PRINCIPALS)fail(413,'Too many people have access to this workspace for a service snapshot');
 const principals=[{userId:workspace.owner_id,sessionsInteract:true,projects:'all'}];
 for(const userId of candidates){
  const grants=await workspaceAccess(db,workspace.id,userId);
  if(!allowsWorkspaceAccess(grants,{action:'view'}))continue;
  principals.push({userId,...principalAuthority(grants)});
 }
 return principals;
}

// Caller holds a REPEATABLE READ transaction so revision and principals agree.
export async function accessSnapshot(db,{workspaceId,signing,now=Date.now()}){
 const w=(await db.query('SELECT id,owner_id,team_delivery,access_revision FROM workspace WHERE id=$1 AND deleted_at IS NULL',[workspaceId])).rows[0];
 if(!w)fail(404,'Workspace not found');
 const device=(await db.query("SELECT id FROM peer_device WHERE kind='host' AND revoked_at IS NULL AND $1=ANY(workspace_ids) ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0];
 if(!device)fail(409,'Register the host device before requesting an access snapshot');
 const snapshot={v:1,kid:signing.kid,workspaceId,serviceDevice:device.id,revision:Number(w.access_revision),issuedAt:now,expiresAt:now+SNAPSHOT_TTL_MS,teamDelivery:w.team_delivery===true,ownerUserId:w.owner_id,principals:await workspacePrincipals(db,w)};
 const bytes=Buffer.from(JSON.stringify(snapshot),'utf8');
 const body={payload:bytes.toString('base64'),signature:sign(null,bytes,signing.key).toString('base64')};
 if(Buffer.byteLength(JSON.stringify(body))>MAX_SNAPSHOT_BYTES)fail(413,'Access snapshot is too large');
 return body;
}

// Transaction required. Only the owner decides whether granted teammates'
// agents may reach this workspace's agents without approval.
export async function setTeamDelivery(db,actorId,{workspaceId,enabled}){
 if(typeof enabled!=='boolean')fail(400,'Choose on or off');
 const w=(await db.query('SELECT id,owner_id FROM workspace WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[workspaceId])).rows[0];
 if(!w)fail(404,'Workspace not found');
 if(w.owner_id!==actorId)fail(403,'Only the workspace owner can change teammate delivery');
 await db.query('UPDATE workspace SET team_delivery=$2 WHERE id=$1',[workspaceId,enabled]);
 await db.query('INSERT INTO workspace_access_audit(workspace_id,actor_id,action,subject_id) VALUES($1,$2,$3,NULL)',[workspaceId,actorId,`team-delivery-${enabled?'on':'off'}`]);
 return {teamDelivery:enabled};
}
export async function teamDelivery(db,actorId,workspaceId){
 const w=(await db.query('SELECT owner_id,team_delivery FROM workspace WHERE id=$1 AND deleted_at IS NULL',[workspaceId])).rows[0];
 if(!w)fail(404,'Workspace not found');
 if(w.owner_id!==actorId)fail(403,'Only the workspace owner can change teammate delivery');
 return {teamDelivery:w.team_delivery===true};
}

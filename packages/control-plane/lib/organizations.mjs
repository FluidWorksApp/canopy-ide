const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const nameOf=value=>{const name=typeof value==='string'?value.trim():'';if(!name||name.length>80)fail(400,'Enter a name between 1 and 80 characters');return name;};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function listOrganizations(db,user){
 // Callers hold a transaction. Serialize first use across IDE/browser windows.
 const account=await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE',[user.id]);
 if(!account.rows.length)fail(401,'Sign in to continue');
 let organizations=(await db.query(`SELECT o.id,o.name,m.role FROM organization o JOIN organization_member m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.removed_at IS NULL ORDER BY o.created_at`,[user.id])).rows;
 if(!organizations.length){
  const organization=(await db.query('INSERT INTO organization(name,created_by) VALUES($1,$2) RETURNING id,name',['Default organization',user.id])).rows[0];
  await db.query("INSERT INTO organization_member(organization_id,user_id,role) VALUES($1,$2,'owner')",[organization.id,user.id]);
  organizations=[{...organization,role:'owner'}];
 }
 return {organizations,invitations:(await db.query("SELECT i.id,o.name FROM organization_invitation i JOIN organization o ON o.id=i.organization_id WHERE i.email=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()",[user.email.toLowerCase()])).rows};
}
// All callers use one transaction. Organization row serializes membership edits.
export async function organizationAction(db,user,input){
 const action=input.action;
 if(action==='organization-create'){
  const name=nameOf(input.name);
  await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE',[user.id]);
  const {rows}=await db.query('SELECT count(*)::int n FROM organization WHERE created_by=$1',[user.id]);
  if(rows[0].n>=20)fail(409,'Organization limit reached');
  const organization=(await db.query('INSERT INTO organization(name,created_by) VALUES($1,$2) RETURNING id,name',[name,user.id])).rows[0];
  await db.query("INSERT INTO organization_member(organization_id,user_id,role) VALUES($1,$2,'owner')",[organization.id,user.id]);
  return {organization};
 }
 if(action==='organization-accept'){
  if(!uuid(input.invitationId))fail(400,'Choose an invitation');
  const target=(await db.query('SELECT organization_id FROM organization_invitation WHERE id=$1',[input.invitationId])).rows[0];
  if(!target)fail(404,'Invitation not found');
  await db.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE',[target.organization_id]);
  const invitation=(await db.query('SELECT id FROM organization_invitation WHERE id=$1 AND email=$2 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>now() FOR UPDATE',[input.invitationId,user.email.toLowerCase()])).rows[0];
  if(!invitation)fail(404,'Invitation expired or unavailable');
  await db.query("INSERT INTO organization_member(organization_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT(organization_id,user_id) DO UPDATE SET joined_at=CASE WHEN organization_member.removed_at IS NULL THEN organization_member.joined_at ELSE clock_timestamp() END,removed_at=NULL,role=CASE WHEN organization_member.removed_at IS NULL THEN organization_member.role ELSE 'member' END",[target.organization_id,user.id]);
  await db.query('UPDATE organization_invitation SET accepted_at=now() WHERE id=$1',[input.invitationId]);return {accepted:true};
 }
 if(!uuid(input.organizationId))fail(400,'Choose an organization');
 const orgId=input.organizationId;
 await db.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE',[orgId]);
 const actor=(await db.query('SELECT role FROM organization_member WHERE organization_id=$1 AND user_id=$2 AND removed_at IS NULL',[orgId,user.id])).rows[0];
 if(!actor)fail(404,'Organization not found');
 if(action==='organization-detail'){
  const members=(await db.query('SELECT u.id,u.name,u.email,m.role FROM organization_member m JOIN "user" u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.removed_at IS NULL ORDER BY m.joined_at',[orgId])).rows;
  const teams=(await db.query('SELECT id,name FROM team WHERE organization_id=$1 ORDER BY created_at',[orgId])).rows;
  const memberships=(await db.query('SELECT m.team_id,u.id,u.name,u.email,m.role FROM active_team_member m JOIN team t ON t.id=m.team_id JOIN "user" u ON u.id=m.user_id WHERE t.organization_id=$1 ORDER BY m.joined_at',[orgId])).rows;
  const invitations=actor.role==='member'?[]:(await db.query('SELECT id,email,expires_at FROM organization_invitation WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at',[orgId])).rows;
  return {invitations,members,teams:teams.map(t=>({...t,members:memberships.filter(m=>m.team_id===t.id).map(({team_id,...member})=>member)})),role:actor.role};
 }
 if(actor.role==='member')fail(403,'Only organization administrators can make this change');
 if(action==='organization-invitation-revoke'){
  if(!uuid(input.invitationId))fail(400,'Choose an invitation');
  const result=await db.query('UPDATE organization_invitation SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id',[input.invitationId,orgId]);
  if(!result.rowCount)fail(404,'Invitation unavailable');
  return {revoked:true};
 }
 if(action==='organization-invite'){
  const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
  if(email.length>254||!/^\S+@\S+\.\S+$/.test(email))fail(400,'Enter a valid email');
  await db.query('UPDATE organization_invitation SET revoked_at=now() WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=now()',[orgId,email]);
  const invitation=(await db.query('INSERT INTO organization_invitation(organization_id,email,invited_by) VALUES($1,$2,$3) ON CONFLICT(organization_id,email) WHERE accepted_at IS NULL AND revoked_at IS NULL DO NOTHING RETURNING id,email',[orgId,email,user.id])).rows[0];
  return {invitation:invitation??null,alreadyInvited:!invitation};
 }
 if(action==='organization-team-member-add'){
  if(!uuid(input.teamId))fail(400,'Choose a team');
  const team=(await db.query('SELECT id FROM team WHERE id=$1 AND organization_id=$2 FOR UPDATE',[input.teamId,orgId])).rows[0];
  if(!team)fail(404,'Team not found');
  const member=(await db.query('SELECT 1 FROM organization_member WHERE organization_id=$1 AND user_id=$2 AND removed_at IS NULL',[orgId,input.userId])).rows[0];
  if(!member)fail(409,'This person must join the organization first');
  await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT(team_id,user_id) DO UPDATE SET joined_at=CASE WHEN team_member.removed_at IS NULL THEN team_member.joined_at ELSE clock_timestamp() END,removed_at=NULL,role=CASE WHEN team_member.removed_at IS NULL THEN team_member.role ELSE 'member' END",[input.teamId,input.userId]);return {added:true};
 }
 if(action==='organization-team-member-remove'){
  if(!uuid(input.teamId))fail(400,'Choose a team');
  const team=(await db.query('SELECT id FROM team WHERE id=$1 AND organization_id=$2 FOR UPDATE',[input.teamId,orgId])).rows[0];
  if(!team)fail(404,'Team not found');
  const target=(await db.query('SELECT role FROM team_member WHERE team_id=$1 AND user_id=$2 AND removed_at IS NULL',[input.teamId,input.userId])).rows[0];
  if(!target)fail(404,'Team member not found');
  if(target.role==='owner')fail(409,'Transfer team ownership before removing its owner');
  await db.query('UPDATE team_member SET removed_at=now() WHERE team_id=$1 AND user_id=$2',[input.teamId,input.userId]);
  return {removed:true};
 }
 if(action==='organization-team-create'){
  const name=nameOf(input.name);
  const team=(await db.query('INSERT INTO team(name,owner_id,organization_id) VALUES($1,$2,$3) RETURNING id,name',[name,user.id,orgId])).rows[0];
  await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'owner')",[team.id,user.id]);return {team};
 }
 if(action==='organization-workspace-attach'){
  // Explicit attachment only; never transfer somebody else's workspace or billing.
  const workspace=(await db.query('SELECT owner_id,organization_id FROM workspace WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[input.workspaceId])).rows[0];
  if(!workspace||workspace.owner_id!==user.id)fail(403,'Only the workspace owner can add it to an organization');
  if(workspace.organization_id&&workspace.organization_id!==orgId)fail(409,'Workspace already belongs to another organization');
  const outside=(await db.query(`SELECT 1 FROM workspace_member w WHERE w.workspace_id=$1 AND w.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM organization_member m WHERE m.organization_id=$2 AND m.user_id=w.user_id AND m.removed_at IS NULL) LIMIT 1`,[input.workspaceId,orgId])).rows[0];
  if(outside)fail(409,'Add existing workspace members to the organization before moving this workspace');
  await db.query('UPDATE workspace SET organization_id=$2 WHERE id=$1',[input.workspaceId,orgId]);return {attached:true};
 }
 if(action==='organization-member-remove'){
  const target=(await db.query('SELECT role FROM organization_member WHERE organization_id=$1 AND user_id=$2 AND removed_at IS NULL',[orgId,input.userId])).rows[0];
  if(!target)fail(404,'Member not found');
  if(target.role==='owner'||(actor.role==='admin'&&target.role==='admin'))fail(403,'You cannot remove this member');
  const owned=(await db.query('SELECT 1 FROM workspace WHERE organization_id=$1 AND owner_id=$2 AND deleted_at IS NULL LIMIT 1',[orgId,input.userId])).rows[0];
  if(owned)fail(409,'Transfer workspace ownership before removing this member');
  await db.query('SELECT id FROM team WHERE organization_id=$1 ORDER BY id FOR UPDATE',[orgId]);
  await db.query('UPDATE organization_member SET removed_at=now() WHERE organization_id=$1 AND user_id=$2',[orgId,input.userId]);
  await db.query('UPDATE team_member SET removed_at=now() WHERE user_id=$2 AND team_id IN(SELECT id FROM team WHERE organization_id=$1)',[orgId,input.userId]);
  return {removed:true};
 }
 fail(400,'Unknown organization action');
}

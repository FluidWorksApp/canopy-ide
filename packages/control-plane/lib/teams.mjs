const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const email=value=>{if(typeof value!=='string'||value.length>254||!/^\S+@\S+\.\S+$/.test(value))fail(400,'Enter a valid email');return value.trim().toLowerCase();};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
async function member(db,teamId,userId){if(!uuid(teamId))fail(400,'Choose a team');const row=(await db.query('SELECT role FROM active_team_member WHERE team_id=$1 AND user_id=$2 AND removed_at IS NULL',[teamId,userId])).rows[0];if(!row)fail(404,'Team not found');return row;}
export async function listTeams(db,user){
 const teams=(await db.query('SELECT t.id,t.name,t.organization_id,m.role FROM team t JOIN active_team_member m ON m.team_id=t.id WHERE m.user_id=$1 AND m.removed_at IS NULL ORDER BY t.created_at',[user.id])).rows;
 const invitations=(await db.query('SELECT i.id,t.name,t.id AS team_id FROM team_invitation i JOIN team t ON t.id=i.team_id WHERE i.email=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() ORDER BY i.created_at',[user.email.toLowerCase()])).rows;
 return {teams,invitations,selfId:user.id};
}
// Caller wraps mutations in a transaction. Locking the team serializes revocation,
// invitations and message delivery so removal cannot race a new message.
export async function teamAction(db,user,input){
 const {action,teamId}=input;
 if(action==='create'){
  const name=typeof input.name==='string'?input.name.trim():'';if(!name||name.length>80)fail(400,'Choose a team name between 1 and 80 characters');
  await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE',[user.id]);
  const count=(await db.query('SELECT count(*)::int n FROM team WHERE owner_id=$1',[user.id])).rows[0].n;if(count>=20)fail(409,'Team limit reached');
  const team=(await db.query('INSERT INTO team(name,owner_id) VALUES($1,$2) RETURNING id,name',[name,user.id])).rows[0];
  await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'owner')",[team.id,user.id]);return {team};
 }
 if(action==='accept'){
  if(!uuid(input.invitationId))fail(400,'Invalid invitation');
  // Lock team first, consistently with invite/remove/revoke.
  const target=(await db.query('SELECT team_id FROM team_invitation WHERE id=$1',[input.invitationId])).rows[0];if(!target)fail(404,'Invitation not found');
  await db.query('SELECT id FROM team WHERE id=$1 FOR UPDATE',[target.team_id]);
  const invitation=(await db.query('SELECT * FROM team_invitation WHERE id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',[input.invitationId,user.email.toLowerCase()])).rows[0];if(!invitation)fail(404,'Invitation expired or unavailable');
  const teamOrg=(await db.query('SELECT organization_id FROM team WHERE id=$1',[target.team_id])).rows[0]?.organization_id;
  if(teamOrg&&!(await db.query('SELECT 1 FROM organization_member WHERE organization_id=$1 AND user_id=$2 AND removed_at IS NULL',[teamOrg,user.id])).rows.length)fail(403,'Join the organization before accepting this team invitation');
  await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT(team_id,user_id) DO UPDATE SET removed_at=NULL,role=CASE WHEN team_member.removed_at IS NULL THEN team_member.role ELSE 'member' END,joined_at=now()",[invitation.team_id,user.id]);
  await db.query('UPDATE team_invitation SET accepted_at=now() WHERE id=$1',[invitation.id]);return {accepted:true};
 }
 if(!uuid(teamId))fail(400,'Choose a team');
 await db.query('SELECT id FROM team WHERE id=$1 FOR UPDATE',[teamId]);
 const actor=await member(db,teamId,user.id);
 if(action==='detail'){
  const members=(await db.query('SELECT u.id,u.name,u.email,m.role FROM active_team_member m JOIN "user" u ON u.id=m.user_id WHERE m.team_id=$1 AND m.removed_at IS NULL ORDER BY m.joined_at',[teamId])).rows;
  const invitations=actor.role==='member'?[]:(await db.query('SELECT id,email,expires_at FROM team_invitation WHERE team_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()',[teamId])).rows;
  return {members,invitations,role:actor.role};
 }
 if(action==='invite'){
  if(actor.role==='member')fail(403,'Only team owners and admins can invite');const address=email(input.email);
  const existing=(await db.query('SELECT 1 FROM active_team_member m JOIN "user" u ON u.id=m.user_id WHERE m.team_id=$1 AND lower(u.email)=$2 AND m.removed_at IS NULL',[teamId,address])).rows[0];if(existing)fail(409,'This person is already a member');
  await db.query('UPDATE team_invitation SET revoked_at=now() WHERE team_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=now()',[teamId,address]);
  const invitation=(await db.query('INSERT INTO team_invitation(team_id,email,invited_by) VALUES($1,$2,$3) ON CONFLICT(team_id,email) WHERE accepted_at IS NULL AND revoked_at IS NULL DO NOTHING RETURNING id,email',[teamId,address,user.id])).rows[0];
  return {invitation:invitation??null,alreadyInvited:!invitation};
 }
 if(action==='revoke-invitation'){
  if(actor.role==='member')fail(403,'Only team owners and admins can revoke invitations');if(!uuid(input.invitationId))fail(400,'Invalid invitation');await db.query('UPDATE team_invitation SET revoked_at=now() WHERE id=$1 AND team_id=$2 AND accepted_at IS NULL',[input.invitationId,teamId]);return {revoked:true};
 }
 if(action==='remove'||action==='role'){
  const target=await member(db,teamId,input.userId);
  if(target.role==='owner'||actor.role==='member'||(actor.role==='admin'&&target.role==='admin'))fail(403,'You cannot change this member');
  if(action==='role'){
   if(actor.role!=='owner'||!['admin','member'].includes(input.role))fail(403,'Only the owner can assign roles');
   await db.query('UPDATE team_member SET role=$3 WHERE team_id=$1 AND user_id=$2',[teamId,input.userId,input.role]);
  }else await db.query('UPDATE team_member SET removed_at=now() WHERE team_id=$1 AND user_id=$2',[teamId,input.userId]);
  return {updated:true};
 }
 // Message bodies must never enter the account database. Team IM uses the peer transport.
 if(action==='messages'||action==='send')fail(410,'Team messages use the encrypted peer connection');
 fail(400,'Unknown team action');
}

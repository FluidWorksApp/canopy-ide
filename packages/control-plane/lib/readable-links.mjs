import {createHash} from 'node:crypto';
import {ADJECTIVES,NOUNS} from './readable-words.mjs';
import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
import {sessionAccess} from './session-access.mjs';
import {invitationPublicOrigin} from './invitation-url.mjs';
// Human-readable Canopy links: https://canopyide.dev/<namespace>/<path>.
//   <team>/<workspace>                    a workspace
//   <team>/<workspace>/s/<slug>           a shared agent session
//   <team>/t/<general|dm>/<word-slug>     a team chat message, plan or handoff
// A namespace is a team (or, for a personal workspace, a person). A link is a
// name, never a credential: resolving it re-checks the viewer's current access
// (workspace grants, session sharing, team membership) every time, so sending
// one to the wrong person reveals nothing and removal from a team or workspace
// takes effect immediately. Links are permanent until revoked and a revoked
// path is never handed out again.
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const workspaceId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const shortId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
export const LINK_KINDS=Object.freeze(['workspace','session','message']);
export const CHANNELS=Object.freeze(['general','dm']);
// First path segments the canopyide.dev website already serves or may need.
// The website must extend this before adding a top-level route; a team named
// after one gets a suffixed handle ("support-team") instead.
export const RESERVED_HANDLES=Object.freeze(['about','account','accounts','admin','api','app','apps','assets','auth','billing','blog','careers','changelog','contact','dashboard','docs','download','downloads','help','home','invite','invitations','join','legal','link','links','login','logout','new','oauth','organizations','personal-teams','press','pricing','privacy','s','security','settings','sign-in','sign-out','sign-up','signin','signup','static','status','support','t','team','teams','terms','u','user','users','www','workspace','workspaces','_next','favicon-ico','robots-txt','sitemap-xml']);
const reserved=new Set(RESERVED_HANDLES);
const HANDLE=/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,SEGMENT=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const linkOrigin=(configured=process.env.CANOPY_PUBLIC_URL)=>invitationPublicOrigin(configured);

/** Lowercase ASCII words joined by single hyphens, cut on a word boundary. */
export function slugify(value,max=32){
 const words=String(value??'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean);
 let out='';for(const word of words){const next=out?`${out}-${word}`:word;if(next.length>max){if(!out)out=word.slice(0,max);break;}out=next;}
 return out;
}
const digest=(seed,attempt)=>createHash('sha256').update(`canopy-readable-v1\0${seed}\0${attempt}`).digest();
/** adjective-noun-NN, deterministic in (seed, attempt) so a collision retry
 * is stable and the same target always proposes the same first name. */
export function wordSlug(seed,attempt=0){
 const d=digest(seed,attempt);
 return `${ADJECTIVES[d.readUInt32BE(0)%ADJECTIVES.length]}-${NOUNS[d.readUInt32BE(4)%NOUNS.length]}-${10+d[8]%90}`;
}
/** The task name plus a two-digit suffix ("fix-login-bug-27"); a word slug
 * when the title has nothing readable in it or its suffixes are exhausted. */
export function sessionSlug(title,seed,attempt=0){
 const base=slugify(title,28);
 if(base.length<3||attempt>=12)return wordSlug(seed,attempt);
 return `${base}-${10+digest(seed,attempt)[0]%90}`;
}
export function workspaceSlug(name,attempt=0){
 let base=slugify(name,32)||'workspace';if(base==='s'||base==='t')base=`${base}-workspace`;
 return attempt?`${base}-${attempt+1}`:base;
}
export function handleCandidate(name,attempt=0,fallback='team'){
 let base=slugify(name,24);if(base.length<2)base=fallback;if(reserved.has(base))base=`${base}-${fallback}`;
 return attempt?`${base}-${attempt+1}`:base;
}
/** The shape a path must have for its kind, or null. */
export function pathKind(path){
 const parts=typeof path==='string'?path.split('/'):[];
 if(!parts.length||!parts.every(p=>SEGMENT.test(p)))return null;
 if(parts.length===1&&parts[0]!=='s'&&parts[0]!=='t')return 'workspace';
 if(parts.length===3&&parts[0]==='t'&&CHANNELS.includes(parts[1]))return 'message';
 if(parts.length===3&&parts[0]!=='t'&&parts[0]!=='s'&&parts[1]==='s')return 'session';
 return null;
}
/** Read a pasted or opened readable URL. Accepts the canonical
 * https://canopyide.dev/<team>/<path> and, so a later move to wildcard team
 * subdomains stays compatible, https://<team>.canopyide.dev/<path>. */
export function parseReadableUrl(raw,origin=linkOrigin()){
 let url,base;try{url=new URL(String(raw).trim());base=new URL(origin);}catch{return null;}
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!==base.port)return null;
 const host=url.hostname.toLowerCase().replace(/\.$/,''),root=base.hostname.toLowerCase();
 const segments=url.pathname.split('/').filter(Boolean).map(s=>{try{return decodeURIComponent(s).toLowerCase();}catch{return '';}});
 let namespace;
 if(host===root||host===`www.${root}`)namespace=segments.shift();
 else if(host.endsWith(`.${root}`)&&!host.slice(0,-root.length-1).includes('.'))namespace=host.slice(0,-root.length-1);
 else return null;
 if(!namespace||!HANDLE.test(namespace)||reserved.has(namespace))return null;
 const path=segments.join('/'),kind=pathKind(path);
 return kind?{namespace,path,kind}:null;
}
export const readableUrl=(namespace,path,origin=linkOrigin())=>`${origin}/${namespace}/${path}`;

// ---------- database ----------
async function teamMember(db,teamId,userId){
 if(!uuid(teamId))fail(400,'Choose a team');
 return (await db.query('SELECT m.role,t.name,t.organization_id FROM active_team_member m JOIN team t ON t.id=m.team_id WHERE m.team_id=$1 AND m.user_id=$2 AND m.removed_at IS NULL',[teamId,userId])).rows[0]??null;
}
/** The team's (or person's) handle, created on first use. Locked for the
 * rest of the caller's transaction so link allocation in it is serialized. */
async function ensureNamespace(db,{teamId=null,userId=null,name}){
 const column=teamId?'team_id':'user_id',owner=teamId??userId;
 let handle=(await db.query(`SELECT handle FROM link_namespace WHERE ${column}=$1`,[owner])).rows[0]?.handle;
 for(let attempt=0;!handle&&attempt<50;attempt++){
  const candidate=handleCandidate(name,attempt,teamId?'team':'me');
  handle=(await db.query('INSERT INTO link_namespace(handle,team_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING handle',[candidate,teamId,userId])).rows[0]?.handle;
  // A concurrent caller may have named this owner first.
  handle??=(await db.query(`SELECT handle FROM link_namespace WHERE ${column}=$1`,[owner])).rows[0]?.handle;
 }
 if(!handle)fail(409,'Could not choose a readable name');
 await db.query('SELECT handle FROM link_namespace WHERE handle=$1 FOR UPDATE',[handle]);
 return handle;
}
async function allocate(db,user,{namespace,kind,targetKey,target,workspace=null,team=null,candidate}){
 const existing=(await db.query('SELECT namespace,path FROM readable_link WHERE namespace=$1 AND target_key=$2 AND revoked_at IS NULL',[namespace,targetKey])).rows[0];
 if(existing)return {...existing,created:false};
 for(let attempt=0;attempt<40;attempt++){
  const path=candidate(attempt);if(pathKind(path)!==kind)continue;
  const row=(await db.query('INSERT INTO readable_link(namespace,path,kind,target,target_key,workspace_id,team_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING namespace,path',[namespace,path,kind,target,targetKey,workspace,team,user.id])).rows[0];
  if(row)return {...row,created:true};
 }
 fail(409,'Could not allocate a readable link');
}
const anyActive=async(db,targetKey)=>(await db.query('SELECT namespace,path FROM readable_link WHERE target_key=$1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1',[targetKey])).rows[0]??null;
async function viewableWorkspace(db,user,id){
 if(!workspaceId(id))fail(400,'Choose a workspace');
 const grants=await workspaceAccess(db,id,user.id);
 // Not found rather than forbidden: a link never confirms what exists.
 if(!allowsWorkspaceAccess(grants,{action:'view'}))fail(404,'Workspace not found');
 const row=(await db.query('SELECT id,name,owner_id,organization_id FROM workspace WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];if(!row)fail(404,'Workspace not found');
 return {workspace:row,grants};
}
/** Session rights stay on the grant that shared sessions (session-access.mjs);
 * personal develop rights never turn into the right to watch a session. */
export function maySeeSession(grants,projectId){
 if(grants.some(g=>g.role==='owner'))return true;
 const view=sessionAccess(grants).view;
 return view.allRead||view.selected.some(p=>p.id===projectId);
}
async function workspaceNamespace(db,user,workspace,teamId){
 if(teamId){
  const member=await teamMember(db,teamId,user.id);if(!member)fail(404,'Team not found');
  if(workspace.organization_id&&member.organization_id!==workspace.organization_id)fail(400,'That team is in another organization');
  return ensureNamespace(db,{teamId,name:member.name});
 }
 // Prefer the team through which the person sees the workspace, so the URL
 // reads as the team's; a personal workspace lives under the person.
 const team=workspace.organization_id?(await db.query(`SELECT t.id,t.name FROM workspace_team_access a JOIN team t ON t.id=a.team_id
 JOIN active_team_member m ON m.team_id=t.id AND m.user_id=$2 AND m.removed_at IS NULL
 WHERE a.workspace_id=$1 AND a.revoked_at IS NULL ORDER BY t.created_at LIMIT 1`,[workspace.id,user.id])).rows[0]:null;
 if(team)return ensureNamespace(db,{teamId:team.id,name:team.name});
 return ensureNamespace(db,{userId:user.id,name:user.name||String(user.email??'').split('@')[0]});
}
async function ensureWorkspaceLink(db,user,input){
 const {workspace}=await viewableWorkspace(db,user,input.workspaceId),targetKey=`workspace:${workspace.id}`;
 const reuse=!input.teamId&&await anyActive(db,targetKey);if(reuse)return {...reuse,created:false};
 const namespace=await workspaceNamespace(db,user,workspace,input.teamId);
 return allocate(db,user,{namespace,kind:'workspace',targetKey,target:{workspaceId:workspace.id},workspace:workspace.id,candidate:attempt=>workspaceSlug(workspace.name,attempt)});
}
async function ensureSessionLink(db,user,input){
 const {workspace,grants}=await viewableWorkspace(db,user,input.workspaceId);
 if(!shortId(input.publicationId)||!shortId(input.projectId))fail(400,'Choose a shared session');
 if(!maySeeSession(grants,input.projectId))fail(404,'Session not found');
 const targetKey=`session:${workspace.id}:${input.publicationId}`,reuse=await anyActive(db,targetKey);if(reuse)return {...reuse,created:false};
 // Sessions sit under their workspace's link, in the same namespace.
 const parent=await ensureWorkspaceLink(db,user,{workspaceId:workspace.id});
 await db.query('SELECT handle FROM link_namespace WHERE handle=$1 FOR UPDATE',[parent.namespace]);
 const title=typeof input.title==='string'?input.title.slice(0,80):'';
 return allocate(db,user,{namespace:parent.namespace,kind:'session',targetKey,target:{workspaceId:workspace.id,projectId:input.projectId,publicationId:input.publicationId,title},workspace:workspace.id,candidate:attempt=>`${parent.path}/s/${sessionSlug(title,targetKey,attempt)}`});
}
// Message links carry ids only. Bodies stay end-to-end encrypted on members'
// devices (teams.mjs refuses to store them); the app finds the message in its
// local history and opens the conversation if it has aged out.
async function ensureMessageLink(db,user,input){
 const member=await teamMember(db,input.teamId,user.id);if(!member)fail(404,'Team not found');
 if(!uuid(input.messageId))fail(400,'Choose a message');
 const peer=input.peer??null;
 if(peer!==null&&(!shortId(peer)||peer===user.id||!(await teamMember(db,input.teamId,peer))))fail(404,'Conversation not found');
 const participants=peer===null?null:[user.id,peer].sort(),channel=peer===null?'general':'dm';
 const targetKey=`message:${input.teamId}:${participants?participants.join(','):'general'}:${input.messageId}`;
 const namespace=await ensureNamespace(db,{teamId:input.teamId,name:member.name});
 return allocate(db,user,{namespace,kind:'message',targetKey,target:{teamId:input.teamId,messageId:input.messageId,participants},team:input.teamId,candidate:attempt=>`t/${channel}/${wordSlug(targetKey,attempt)}`});
}
async function lookup(db,input){
 const parsed=typeof input.url==='string'?parseReadableUrl(input.url,input.origin):null;
 if(!parsed)fail(404,'Link not found');
 const row=(await db.query('SELECT l.*,n.team_id AS namespace_team FROM readable_link l JOIN link_namespace n ON n.handle=l.namespace WHERE l.namespace=$1 AND l.path=$2',[parsed.namespace,parsed.path])).rows[0];
 if(!row||row.kind!==parsed.kind)fail(404,'Link not found');
 return row;
}
/** What the viewer may learn about the link's target, or null for nothing. */
async function authorizedView(db,user,row){
 const t=row.target??{};
 if(row.kind==='workspace'||row.kind==='session'){
  const grants=await workspaceAccess(db,t.workspaceId,user.id);
  if(!allowsWorkspaceAccess(grants,{action:'view'}))return null;
  if(row.kind==='session'&&!maySeeSession(grants,t.projectId))return null;
  const workspace=(await db.query('SELECT name,owner_id FROM workspace WHERE id=$1 AND deleted_at IS NULL',[t.workspaceId])).rows[0];if(!workspace)return null;
  return {view:row.kind==='workspace'?{workspaceId:t.workspaceId,name:workspace.name}:{workspaceId:t.workspaceId,workspaceName:workspace.name,projectId:t.projectId,publicationId:t.publicationId,title:t.title??''},owner:workspace.owner_id===user.id};
 }
 if(row.kind==='message'){
  const member=await teamMember(db,t.teamId,user.id);if(!member)return null;
  if(t.participants&&!t.participants.includes(user.id))return null;
  const peer=t.participants?t.participants.find(id=>id!==user.id)??null:null;
  const peerName=peer?(await db.query('SELECT name FROM "user" WHERE id=$1',[peer])).rows[0]?.name??'':'';
  return {view:{teamId:t.teamId,teamName:member.name,peer,peerName,messageId:t.messageId,viewer:user.id},teamRole:member.role};
 }
 return null;
}
export async function resolveReadableLink(db,user,input){
 const row=await lookup(db,input),allowed=await authorizedView(db,user,row);
 if(!allowed)fail(404,'Link not found');
 if(row.revoked_at)fail(410,'This link was revoked');
 return {link:{url:readableUrl(row.namespace,row.path,input.origin),kind:row.kind,target:allowed.view}};
}
// The HTTP caller (POST /api/links) authenticates with principal(), checks
// mayMutate() for ensure/revoke, and wraps each action in a transaction.
export async function readableLinkAction(db,user,input={}){
 const origin=input.origin??linkOrigin();
 if(input.action==='ensure'){
  if(!LINK_KINDS.includes(input.kind))fail(400,'Unknown link type');
  const link=input.kind==='workspace'?await ensureWorkspaceLink(db,user,input):input.kind==='session'?await ensureSessionLink(db,user,input):await ensureMessageLink(db,user,input);
  return {link:{url:readableUrl(link.namespace,link.path,origin),kind:input.kind,created:link.created}};
 }
 if(input.action==='resolve')return resolveReadableLink(db,user,{...input,origin});
 if(input.action==='revoke'){
  const row=await lookup(db,{...input,origin}),allowed=await authorizedView(db,user,row);
  if(!allowed)fail(404,'Link not found');
  if(row.revoked_at)return {revoked:true};
  // Admins of the team whose namespace holds the link may tidy it up.
  const teamRole=allowed.teamRole??(row.namespace_team?(await teamMember(db,row.namespace_team,user.id))?.role:null);
  if(row.created_by!==user.id&&!allowed.owner&&!['owner','admin'].includes(teamRole))fail(403,'Only the person who made this link, the workspace owner or a team admin can revoke it');
  await db.query('UPDATE readable_link SET revoked_at=now(),revoked_by=$2 WHERE id=$1 AND revoked_at IS NULL',[row.id,user.id]);
  return {revoked:true};
 }
 fail(400,'Unknown link action');
}

import {randomUUID} from 'node:crypto';
import {validateProjectAccess,grantedProjects,projectMounts} from './project-mounts.mjs';
import {memberRuntime} from './member-runtime.mjs';
export function validateSessionAccess(value){
 if(!value||Object.keys(value).length!==2||!Object.hasOwn(value,'view')||!Object.hasOwn(value,'interact'))throw Error('Invalid session access');
 return {view:validateProjectAccess(value.view),interact:validateProjectAccess(value.interact)};
}
export async function sessionRuntimeJson(response){
 const reader=response.body?.getReader();if(!reader)throw Error('Session runtime response is unavailable');
 let length=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();throw Error('Session runtime response is too large');}chunks.push(Buffer.from(value));}return JSON.parse(Buffer.concat(chunks).toString());}finally{reader.releaseLock();}
}
// A live agent session the published terminal belongs to (src/liveSession in
// the IDE): the owner's room id, account and team, so a viewer can join it.
// Opaque to this host; bounded and plain so the list stays safe to render.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const plainId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
export const validRoom=room=>!!room&&typeof room==='object'&&!Array.isArray(room)&&Object.keys(room).length===3&&UUID.test(room.id)&&plainId(room.owner)&&plainId(room.team);
export const PAIR_NEEDS_SHARED_PROJECT='Pair needs a shared project. This is one of your own projects, so teammates can watch its terminals but not type in them.';
// An owner project is granted by the same id rule as a mount (all projects, or
// that id selected). Never writable here: its publications are watch-only.
function ownerProjectGrant(workspace,access,projectId){
 if(!access)return null;validateProjectAccess(access);projectMounts(workspace);
 if((workspace.projectMounts??[]).some(p=>p.id===projectId))return null;
 return access.allRead||access.selected.some(item=>item.id===projectId)?{id:projectId,writable:false}:null;
}
// Explicit, management-owned publications. Never restore these after a gateway
// restart: stale terminal IDs must not publish a replacement terminal silently.
export class SharedSessions {
 constructor({authorizeMember,stop=async()=>{},now=Date.now,maxAgeMs=3600000}={}){this.authorizeMember=authorizeMember;this.stop=stop;this.now=now;this.maxAgeMs=maxAgeMs;this.entries=new Map();this.pendingStops=new Map();this.timer=setInterval(()=>{this.prune();for(const p of this.pendingStops.values())void this.stopPending(p);},5000);this.timer.unref();}
 // `ownerProjectIds`: ids of the owner's own IDE projects (the host's
 // sanitized catalog). They live at arbitrary paths on the owner's whole
 // /workspace volume, not on a per-project mount, so a clean collaboration
 // shell cannot get just that project: Pair stays with administrator-shared
 // project mounts, and an owner project says so instead of a bare refusal.
 collaboration(workspace,{projectId,title},{ownerProjectIds=new Set()}={}){
  this.prune();if(this.entries.size>=128)throw Error('Shared session capacity reached');
  const project=(workspace.projectMounts??[]).find(p=>p.id===projectId&&p.writable);
  if(!project&&typeof projectId==='string'&&ownerProjectIds.has(projectId)&&!(workspace.projectMounts??[]).some(p=>p.id===projectId))throw Error(PAIR_NEEDS_SHARED_PROJECT);
  if(!project||typeof title!=='string'||!title.trim()||title.length>80)throw Error('Invalid collaboration project');
  const id=randomUUID(),runtime=memberRuntime({...workspace,projectMounts:[project]},{workspaceId:workspace.id,memberId:`collaboration:${id}`,scope:'drive'},{allRead:false,allWrite:false,selected:[{id:projectId,writable:true}]});
  return {id,workspaceId:workspace.id,projectId,title:title.trim(),mode:'interact',expiresAt:this.now()+this.maxAgeMs,runtime};
 }
 register(entry,sessionId){if(!Number.isSafeInteger(sessionId)||sessionId<1||this.entries.has(entry.id))throw Error('Invalid collaboration session');this.entries.set(entry.id,{...entry,sessionId});return entry.id;}
 activeRuntime(id){this.prune();return [...this.entries.values()].some(p=>p.runtime?.id===id);}
 async stopPending(p){if(p.stopping)return;p.stopping=true;try{await this.stop(p.runtime);this.pendingStops.delete(p.runtime.id);}catch{p.failed=true;}finally{p.stopping=false;}}
 remove(id){const p=this.entries.get(id);this.entries.delete(id);if(p?.runtime){const pending={runtime:p.runtime,stopping:false};this.pendingStops.set(p.runtime.id,pending);return this.stopPending(pending).then(()=>{if(this.pendingStops.has(p.runtime.id))throw Error('Sharing revoked; collaboration shell shutdown is pending. Retry shortly.');});}return Promise.resolve();}
 close(){clearInterval(this.timer);for(const id of this.entries.keys())void this.remove(id).catch(()=>{});}
 // Watching needs only the terminal's output, so an owner project (see
 // collaboration) may be published too. The entry remembers it is one: its
 // viewers are members granted that project id, as for a mount.
 publish(workspace,{sessionId,projectId,title,mode,acknowledged,room},{ownerProjectIds=new Set()}={}){
  if(room!==undefined&&!validRoom(room))throw Error('Invalid session publication');
  const mounted=(workspace.projectMounts??[]).some(p=>p.id===projectId),catalog=!mounted&&typeof projectId==='string'&&ownerProjectIds.has(projectId);
  if(acknowledged!==true||!Number.isSafeInteger(sessionId)||sessionId<1||!['view','interact'].includes(mode)||typeof title!=='string'||!title.trim()||title.length>80||!mounted&&!catalog)throw Error('Invalid session publication');
  this.prune();if(this.entries.size>=128)throw Error('Shared session capacity reached');
  for(const [id,p] of this.entries)if(p.workspaceId===workspace.id&&!p.runtime&&p.sessionId===sessionId)void this.remove(id).catch(()=>{});
  const entry={id:randomUUID(),workspaceId:workspace.id,sessionId,projectId,title:title.trim(),mode,expiresAt:this.now()+this.maxAgeMs,...(room?{room:{id:room.id,owner:room.owner,team:room.team}}:{})};this.entries.set(entry.id,catalog?{...entry,catalog:true}:entry);return {...entry};
 }
 prune(){for(const [id,p] of this.entries)if(p.expiresAt<=this.now())void this.remove(id).catch(()=>{});}
 async revoke(workspaceId,id){const entry=this.entries.get(id);if(!entry||entry.workspaceId!==workspaceId)throw Error('Forbidden');await this.remove(id);}
 ownerList(workspaceId){this.prune();return [...this.entries.values()].filter(p=>p.workspaceId===workspaceId).map(({runtime,catalog:_catalog,...p})=>({...p,collaborative:!!runtime}));}
 async resolve(workspace,principal,bearer,id,operation='view'){
  if(typeof this.authorizeMember!=='function'||!principal?.memberId||principal.workspaceId!==workspace.id||!Number.isFinite(principal.expiresAt)||principal.expiresAt<=this.now()||!this.entries.has(id)||!['view','interact'].includes(operation))throw Error('Forbidden');
  const current=await this.authorizeMember(principal,bearer);
  return this.resolveAuthorized(workspace,principal,id,operation,current);
 }
 resolveAuthorized(workspace,principal,id,operation,current){
  this.prune();const p=this.entries.get(id);
  if(!p||p.workspaceId!==workspace.id||!['view','interact'].includes(operation)||operation==='interact'&&p.mode!=='interact'||!principal?.memberId||principal.workspaceId!==workspace.id||!Number.isFinite(principal.expiresAt)||principal.expiresAt<=this.now()||['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state))throw Error('Forbidden');
  if(!current?.projectAccess||!current.sessionAccess)throw Error('Forbidden');
  const project=p.catalog?ownerProjectGrant(workspace,current.projectAccess,p.projectId):grantedProjects(workspace,current.projectAccess).find(item=>item.id===p.projectId);if(!project)throw Error('Forbidden');
  const access=validateSessionAccess(current.sessionAccess)[operation],selected=access.selected.find(item=>item.id===p.projectId);
  if(operation==='interact'?(!project.writable||!access.allWrite&&!selected?.writable):(!access.allRead&&!selected))throw Error('Forbidden');
  // Revoke/expiry while the authority request was in flight also fails closed.
  if(this.entries.get(id)!==p||p.expiresAt<=this.now())throw Error('Forbidden');
  return {...p};
 }
 async list(workspace,principal,bearer){const result=[];if(typeof this.authorizeMember!=='function'||!principal?.memberId||principal.workspaceId!==workspace.id||!Number.isFinite(principal.expiresAt)||principal.expiresAt<=this.now())return result;const current=await this.authorizeMember(principal,bearer);for(const p of this.ownerList(workspace.id)){try{this.resolveAuthorized(workspace,principal,p.id,'view',current);let canInteract=false;try{this.resolveAuthorized(workspace,principal,p.id,'interact',current);canInteract=true;}catch{}result.push({id:p.id,projectId:p.projectId,title:p.title,mode:canInteract?'interact':'view',expiresAt:p.expiresAt,...(p.room?{room:{...p.room}}:{})});}catch{}}return result;}
}

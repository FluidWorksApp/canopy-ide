import {createHmac} from 'node:crypto';
import {validId} from './policy.mjs';
// Automatic infrastructure shutdown never uses development-runtime replies.
// Running user containers are conservatively busy until a richer trusted host
// process observer exists. This proof only covers fully stopped compute jobs.
export class IdleAttestation{
 constructor({config,host,authorizeRuntime,busy=()=>true,instanceName=process.env.CANOPY_INSTANCE_NAME,now=Date.now}){Object.assign(this,{config,host,authorizeRuntime,busy,instanceName,now});this.reservations=new Map();host.idleReserved=id=>this.reserved(id);}
 reserved(id){const deadline=this.reservations.get(id);if(deadline!=null&&deadline<=this.now()){this.reservations.delete(id);return false;}return deadline!=null;}
 async attest(workspace,{nonce,generation,instanceName}){
  if(!this.config.managedSession||workspace.id!==this.config.managedSession.workspaceId||typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce)||generation!==workspace.generation||instanceName!==this.instanceName||!this.instanceName||!Number.isSafeInteger(generation)||generation<0||typeof this.authorizeRuntime!=='function')throw Error('Idle proof identity is invalid');
  if(this.reserved(workspace.id))return {idle:false,reason:'An idle shutdown check is already reserved'};
  return this.host.withResourceLock(async()=>{
   const unavailable=()=>({idle:false,reason:'Workspace activity cannot be proved idle'});
   if(this.reserved(workspace.id)||this.busy()||!await this.authorizeRuntime(workspace))return unavailable();
   const listing=await this.host.docker(['ps','--all','--no-trunc','--filter','label=canopy.workspace','--format','{{.ID}}']);
   if(typeof listing.stdout!=='string'||listing.stdout.length>65536)return unavailable();
   const ids=listing.stdout.trim().split(/\r?\n/).filter(Boolean);
   if(ids.length>256||new Set(ids).size!==ids.length||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))return unavailable();
   for(const id of ids){
    const output=await this.host.docker(['inspect',id]);if(typeof output.stdout!=='string'||output.stdout.length>1048576)return unavailable();
    const inspected=JSON.parse(output.stdout);if(!Array.isArray(inspected)||inspected.length!==1)return unavailable();const container=inspected[0],state=container?.State,policy=container?.HostConfig?.RestartPolicy?.Name;
    if(container?.Id!==id||!validId(container.Config?.Labels?.['canopy.workspace'])||state?.Running!==false||state.Paused!==false||state.Restarting!==false||!(policy==='no'||policy==='on-failure'&&state.ExitCode===0&&state.OOMKilled===false))return unavailable();
   }
   if(this.busy()||!await this.authorizeRuntime(workspace))return unavailable();
   const expiresAt=this.now()+30000;this.reservations.set(workspace.id,expiresAt);
   const claims={version:1,purpose:'workspace-idle',workspaceId:workspace.id,generation,instanceName,nonce,idle:true,expiresAt},payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
   return {idle:true,proof:payload+'.'+createHmac('sha256',this.config.managedSession.key).update(payload).digest('base64url')};
  });
 }
}

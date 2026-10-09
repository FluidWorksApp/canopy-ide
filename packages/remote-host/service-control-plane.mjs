import {createHmac,randomBytes} from 'node:crypto';
import {mkdir,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {validId} from './policy.mjs';
// The host's control-plane credential (managedSession.key) also authorizes the
// Canopy service's control-plane calls: access snapshots, host device
// registration and the daemon's relay polling. Each token is purpose-bound by
// `kind` and lives at most two minutes. Shape matches runtime-policy tokens.
export const RELAY_CREDENTIAL_DIR='/run/canopy-relay';
export const HOST_CREDENTIAL_KINDS=new Set(['workspace-access-snapshot','peer-host-registration','peer-relay']);
export function hostCredential(managed,kind,workspace,{now=Date.now,ttlSeconds=120}={}){
 if(!HOST_CREDENTIAL_KINDS.has(kind))throw Error('Unknown host credential purpose');
 if(typeof managed?.key!=='string'||managed.key.length<32||workspace?.id!==managed.workspaceId||!Number.isSafeInteger(workspace.generation??0))throw Error('Host credential unavailable');
 const claims={version:1,kind,workspaceId:workspace.id,generation:workspace.generation??0,expires:Math.floor(now()/1000)+ttlSeconds};
 const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
 return payload+'.'+createHmac('sha256',managed.key).update(payload).digest('base64url');
}
function endpoint(managed,explicit,pathname){
 const configured=managed?.[explicit];
 const source=configured?new URL(configured):managed?.runtimePolicyUrl?new URL(pathname,managed.runtimePolicyUrl):null;
 if(!source)return null;
 if(source.protocol!=='https:'||source.username||source.password||source.search||source.hash||source.pathname!==pathname)throw Error('Invalid service control-plane endpoint');
 return source;
}
async function boundedJson(response,max){
 if(!response.body)return {};
 const reader=response.body.getReader(),chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Error('Control-plane response too large');}chunks.push(Buffer.from(value));}
 const text=Buffer.concat(chunks).toString();return text?JSON.parse(text):{};
}
export function serviceControlPlane(config,{fetchImpl=fetch,now=Date.now,timeoutMs=10000}={}){
 const managed=config.managedSession;if(!managed)return undefined;
 const snapshotUrl=endpoint(managed,'accessSnapshotUrl','/api/workspace-access-snapshot'),peersUrl=endpoint(managed,'peersUrl','/api/peers');
 if(!snapshotUrl&&!peersUrl)return undefined;
 return {
  origin:(snapshotUrl??peersUrl).origin,
  /** The signed snapshot exactly as the control plane issued it. The service,
   *  not this process, verifies the signature and revision. */
  async accessSnapshot(workspace){
   if(!snapshotUrl)throw Error('Access snapshots are not configured');
   const url=new URL(snapshotUrl);url.searchParams.set('workspace',workspace.id);
   const response=await fetchImpl(url.href,{headers:{authorization:'Bearer '+hostCredential(managed,'workspace-access-snapshot',workspace,{now})},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok){await response.body?.cancel();throw Error(`Access snapshot refused (${response.status})`);}
   const snapshot=await boundedJson(response,65536);
   if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw Error('Invalid access snapshot');
   return snapshot;
  },
  async registerHost(workspace,device){
   if(!peersUrl)throw Error('Peer registration is not configured');
   if(typeof device?.deviceId!=='string'||!device.deviceId||device.deviceId.length>256||!device.keys||typeof device.keys!=='object')throw Error('Invalid host device');
   const response=await fetchImpl(peersUrl.href,{method:'POST',headers:{authorization:'Bearer '+hostCredential(managed,'peer-host-registration',workspace,{now}),'content-type':'application/json'},body:JSON.stringify({action:'register-host',deviceId:device.deviceId,keys:{agreement:device.keys.agreement,signing:device.keys.signing},workspaceIds:[workspace.id]}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
   await response.body?.cancel();
   if(!response.ok)throw Error(`Host registration refused (${response.status})`);
   return true;
  },
  /** Raw relay bearer for canopy-serviced, written atomically, group-readable. */
  async writeRelayCredential(workspace,directory=RELAY_CREDENTIAL_DIR){
   if(!validId(workspace.id))throw Error('Invalid workspace');
   const dir=path.join(directory,workspace.id),target=path.join(dir,'relay-credential'),temp=path.join(dir,`.relay-credential-${randomBytes(6).toString('hex')}`);
   await mkdir(dir,{recursive:true,mode:0o750});
   try{await writeFile(temp,hostCredential(managed,'peer-relay',workspace,{now}),{mode:0o640,flag:'wx'});await rename(temp,target);}
   catch(error){await rm(temp,{force:true});throw error;}
  },
 };
}

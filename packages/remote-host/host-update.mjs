import {createHash} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
// In-place host update: the `update-host` management-recovery action. The
// root recovery agent (installed by the control plane's bootstrap) calls this
// with the decrypted payload {url, runtimeSha256, runtimeLockSha256, revision}
// and its own management readiness probe. Only node builtins are imported, so
// the agent can load it from the installed tree.
//
// It replaces the management code only. node_modules move across unchanged,
// which is why a dependency lock change is refused (that needs a full
// refresh). The owner's container keeps running; it serves native commands
// from its image, so this never changes the protocol the IDE talks to.
export const HOST_UPDATE_READY_MS=120000;
export const HOST_UPDATE_MAX_BYTES=32*1024*1024;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const defaultExec=(command,args,options)=>promisify(execFile)(command,args,{maxBuffer:65536,...options});
export function validHostUpdate(payload){
 let url;try{url=new URL(payload?.url);}catch{return false;}
 return url.protocol==='https:'&&!url.username&&!url.password&&/^[a-f0-9]{40}$/.test(payload.revision??'')&&/^[a-f0-9]{64}$/.test(payload.runtimeSha256??'')&&/^[a-f0-9]{64}$/.test(payload.runtimeLockSha256??'');
}
/** Returns {code, revision, detail?}. Codes: `updated`; `current` (already
 * installed); `refresh-required` (lock differs, nothing changed); `invalid`
 * (bad payload, download or archive, nothing changed); `rolled-back` (the new
 * tree failed readiness and the previous one is running again); `failed` (the
 * rollback did not become ready either). */
export async function updateHostInPlace(payload,{root='/opt/canopy-host',units='/etc/systemd/system',user='canopy-host',fetchImpl=fetch,fs=nodeFs,exec=defaultExec,ready,readyMs=HOST_UPDATE_READY_MS,pollMs=1000,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),log=()=>{}}={}){
 if(typeof ready!=='function')throw Error('Host update requires a management readiness check');
 const revision=typeof payload?.revision==='string'?payload.revision:null,result=(code,detail)=>({code,revision,...(detail?{detail}:{})});
 if(!validHostUpdate(payload))return result('invalid','Update request is malformed');
 const next=root+'.next',prev=root+'.prev',archive=root+'.download.tgz';
 const read=async file=>{try{return await fs.readFile(file);}catch(error){if(error?.code==='ENOENT')return null;throw error;}};
 const installed=async dir=>{try{return JSON.parse(String(await read(dir+'/workspace-release.json')))?.revision??null;}catch{return null;}};
 if(await installed(root)===revision&&String(await read(root+'/workspace-runtime.sha256')??'').trim()===payload.runtimeSha256)return result('current');
 const discard=async()=>{await fs.rm(next,{recursive:true,force:true});await fs.rm(archive,{force:true});};
 await discard();
 // 1. Download and check the hash before anything is unpacked.
 let bytes;try{
  const response=await fetchImpl(payload.url,{redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok||!response.body)return result('invalid',`Download failed (${response.status})`);
  const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>HOST_UPDATE_MAX_BYTES)return result('invalid','Archive is too large');chunks.push(Buffer.from(chunk));}
  bytes=Buffer.concat(chunks);
 }catch(error){return result('invalid',`Download failed: ${error?.message??error}`);}
 if(sha256(bytes)!==payload.runtimeSha256)return result('invalid','Archive hash does not match the release');
 // 2. Unpack beside the live tree and refuse a dependency change.
 try{
  await fs.writeFile(archive,bytes,{mode:0o600});await fs.mkdir(next,{mode:0o755});
  await exec('tar',['-xzf',archive,'-C',next,'--no-same-owner'],{timeout:60000});
  const lock=await read(next+'/package-lock.json'),current=await read(root+'/package-lock.json');
  if(!lock||!current||sha256(lock)!==sha256(current)||sha256(lock)!==payload.runtimeLockSha256){await discard();return result('refresh-required','The dependency lock changed; this release needs a full refresh');}
  if(await installed(next)!==revision){await discard();return result('invalid','Archive is for a different release');}
  await fs.writeFile(next+'/workspace-runtime.sha256',payload.runtimeSha256+'\n',{mode:0o644});
  try{await fs.chmod(next+'/network-isolation.sh',0o755);}catch(error){if(error?.code!=='ENOENT')throw error;}
  const uid=Number((await exec('id',['-u',user],{timeout:1000})).stdout.trim()),gid=Number((await exec('id',['-g',user],{timeout:1000})).stdout.trim());
  if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(gid)||gid<1)throw Error('Management service identity unavailable');
  await exec('chown',['-R',`${uid}:${gid}`,next],{timeout:60000});
 }catch(error){await discard().catch(()=>{});return result('invalid',`Unpack failed: ${error?.message??error}`);}
 // 3. Swap by rename, keeping the previous tree. node_modules move with the code.
 const exists=async file=>{try{await fs.stat(file);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}};
 const modules=await exists(root+'/node_modules');
 await fs.rm(prev,{recursive:true,force:true});
 let step=0;try{
  if(modules){await fs.rename(root+'/node_modules',next+'/node_modules');}step=1;
  await fs.rename(root,prev);step=2;
  await fs.rename(next,root);step=3;
 }catch(error){
  if(step>=2)await fs.rename(prev,root).catch(()=>{});
  if(step>=1&&modules)await fs.rename(next+'/node_modules',root+'/node_modules').catch(()=>{});
  await discard().catch(()=>{});return result('invalid',`Swap failed: ${error?.message??error}`);
 }
 await fs.rm(archive,{force:true});
 // 4. Restart and wait for management readiness.
 const start=async()=>{
  try{
   for(const unit of ['canopy-host.service','canopy-network.service'])if(await exists(root+'/'+unit))await fs.copyFile(root+'/'+unit,units+'/'+unit);
   await exec('systemctl',['daemon-reload'],{timeout:5000});await exec('systemctl',['restart','canopy-host'],{timeout:30000});
  }catch(error){log(`Host restart failed: ${error?.message??error}`);}
  for(const deadline=now()+readyMs;;){if(await ready().catch(()=>false))return true;if(now()>=deadline)return false;await sleep(pollMs);}
 };
 if(await start())return result('updated');
 // 5. Restore the previous tree and report the failure.
 log('Updated host did not become ready; restoring the previous host');
 try{
  await fs.rename(root,next);await fs.rename(prev,root);
  if(modules)await fs.rename(next+'/node_modules',root+'/node_modules');
  await fs.rm(next,{recursive:true,force:true});
 }catch(error){return result('failed',`Rollback failed: ${error?.message??error}`);}
 return await start()?result('rolled-back','The updated host did not become ready; the previous host is running'):result('failed','Neither the updated nor the previous host became ready');
}

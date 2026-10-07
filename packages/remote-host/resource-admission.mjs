export const RESOURCE_ADMISSION_PROTOCOL=1;
/** Cross-process host lock. The path is host configuration, never RPC input.
 * Inherited fd3 prevents symlink replacement from changing the locked inode.
 *
 * Ownership contract (canopy-runtime.tmpfiles.conf): the lock and /run/canopy
 * are created only by systemd-tmpfiles as root (root:canopy-host 0660 in a
 * root 0755 directory). Both sides, the unprivileged gateway and the root
 * recovery agent, only open an existing file: never O_CREAT, so a process that
 * happens to run first cannot leave a file the other side cannot open. */
export const RESOURCE_ADMISSION_OWNERSHIP='root:canopy-host 0660 in /run/canopy (root 0755), created by systemd-tmpfiles';
const openFailure=error=>error?.code==='ENOENT'?Error(`Host resource admission lock is missing; expected ${RESOURCE_ADMISSION_OWNERSHIP}`):error?.code==='EACCES'||error?.code==='EPERM'?Error(`Host resource admission lock is not accessible to this service; expected ${RESOURCE_ADMISSION_OWNERSHIP}`):error;
export async function acquireResourceAdmission(path,{timeoutMs=5000,spawnImpl,expectedOwnerUid=0}={}){
 const [{open},{constants},{spawn}]=await Promise.all([import('node:fs/promises'),import('node:fs'),import('node:child_process')]);
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){throw openFailure(error);}const stat=await file.stat();
 if(!stat.isFile()||stat.uid!==expectedOwnerUid||stat.nlink!==1||(stat.mode&0o007)!==0||stat.size!==0){await file.close();throw Error('Unsafe host resource admission lock');}
 const script='flock --exclusive --timeout "$1" 3 || exit 75; printf "ADMITTED\\n"; cat >/dev/null';
 let child;try{child=(spawnImpl??spawn)('bash',['-c',script,'canopy-resource-admission',String(timeoutMs/1000)],{stdio:['pipe','pipe','ignore',file.fd]});}catch{await file.close();throw Error('Host resource admission unavailable');}
 let closed=false;const close=async()=>{if(closed)return;closed=true;child.stdin.end();await file.close();};
 return new Promise((resolve,reject)=>{let output='',admitted=false;const timer=setTimeout(()=>{if(!admitted){child.kill();void close();reject(Error('Host resource admission is busy'));}},timeoutMs+1000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output==='ADMITTED\n'&&!admitted){admitted=true;clearTimeout(timer);resolve(close);}else if(output.length>64){child.kill();void close();reject(Error('Invalid resource admission handshake'));}});
  child.once('error',()=>{clearTimeout(timer);void close();reject(Error('Host resource admission unavailable'));});
  child.once('exit',()=>{clearTimeout(timer);if(!admitted){void close();reject(Error('Host resource admission is busy'));}});
 });
}
export function hostResourceAdmission(path,options){return async action=>{const release=await acquireResourceAdmission(path,options);try{return await action();}finally{await release();}};}

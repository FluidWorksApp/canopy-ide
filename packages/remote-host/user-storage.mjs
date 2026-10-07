// User storage for snapshot-backed managed workspaces.
//
// The workspace lives on the instance boot disk, which is saved as a Lightsail
// instance snapshot on stop. The user's files (Docker named volumes: home,
// projects and accounts) live in one sparse ext4 image on that disk, mounted
// over Docker's volume directory through a loop device. The image size is the
// advertised storage of the plan, so a full image is a hard, simple quota that
// survives snapshot and restore (it is an ordinary file on the root
// filesystem), and growing it for a bigger plan is an online resize2fs.
//
// Why a loop image and not the alternatives (Ubuntu 24.04, ext4 root):
// - ext4 project quota needs the `project`/`quota` features, which can only be
//   enabled on an unmounted filesystem: not possible for the running root.
// - LVM thin volumes need a raw partition or a loop device anyway, and add a
//   second metadata layer to repair after an unclean stop.
// - A loop image is sparse, so only written blocks occupy the boot disk (and
//   the snapshot); discard inside it punches holes in the backing file, which
//   fstrim on / then releases to EBS.
//
// The OS, workspace images, containers and swap stay on the root filesystem in
// the remaining ~20+ GB of the boot disk, outside the user's quota.
import {execFile} from 'node:child_process';
import {mkdir,open,readFile,readdir,rename,rm,stat,statfs,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

export const STORAGE_DIR='/var/lib/canopy-storage';
export const IMAGE_PATH=`${STORAGE_DIR}/user-data.img`;
export const MOUNT_POINT='/srv/canopy/docker/volumes';
export const MIGRATION_MARKER=`${STORAGE_DIR}/migrated.json`;
export const GIB=1024**3;
export const WARNING_RATIO=0.8;
export const CRITICAL_RATIO=0.95;
// Advertised user storage per plan. The control plane sends the size; these
// are the only sizes the host accepts, so a malformed config cannot fill the
// boot disk (boot disk minus ~20 GB for OS, image, swap and headroom).
export const PLAN_STORAGE_GIB=Object.freeze({starter:50,standard:100,power:200,performance:500});
const ALLOWED_GIB=new Set(Object.values(PLAN_STORAGE_GIB));

export function validStorageGib(value){
 const gib=Number(value);
 if(!Number.isSafeInteger(gib)||!ALLOWED_GIB.has(gib))throw Error('Invalid workspace storage size');
 return gib;
}
// 80% and 95% of the advertised size: the UI warns, then asks the user to free
// space before writes start failing at 100%.
export function storageLevel(usedBytes,totalBytes){
 if(!(totalBytes>0)||!(usedBytes>=0))return 'unknown';
 const ratio=usedBytes/totalBytes;
 return ratio>=CRITICAL_RATIO?'critical':ratio>=WARNING_RATIO?'warning':'ok';
}
export async function storageUsage({mountPoint=MOUNT_POINT,statFs=statfs,advertisedGib=null}={}){
 const s=await statFs(mountPoint);
 const totalBytes=Number(s.blocks)*Number(s.bsize),freeBytes=Number(s.bfree)*Number(s.bsize);
 const usedBytes=Math.max(0,totalBytes-freeBytes);
 // ext4 metadata makes the filesystem slightly smaller than the image; the
 // advertised size stays the denominator users were promised.
 const capacityBytes=advertisedGib?advertisedGib*GIB:totalBytes;
 return {usedBytes,totalBytes,capacityBytes,availableBytes:Math.max(0,Number(s.bavail)*Number(s.bsize)),percent:Math.min(100,Math.round(usedBytes/capacityBytes*1000)/10),level:storageLevel(usedBytes,capacityBytes)};
}

export function runner(exec=execFile){
 return (command,args,{timeout=60000}={})=>new Promise(resolve=>{
  exec(command,args,{timeout,maxBuffer:8*1024*1024,encoding:'utf8'},(error,stdout,stderr)=>resolve({code:error?(typeof error.code==='number'?error.code:1):0,stdout:stdout??'',stderr:stderr??'',timedOut:error?.killed===true}));
 });
}
const must=async(run,command,args,options)=>{const result=await run(command,args,options);if(result.code!==0)throw Error(`${command} failed (${result.code})${result.timedOut?' after timeout':''}`);return result;};

export async function attachedLoop(run,image=IMAGE_PATH){
 const out=(await run('losetup',['--noheadings','--output','NAME','--associated',image])).stdout.trim().split('\n').filter(Boolean);
 if(out.length>1)throw Error('User storage is attached more than once');
 return out[0]??null;
}
async function mountedSource(run,mountPoint){
 const result=await run('findmnt',['--noheadings','--output','SOURCE','--mountpoint',mountPoint]);
 return result.code===0?result.stdout.trim()||null:null;
}
// Attach with direct I/O so pages are not cached twice (loop + backing file)
// on the small plans. Discard requests from the filesystem become hole punches
// in the backing file (loop driver behaviour), which fstrim relies on.
export async function mountUserStorage({run=runner(),image=IMAGE_PATH,mountPoint=MOUNT_POINT,fs={mkdir}}={}){
 let device=await attachedLoop(run,image);
 if(!device)device=(await must(run,'losetup',['--find','--show','--direct-io=on','--nooverlap',image])).stdout.trim();
 if(!/^\/dev\/loop\d+$/.test(device))throw Error('Unexpected loop device');
 const current=await mountedSource(run,mountPoint);
 if(current===device)return {device,mounted:false};
 if(current)throw Error('Another filesystem is mounted over user storage');
 // Preen only: fixes what an unclean stop can leave, refuses anything that
 // needs a decision (exit code >= 4) instead of mounting a damaged volume.
 const check=await run('e2fsck',['-p',device],{timeout:15*60000});
 if(check.code>=4)throw Error('User storage needs a filesystem repair; refusing to mount it');
 await fs.mkdir(mountPoint,{recursive:true,mode:0o710});
 // noatime: reading a file must not dirty its inode, or every session would
 // add changed blocks to the next snapshot.
 await must(run,'mount',['-t','ext4','-o','noatime',device,mountPoint]);
 return {device,mounted:true};
}

// Create (sparse) or grow the image to the plan's size, then mount it. A
// shrink is never done here: a smaller plan is refused by the control plane.
export async function ensureUserStorage(gib,{run=runner(),image=IMAGE_PATH,mountPoint=MOUNT_POINT,fs={mkdir,open,stat,readdir,rename,rm}}={}){
 const target=validStorageGib(gib)*GIB;
 await fs.mkdir(dirname(image),{recursive:true,mode:0o700});
 let existing=null;try{existing=await fs.stat(image);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing&&!existing.isFile())throw Error('User storage image is not a regular file');
 let created=false,grown=false;
 if(!existing){
  const handle=await fs.open(image,'wx',0o600);try{await handle.truncate(target);}finally{await handle.close();}
  // -m 0: no root reservation, the user gets the whole advertised size.
  await must(run,'mkfs.ext4',['-q','-F','-m','0','-L','canopy-user',image],{timeout:10*60000});
  created=true;
 }else if(existing.size<target){
  const handle=await fs.open(image,'r+');try{await handle.truncate(target);}finally{await handle.close();}
  grown=true;
 }else if(existing.size>target){
  return {...await mountUserStorage({run,image,mountPoint,fs}),created,grown,shrinkRefused:true};
 }
 // Volumes that already exist on the root filesystem (a fresh host has only
 // Docker's metadata.db) move into the image the first time it is mounted.
 let carried=null;
 if(created){
  const entries=await fs.readdir(mountPoint).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(entries.length&&!(await mountedSource(run,mountPoint))){carried=`${mountPoint}.root-${Date.now()}`;await fs.rename(mountPoint,carried);}
 }
 const mounted=await mountUserStorage({run,image,mountPoint,fs});
 if(grown){
  await must(run,'losetup',['--set-capacity',mounted.device]);
  await must(run,'resize2fs',[mounted.device],{timeout:10*60000});
 }
 if(carried){
  await must(run,'cp',['-a','--sparse=always',`${carried}/.`,`${mountPoint}/`],{timeout:30*60000});
  await fs.rm(carried,{recursive:true,force:true});
 }
 return {...mounted,created,grown,shrinkRefused:false};
}

// One-time move of a legacy retained data disk (mounted read-only at `source`)
// onto the boot disk: Docker volumes into the quota image, everything else
// (containerd and Docker images/containers, host and Caddy state) onto the
// root filesystem. The source is never written; the control plane deletes the
// old disk only after the first verified user snapshot.
export async function migrateLegacyStorage(source,{run=runner(),mountPoint=MOUNT_POINT,root='/srv/canopy',marker=MIGRATION_MARKER,fs={readdir,readFile,writeFile,mkdir,statfs},now=()=>new Date()}={}){
 const uuid=(await must(run,'findmnt',['--noheadings','--output','UUID','--mountpoint',source])).stdout.trim();
 if(!/^[0-9a-f-]{36}$/i.test(uuid))throw Error('Legacy storage is not mounted');
 const options=(await must(run,'findmnt',['--noheadings','--output','OPTIONS','--mountpoint',source])).stdout.trim().split(',');
 if(!options.includes('ro'))throw Error('Legacy storage must be mounted read-only');
 try{const done=JSON.parse(await fs.readFile(marker,'utf8'));if(done.sourceUuid===uuid)return {copied:false,sourceUuid:uuid};}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
 const used=async path=>Number((await must(run,'du',['-sx','--block-size=1',path],{timeout:15*60000})).stdout.split(/\s/)[0]);
 const free=async path=>{const s=await fs.statfs(path);return Number(s.bavail)*Number(s.bsize);};
 const volumes=join(source,'docker','volumes');
 const hasVolumes=(await fs.readdir(join(source,'docker')).catch(()=>[])).includes('volumes');
 const volumeBytes=hasVolumes?await used(volumes):0,totalBytes=await used(source);
 if(volumeBytes>await free(mountPoint))throw Object.assign(Error('Your files do not fit in this package’s storage'),{exitCode:28});
 if(totalBytes-volumeBytes>await free(root))throw Object.assign(Error('The workspace system data does not fit on the boot disk'),{exitCode:28});
 for(const entry of await fs.readdir(source)){
  if(entry==='lost+found')continue;
  if(entry==='docker'){
   for(const child of await fs.readdir(join(source,'docker'))){
    if(child==='volumes')continue;
    await fs.mkdir(join(root,'docker'),{recursive:true});
    await must(run,'cp',['-a','--sparse=always',join(source,'docker',child),join(root,'docker')+'/'],{timeout:60*60000});
   }
   continue;
  }
  await must(run,'cp',['-a','--sparse=always',join(source,entry),root+'/'],{timeout:60*60000});
 }
 if(hasVolumes)await must(run,'cp',['-a','--sparse=always',`${volumes}/.`,`${mountPoint}/`],{timeout:60*60000});
 await must(run,'sync',[]);
 await fs.writeFile(marker,JSON.stringify({version:1,sourceUuid:uuid,volumeBytes,totalBytes,migratedAt:now().toISOString()}),{mode:0o600});
 return {copied:true,sourceUuid:uuid,volumeBytes,totalBytes};
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 const [command,arg]=process.argv.slice(2);
 try{
  const result=command==='ensure'?await ensureUserStorage(arg):command==='mount'?await mountUserStorage():command==='migrate'?await migrateLegacyStorage(arg):command==='usage'?await storageUsage():null;
  if(!result)throw Error('Usage: user-storage.mjs ensure <gib> | mount | migrate <legacy-mount> | usage');
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch(error){process.stderr.write(`${error.message}\n`);process.exit(error.exitCode??1);}
}

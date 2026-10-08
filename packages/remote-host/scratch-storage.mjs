import {mkdir,lstat,realpath,readdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validId} from './policy.mjs';

// VM-root storage, outside the retained /srv/canopy data disk. systemd owns
// creation of this root; the gateway only creates private runtime children.
export const SCRATCH_ROOT='/var/lib/canopy-scratch';
export function scratchVolume(workspace,root){
 if(!path.isAbsolute(root)||root!==path.resolve(root)||root==='/'||['\0',',','\n','\r'].some(character=>root.includes(character)))throw Error('Invalid scratch root');
 const owner=workspace.parentWorkspaceId??workspace.id,storage=workspace.storageId??workspace.id;
 if(!validId(owner)||!validId(storage))throw Error('Invalid scratch owner');
 const key=createHash('sha256').update(JSON.stringify([owner,storage])).digest('hex').slice(0,40);
 return {name:`canopy-scratch-${key}`,source:path.join(root,key),owner,storage};
}
export async function prepareScratchVolume(workspace,{root,docker,image}){
 const volume=scratchVolume(workspace,root);
 if(root===SCRATCH_ROOT&&(await stat(root)).dev!==(await stat('/')).dev)throw Error('Scratch root must be on the VM root filesystem');
 if(await realpath(root)!==root||(await lstat(root)).isSymbolicLink())throw Error('Scratch root must be a real directory');
 await mkdir(volume.source,{recursive:true,mode:0o700});
 if(!(await lstat(volume.source)).isDirectory()||await realpath(volume.source)!==volume.source)throw Error('Invalid scratch directory');
 let current;
 try{current=JSON.parse((await docker(['volume','inspect',volume.name])).stdout)[0];}
 catch(error){if(!error.missingResource&&!/no such volume/i.test(String(error.stderr)))throw error;}
 if(!current){
  await docker(['volume','create','--driver','local','--label',`canopy.scratch-owner=${volume.owner}`,
   '--label',`canopy.scratch-storage=${volume.storage}`,'--opt','type=none','--opt','o=bind','--opt',`device=${volume.source}`,volume.name]);
  current=JSON.parse((await docker(['volume','inspect',volume.name])).stdout)[0];
 }
 if(current?.Name!==volume.name||current.Driver!=='local'||
    current.Labels?.['canopy.scratch-owner']!==volume.owner||current.Labels?.['canopy.scratch-storage']!==volume.storage||
    JSON.stringify(Object.entries(current.Options??{}).sort())!==JSON.stringify(Object.entries({type:'none',o:'bind',device:volume.source}).sort()))throw Error('Scratch volume ownership differs');
 // Only chown the mount root, never user contents or symlink targets. Unlike a
 // normal Docker volume, the newly-created bind directory belongs to the host
 // service, so the tightly scoped helper also needs DAC_OVERRIDE to reach it.
 await docker(['run','--rm','--network','none','--read-only','--user','0:0','--cap-drop','ALL',
  '--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges:true',
  '--memory','64m','--memory-swap','64m','--cpus','0.25','--pids-limit','16',
  '--mount',`type=volume,source=${volume.name},target=/scratch,volume-nocopy`,
  '--entrypoint','/usr/bin/chown',image,'--no-dereference','1000:1000','/scratch']);
 return volume;
}

// Snapshot-backed hosts save the entire VM disk. Clear scratch only after the
// containers were quiesced, so temporary work does not inflate snapshot cost.
export async function clearScratch(root=SCRATCH_ROOT){
 try{
  if(await realpath(root)!==root||!(await lstat(root)).isDirectory())throw Error('Invalid scratch cleanup root');
 }catch(error){if(error.code==='ENOENT')return;throw error;}
 for(const entry of await readdir(root)){
  if(/^[a-f0-9]{40}$/.test(entry))await rm(path.join(root,entry),{recursive:true,force:true});
 }
}

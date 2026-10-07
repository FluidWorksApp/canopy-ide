import {statfs as fsStatfs,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {validId} from './policy.mjs';
// Workspace images are ~3.7 GB compressed and ~12.8 GB unpacked, and the
// containerd image store keeps both on the retained disk (50 GB, 100 GB for newer workspaces) that also holds
// the user's volumes. Every release was previously kept forever until a pull
// failed with ENOSPC. Retention keeps only what a container uses (running, the
// stopped workspace, or a rollback container while an upgrade is unconfirmed),
// the configured release and one pre-pulled target. Volumes are never touched.
const GiB=1024**3;
export const WORKSPACE_IMAGE_FALLBACK_BYTES=16*GiB;
// Manifests carry compressed layer sizes only. Measured 3.68 GB -> 12.8 GB.
export const WORKSPACE_IMAGE_UNPACK_RATIO=3.5;
export const WORKSPACE_IMAGE_PULL_HEADROOM_BYTES=1*GiB;
// A background pre-pull must leave this much free for the user's own files.
export const PREPULL_RESERVE_BYTES=4*GiB;
export const CONTAINERD_ROOTS=Object.freeze(['/srv/canopy/containerd','/var/lib/containerd','/var/lib/docker']);
export const DISK_FULL_EXIT_CODE=28; // ENOSPC
const gb=bytes=>(Math.max(0,bytes)/1e9).toFixed(1);
export class WorkspaceDiskFullError extends Error{
 constructor(freeBytes,neededBytes){
  super(`Workspace disk is full: ${gb(freeBytes)} GB free, ${gb(neededBytes)} GB needed`);
  this.name='WorkspaceDiskFullError';this.code='WORKSPACE_DISK_FULL';this.reason='disk-full';
  this.freeBytes=freeBytes;this.neededBytes=neededBytes;
  this.freeGB=gb(freeBytes);this.neededGB=gb(neededBytes);
 }
}
export const isWorkspaceRepository=value=>typeof value==='string'&&/(?:^|\/)canopy-workspace$/.test(value);
export const noSpaceError=error=>error?.noSpace===true||/no space left on device/i.test(String(error?.stderr??''));
const lines=output=>String(output??'').split('\n').map(line=>line.trim()).filter(Boolean);
const parseJson=(output,fallback)=>{try{return JSON.parse(String(output??''));}catch{return fallback;}};

/** Free bytes on the disk holding the containerd image store, or null when unknown. */
export async function containerdFreeBytes({roots=[process.env.CANOPY_CONTAINERD_ROOT,...CONTAINERD_ROOTS].filter(Boolean),statfs=fsStatfs}={}){
 for(const root of roots){
  try{const info=await statfs(root);const free=Number(info.bavail)*Number(info.bsize);if(Number.isFinite(free)&&free>=0)return free;}catch{}
 }
 return null;
}

/** Bytes a pull of `reference` needs: compressed blobs plus unpacked snapshots. */
export async function requiredPullBytes(reference,{docker,arch=process.arch}={}){
 try{
  const output=parseJson((await docker(['manifest','inspect','--verbose',reference]))?.stdout,null);
  const entries=Array.isArray(output)?output:output?[output]:[];
  const platform=arch==='x64'?'amd64':arch;
  const entry=entries.length===1?entries[0]:entries.find(e=>e?.Descriptor?.platform?.os==='linux'&&e.Descriptor.platform.architecture===platform);
  const manifest=entry?.OCIManifest??entry?.SchemaV2Manifest;
  if(!Array.isArray(manifest?.layers)||!manifest.layers.length)throw Error('No layers');
  let compressed=Number.isSafeInteger(manifest.config?.size)?manifest.config.size:0;
  for(const layer of manifest.layers){if(!Number.isSafeInteger(layer?.size)||layer.size<0)throw Error('Invalid layer');compressed+=layer.size;}
  if(compressed<=0)throw Error('Empty image');
  return {bytes:Math.ceil(compressed*(1+WORKSPACE_IMAGE_UNPACK_RATIO))+WORKSPACE_IMAGE_PULL_HEADROOM_BYTES,source:'manifest'};
 }catch{return {bytes:WORKSPACE_IMAGE_FALLBACK_BYTES,source:'fallback'};}
}

/**
 * Before a pull: if free space is short, first remove what nothing uses; if it
 * is still short, fail with a specific message instead of a mid-pull ENOSPC.
 * Unknown free space (no readable containerd root) skips the check.
 */
export async function ensurePullSpace(reference,{docker,freeBytes=containerdFreeBytes,cleanup,reserveBytes=0,neededBytes}={}){
 let free=await freeBytes();
 if(free==null)return {checked:false};
 const needed=(neededBytes??(await requiredPullBytes(reference,{docker})).bytes)+reserveBytes;
 if(free>=needed)return {checked:true,free,needed};
 if(typeof cleanup==='function'){await cleanup();free=await freeBytes()??free;}
 if(free>=needed)return {checked:true,free,needed,cleaned:true};
 throw new WorkspaceDiskFullError(free,needed);
}

/**
 * Workspaces with an unfinished image upgrade journal keep their rollback
 * containers. Returns null when the journal cannot be read: protect everything.
 */
export async function pendingImageUpgrades(directory){
 const pending=new Set();
 let files;try{files=await readdir(directory);}catch(error){if(error.code==='ENOENT')return pending;return null;}
 try{
  for(const filename of files.filter(name=>name.endsWith('.json'))){
   const id=filename.slice(0,-5);if(!validId(id))return null;
   const file=await open(path.join(directory,filename),constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const record=JSON.parse(await file.readFile('utf8'));if(record?.workspaceId!==id)return null;if(!['committed','rolled-back'].includes(record.phase))pending.add(id);}
   finally{await file.close();}
  }
 }catch{return null;}
 return pending;
}

async function inspectContainers(docker){
 const ids=lines((await docker(['ps','--all','--quiet','--no-trunc']))?.stdout).filter(id=>/^[a-f0-9]{64}$/.test(id));
 if(!ids.length)return [];
 const inspected=parseJson((await docker(['inspect',...ids]))?.stdout,null);
 if(!Array.isArray(inspected))throw Error('Container inventory could not be read');
 return inspected.map(c=>({id:c?.Id,name:String(c?.Name??'').replace(/^\//,''),imageId:c?.Image,running:c?.State?.Running!==false||c?.State?.Restarting===true||c?.State?.Paused===true,workspace:c?.Config?.Labels?.['canopy.workspace']}));
}
/** An exited rollback container whose upgrade is settled, never one still needed. */
function staleRollback(container,containers,protect){
 const id=container.workspace,prefix='canopy-previous-'+id+'-';
 if(container.running||!validId(id)||!container.name.startsWith(prefix)||!/^[a-f0-9]{12}(?:-failed|-recovery-[a-f0-9]{12})?$/.test(container.name.slice(prefix.length)))return false;
 if(protect===null||protect.has(id))return false;
 // The canonical workspace must exist, so this can never be the only copy.
 return containers.some(c=>c.name==='canopy-ws-'+id&&c.workspace===id);
}
async function imageId(docker,reference){
 try{const [image]=parseJson((await docker(['image','inspect',reference]))?.stdout,[]);return /^sha256:[a-f0-9]{64}$/.test(image?.Id??'')?image.Id:null;}
 catch{return null;}
}

/**
 * Remove every canopy-workspace image no container uses and that is not in
 * `keep`, settled rollback containers, and dangling images. Never removes a
 * volume, never forces, never prunes beyond dangling images.
 */
export async function removeStaleWorkspaceImages({docker,keep=[],protectWorkspaces=new Set(),removeContainers=true,log=()=>{}}){
 const removed={containers:[],images:[],failed:[]};
 let containers=await inspectContainers(docker);
 if(removeContainers){
  for(const container of containers.filter(c=>staleRollback(c,containers,protectWorkspaces))){
   try{await docker(['rm',container.name]);removed.containers.push(container.name);}
   catch(error){removed.failed.push(container.name);log(`Could not remove ${container.name}: ${error.message}`);}
  }
  containers=containers.filter(c=>!removed.containers.includes(c.name));
 }
 const kept=new Set(containers.map(c=>c.imageId).filter(Boolean));
 for(const reference of new Set(keep.filter(Boolean))){const id=await imageId(docker,reference);if(id)kept.add(id);}
 const images=new Map();
 for(const line of lines((await docker(['image','ls','--no-trunc','--digests','--format','{{json .}}']))?.stdout)){
  const row=parseJson(line,null);
  if(!row||!isWorkspaceRepository(row.Repository)||!/^sha256:[a-f0-9]{64}$/.test(row.ID??''))continue;
  const refs=images.get(row.ID)??new Set();
  if(row.Tag&&row.Tag!=='<none>')refs.add(`${row.Repository}:${row.Tag}`);
  else if(/^sha256:[a-f0-9]{64}$/.test(row.Digest??''))refs.add(`${row.Repository}@${row.Digest}`);
  images.set(row.ID,refs);
 }
 for(const [id,refs] of images){
  if(kept.has(id))continue;
  // Untag by reference, never `rmi --force`: Docker itself refuses to delete
  // an image a container still uses.
  for(const ref of refs){
   try{await docker(['image','rm',ref]);}
   catch(error){removed.failed.push(ref);log(`Could not remove ${ref}: ${error.message}`);continue;}
  }
  removed.images.push(id);
 }
 // Dangling images only (no --all, no volumes, no system prune).
 try{await docker(['image','prune','--force']);}catch(error){log(`Dangling image prune failed: ${error.message}`);}
 return removed;
}

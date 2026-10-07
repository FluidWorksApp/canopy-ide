import {ensurePullSpace,noSpaceError,WorkspaceDiskFullError,WORKSPACE_IMAGE_FALLBACK_BYTES,containerdFreeBytes,removeStaleWorkspaceImages,pendingImageUpgrades,DISK_FULL_EXIT_CODE} from './image-retention.mjs';
// Only trusted host configuration selects registries and releases.
// Measured 2026-10-07 on a Lightsail 2xlarge in ap-southeast-1: a cold pull of
// the 3.68 GB (12.8 GB unpacked) workspace image from GHCR took ~6.5 minutes,
// so the old 5-minute limit killed every first pull of a new image. The control
// plane allows 15 minutes per startup phase (canopy-website
// startup-deadline.mjs); the pull gets 12 of them. --quiet keeps the output to
// the digest, far below exec's 1 MB buffer cap.
export const WORKSPACE_IMAGE_PULL_TIMEOUT_MS=12*60*1000;
export const dockerTimeout=args=>args[0]==='pull'?WORKSPACE_IMAGE_PULL_TIMEOUT_MS:args[0]==='manifest'?30_000:120_000;
export function workspaceImageReference(value){
 if(typeof value!=='string'||value.length>512||!/^([a-z0-9]+(?:[.-][a-z0-9]+)+(?:\:[0-9]{1,5})?)\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?:@sha256:[a-f0-9]{64}|:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})$/.test(value))throw Error('Configure a registry workspace image with an explicit release tag or SHA256 digest');
 return value;
}
function verifiedImage(requested,output){
 const images=JSON.parse(output);
 if(!Array.isArray(images)||images.length!==1||!/^sha256:[a-f0-9]{64}$/.test(images[0]?.Id??''))throw Error('Pulled image identity could not be verified');
 const repository=requested.split('@')[0].replace(/:[^/:]+$/,'');
 const digests=images[0].RepoDigests;
 const digest=Array.isArray(digests)?requested.includes('@')?digests.find(value=>value===requested):digests.find(value=>typeof value==='string'&&value.startsWith(repository+'@sha256:')):null;
 if(!digest||workspaceImageReference(digest)!==digest)throw Error('Pulled image release digest could not be verified');
 return {reference:digest,imageId:images[0].Id};
}
function missingImage(error){
 // docker.mjs deliberately sanitizes stderr and preserves only this trusted
 // classification. Direct CLI callers retain the daemon's missing-image line.
 return error?.missingResource===true||/^Error(?: response from daemon)?: No such (?:image|object):/mi.test(String(error?.stderr??''));
}
// A containerd restart under a running dockerd (package maintenance on a fresh
// host, canopy-ws-...-17 on 2026-10-07) breaks the pull's in-flight content
// write: "failed to copy: failed to send write: EOF". Only this connection loss
// is retried, once, and only after containerd and Docker are active again.
export function containerdConnectionLost(error){
 return /failed to (?:send|copy|write|receive)[^\n]*\bEOF\b|error reading from server: EOF|transport is closing|containerd\.sock[^\n]*(?:connection refused|no such file)/i.test(`${error?.stderr??''}\n${error?.message??''}`);
}
// `space` ({freeBytes,cleanup,reserveBytes}) enables the free-space preflight:
// a pull that cannot fit fails with WorkspaceDiskFullError before it starts,
// and a mid-pull ENOSPC is reported the same way, never as a generic failure.
// `retry` ({runtimeReady,log}) enables the single containerd-loss retry.
export async function pullWorkspaceImage(reference,{docker,space,retry}){
 const requested=workspaceImageReference(reference);
 if(requested.includes('@')){
  let cached,missing=false;
  try{cached=await docker(['image','inspect',requested]);}
  catch(error){if(!missingImage(error))throw error;missing=true;}
  // A known immutable release is already on the retained disk. Verify its
  // identity before reuse; malformed/mismatched metadata is never a cache miss.
  if(!missing)return verifiedImage(requested,cached?.stdout);
 }
 // Mutable channels must contact the registry on every explicit resume.
 let preflight;
 if(space)preflight=await ensurePullSpace(requested,{docker,...space});
 const pull=()=>docker(['pull','--quiet',requested]);
 try{
  try{await pull();}
  catch(error){
   if(!retry||!containerdConnectionLost(error)||!await retry.runtimeReady())throw error;
   retry.log?.('Workspace image pull lost its containerd connection; retrying once');
   await pull();
  }
 }
 catch(error){
  if(!space||!noSpaceError(error))throw error;
  try{await space.cleanup?.();}catch{}
  const free=await (space.freeBytes??containerdFreeBytes)();
  throw new WorkspaceDiskFullError(free??0,preflight?.needed??WORKSPACE_IMAGE_FALLBACK_BYTES);
 }
 return verifiedImage(requested,(await docker(['image','inspect',requested])).stdout);
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile}=await import('node:fs/promises');
 const exec=promisify(execFile);
 const docker=args=>exec('docker',args,{timeout:dockerTimeout(args),maxBuffer:1024*1024});
 const requested=workspaceImageReference(process.argv[2]);
 // Host bootstrap runs before management services, so nothing else is using
 // Docker. Rollback containers of an unfinished upgrade journal are kept.
 const protectWorkspaces=await pendingImageUpgrades(process.env.CANOPY_IMAGE_UPGRADES??'/srv/canopy/host-state/image-upgrades');
 const log=message=>console.error(message);
 const cleanup=()=>removeStaleWorkspaceImages({docker,keep:[requested],protectWorkspaces,log});
 let release;
 // Wait (bounded) until both runtimes are active before the single retry.
 const active=async unit=>{try{await exec('systemctl',['is-active','--quiet',unit],{timeout:5000});return true;}catch{return false;}};
 const runtimeReady=async()=>{for(let attempt=0;attempt<30;attempt++){if(await active('containerd.service')&&await active('docker.service'))return true;await new Promise(resolve=>setTimeout(resolve,2000));}return false;};
 try{release=await pullWorkspaceImage(requested,{docker,space:{cleanup},retry:{runtimeReady,log}});}
 catch(error){
  if(!(error instanceof WorkspaceDiskFullError))throw error;
  console.error(error.message);
  // Coded detail for the bootstrap report; numbers only, no daemon output.
  if(process.env.CANOPY_IMAGE_FAILURE_FILE)await writeFile(process.env.CANOPY_IMAGE_FAILURE_FILE,`disk-full ${error.freeGB} ${error.neededGB}\n`,{mode:0o600}).catch(()=>{});
  process.exit(DISK_FULL_EXIT_CODE);
 }
 // Keep only the release and what containers use; never fail startup on this.
 try{const removed=await cleanup();if(removed.images.length||removed.containers.length)console.error(`Removed ${removed.images.length} old workspace image(s) and ${removed.containers.length} rollback container(s)`);}
 catch(error){console.error(`Workspace image cleanup skipped: ${error.message}`);}
 process.stdout.write(release.reference+'\n');
}

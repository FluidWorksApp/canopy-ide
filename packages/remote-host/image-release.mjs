// Only trusted host configuration selects registries and releases.
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
export async function pullWorkspaceImage(reference,{docker}){
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
 await docker(['pull',requested]);
 return verifiedImage(requested,(await docker(['image','inspect',requested])).stdout);
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const exec=promisify(execFile);
 const release=await pullWorkspaceImage(process.argv[2],{docker:args=>exec('docker',args,{timeout:300000,maxBuffer:1024*1024})});
 process.stdout.write(release.reference+'\n');
}

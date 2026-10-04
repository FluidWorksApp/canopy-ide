// Only trusted host configuration selects registries and releases.
export function workspaceImageReference(value){
 if(typeof value!=='string'||value.length>512||!/^([a-z0-9]+(?:[.-][a-z0-9]+)+(?:\:[0-9]{1,5})?)\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?:@sha256:[a-f0-9]{64}|:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})$/.test(value))throw Error('Configure a registry workspace image with an explicit release tag or SHA256 digest');
 return value;
}
export async function pullWorkspaceImage(reference,{docker}){
 const requested=workspaceImageReference(reference);
 await docker(['pull',requested]);
 const images=JSON.parse((await docker(['image','inspect',requested])).stdout);
 if(images.length!==1||!/^sha256:[a-f0-9]{64}$/.test(images[0]?.Id??''))throw Error('Pulled image identity could not be verified');
 const repository=requested.split('@')[0].replace(/:[^/:]+$/,'');
 const digest=images[0].RepoDigests?.find(value=>value.startsWith(repository+'@sha256:'));
 if(!digest||workspaceImageReference(digest)!==digest||(requested.includes('@')&&digest!==requested))throw Error('Pulled image release digest could not be verified');
 return {reference:digest,imageId:images[0].Id};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const exec=promisify(execFile);
 const release=await pullWorkspaceImage(process.argv[2],{docker:args=>exec('docker',args,{timeout:300000,maxBuffer:1024*1024})});
 process.stdout.write(release.reference+'\n');
}

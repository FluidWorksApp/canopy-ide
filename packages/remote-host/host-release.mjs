import {readFile} from 'node:fs/promises';
import {HOST_PROTOCOL} from './native-commands.mjs';
// What this management host runs, for the control plane (runtime-policy `host`).
// The release manifest ships inside the archive, so it cannot carry the
// archive's own hash: whoever installs the archive (bootstrap, update-host)
// writes that hash beside it as HOST_RUNTIME_SHA256_FILE. readHostRelease's
// `protocol` is this gateway tree's HOST_PROTOCOL; the report sent to the
// control plane (hostReport) carries the owner container's instead, because
// native commands are answered by the runner in that container, which
// changes with its image, not with this tree.
export const HOST_RELEASE_FILE='workspace-release.json';
export const HOST_RUNTIME_SHA256_FILE='workspace-runtime.sha256';
export async function readHostRelease({directory=new URL('./',import.meta.url),read=readFile}={}){
 const text=async name=>{try{const value=await read(new URL(name,directory),'utf8');return value.length>65536?null:value;}catch{return null;}};
 let revision=null;try{const manifest=JSON.parse(await text(HOST_RELEASE_FILE)??'null');if(/^[a-f0-9]{40}$/.test(manifest?.revision??''))revision=manifest.revision;}catch{/* A tree without a valid manifest reports no revision. */}
 const sha=(await text(HOST_RUNTIME_SHA256_FILE))?.trim();
 return {revision,protocol:HOST_PROTOCOL,runtimeSha256:/^[a-f0-9]{64}$/.test(sha??'')?sha:null};
}
// The installed tree only changes through an install that restarts this process.
let installed;
export const installedHostRelease=()=>installed??=readHostRelease();
/** runtime-policy `host`: {revision, runtimeSha256} of this gateway tree,
 * {protocol, image} of the owner's running container (null when unknown). */
export async function hostReport({release=installedHostRelease,owner=async()=>({image:null,protocol:null})}={}){
 const [gateway,container]=await Promise.all([release(),owner().catch(()=>({image:null,protocol:null}))]);
 return {revision:gateway.revision,protocol:container?.protocol??null,runtimeSha256:gateway.runtimeSha256,image:container?.image??null};
}

// Agent scratch files: the one kind of file outside the workspace folder the
// IDE may read.
//
// An agent writes its working notes and intermediate output where its CLI
// gives it a scratchpad (a per-session folder under the temp directory), and
// Canopy keeps session files under ~/.canopy. The agent card lists those as
// Assets; opening or previewing one is a read of a path that is not under the
// workspace root, which every file command here refuses. The desktop has the
// same split and the same answer (fsx.rs `preview_allowed_roots`): a short,
// fixed list of scratch folders, read-only, credentials refused wherever they
// sit. Nothing is ever written through this.
import {realpath,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Files that hold credentials wherever they live (fsx.rs `credential_file_name`). */
export function credentialFileName(name){
 const lower=String(name).toLowerCase();
 return ['.netrc','.npmrc','.pypirc','.pgpass','.git-credentials','.bash_history','.zsh_history','.zshrc','.bashrc','.profile','.zprofile','credentials','credentials.json','auth.json','secrets.json'].includes(lower)
  ||/^id_(rsa|ed25519|ecdsa|dsa)/.test(lower)||/\.(pem|key|p12|pfx|kdbx)$/.test(lower);
}

/** The scratch folders, resolved; one that does not exist is left out. */
export async function scratchRoots(home,{tmp=os.tmpdir(),extra=['/tmp','/var/tmp']}={}){
 const wanted=[...(home?[path.join(home,'.canopy','sessions'),path.join(home,'.canopy','spot')]:[]),tmp,...extra];
 const roots=[];
 for(const root of wanted){try{const real=await realpath(root);if(!roots.includes(real))roots.push(real);}catch{}}
 return roots;
}

/** The real path of a scratch file, or a refusal worded like the workspace
 *  scope's own ("outside") so callers treat the two alike. */
export async function scratchFile(value,home,options){
 if(typeof value!=='string'||value.includes('\0')||!path.isAbsolute(value))throw Error('Path outside selected workspace');
 let real;
 try{real=await realpath(value);}catch(error){if(error.code==='ENOENT')throw error;throw Error('Path outside selected workspace');}
 const roots=await scratchRoots(home,options);
 if(!roots.some(root=>real.startsWith(root+path.sep)))throw Error('Path outside selected workspace');
 if(!(await stat(real)).isFile())throw Error('Path outside selected workspace');
 if(credentialFileName(path.basename(real)))throw Error('That file holds credentials and is never opened from outside the workspace');
 return real;
}

// A shared-account session runs with its own HOME (runner.mjs: a copy of the
// account's template under ~/.canopy/accounts/<id>), so its credentials stay
// apart. The Canopy hook writes everything under $HOME/.canopy, though, and
// the host reads hook output from /home/agent/.canopy: the event bus turns and
// agent awareness follow, session digests and edit journals provenance and the
// changes panel read, and the Rules policy and research bindings the hook
// itself reads. Those paths are linked back to the workspace's own, so a
// shared-account agent is seen — and gated — like any other. What belongs to
// the account (its plan usage, its CLI config) stays in its own home.
import {mkdir,readdir,rm,symlink,lstat} from 'node:fs/promises';
import path from 'node:path';

export const ACCOUNT_HOMES='accounts';
const SHARED_DIRS=['sessions','policy','research','workflow-runs'];
const SHARED_FILES=['agent-events.jsonl','context-scopes.json'];

export async function linkSharedCanopyState(accountHome,home='/home/agent'){
 const own=path.join(home,'.canopy'),mine=path.join(accountHome,'.canopy');
 await mkdir(mine,{recursive:true,mode:0o700});
 for(const name of [...SHARED_DIRS,...SHARED_FILES]){
  const target=path.join(own,name),link=path.join(mine,name);
  if(SHARED_DIRS.includes(name))await mkdir(target,{recursive:true,mode:0o700});
  // A template that carried its own copy loses it to the shared one.
  try{await lstat(link);await rm(link,{recursive:true,force:true});}catch{}
  await symlink(target,link);
 }
}

/** Every shared-account session home on this workspace (for transcript search). */
export async function accountHomes(home='/home/agent'){
 const dir=path.join(home,'.canopy',ACCOUNT_HOMES);
 try{return (await readdir(dir,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>path.join(dir,e.name));}catch{return [];}
}

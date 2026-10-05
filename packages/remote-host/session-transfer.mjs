import {mkdir,readFile,copyFile,constants,lstat,realpath,link,unlink,stat,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkspaceProfiles} from './profiles.mjs';
import {sessionDigestReader} from './session-digests.mjs';

// Copies only the selected conversation, never auth/config files or a whole
// account home. The original remains available under its original account.
export async function prepareSession(home,{agent,sessionId,sourceProfile,targetProfile}){
 if(!['claude','codex'].includes(agent))throw Error('This agent does not support conversation transfer');
 const profiles=new WorkspaceProfiles(home);
 const source=await profiles.root(sourceProfile),target=await profiles.root(targetProfile);
 const rows=await sessionDigestReader(home,{includePaths:true,target:{agent,sessionId,profile:sourceProfile}})();
 const row=rows.find(r=>r.agent===agent&&r.session_id===sessionId&&r.profile===sourceProfile);
 if(!row?.resumable||!row.transcript_path)throw Error('Saved conversation not found in the source account');
 if(source===target)return {sessionId,profile:targetProfile,cwd:row.resume_cwd};
 const relative=path.relative(source,row.transcript_path);
 const store=agent==='claude'?'.claude/projects/':'.codex/sessions/';
 if(!relative.startsWith(store)||relative.split(path.sep).includes('..'))throw Error('Conversation is outside the account session store');
 const destination=path.join(target,relative);
 // Validate every parent, including preexisting paths, before writing.
 let current=target;
 for(const part of path.dirname(relative).split(path.sep)){
  current=path.join(current,part);await mkdir(current,{recursive:true,mode:0o700});
  if(await realpath(current)!==current)throw Error('Conversation directory must not be a symlink');
 }
 const before=await stat(row.transcript_path);
 if(before.size>128*1024*1024)throw Error('Conversation is too large to transfer safely');
 const staging=destination+'.'+randomUUID()+'.transfer';
 try{
  await copyFile(row.transcript_path,staging,constants.COPYFILE_EXCL);
  const after=await stat(row.transcript_path);
  if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)
   throw Error('Conversation is still changing; stop the agent before switching accounts');
  // Publish atomically and exclusively: readers never see a partial transcript.
  try{await link(staging,destination);}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   const info=await lstat(destination);
   if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024*1024)throw Error('Conversation destination is not a regular supported file');
   const [copied,existing]=await Promise.all([readFile(staging),readFile(destination)]);
   if(!copied.equals(existing)){
    // A return to a previously used account should bring its older transcript
    // forward. Divergent branches are never overwritten.
    if(!existing.length||existing.at(-1)!==10||!copied.subarray(0,existing.length).equals(existing))
     throw Error('This account already has a different version of this conversation; it was preserved');
    const latest=await lstat(destination);
    if(latest.ino!==info.ino||latest.size!==info.size||latest.mtimeMs!==info.mtimeMs)
     throw Error('Target conversation is still changing; it was preserved');
    await rename(staging,destination);
   }
  }
 }finally{await unlink(staging).catch(error=>{if(error.code!=='ENOENT')throw error;});}

 return {sessionId,profile:targetProfile,cwd:row.resume_cwd};
}

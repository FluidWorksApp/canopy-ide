import {mkdir,lstat,readFile,writeFile,rename,unlink,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// A Claude conversation in or out of this workspace for a teleport. The
// conversation lives in the CLI's store under HOME, outside the workspace
// roots the file commands are scoped to, so these commands do only this:
// read or write one session's transcript at the path Claude itself would use.
const MAX_BYTES=64*1024*1024;
const SESSION_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function transcriptPath(home,cwd,sessionId){
 if(typeof cwd!=='string'||!cwd.startsWith('/')||/[\u0000-\u001f]/.test(cwd))throw Error('cwd must be an absolute path');
 if(typeof sessionId!=='string'||!SESSION_ID.test(sessionId))throw Error('not a safe session id');
 return path.join(home,'.claude','projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),`${sessionId}.jsonl`);
}

export function teleportTranscript(home){
 return {
  home:()=>home,
  async read({cwd,sessionId}){
   const file=transcriptPath(home,cwd,sessionId);
   let info;
   try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
   if(!info.isFile()||info.size>MAX_BYTES)throw Error('the conversation is not a regular file within the size limit');
   return readFile(file,'utf8');
  },
  async write({cwd,sessionId,text}){
   if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw Error('the conversation is too large to move');
   const file=transcriptPath(home,cwd,sessionId);
   try{
    const existing=await readFile(file,'utf8');
    if(existing===text)return file;
    throw Error('this machine already has a different version of this conversation; it was kept');
   }catch(e){if(e.code!=='ENOENT')throw e;}
   await mkdir(path.dirname(file),{recursive:true,mode:0o700});
   const staging=`${file}.${process.pid}.teleport`;
   await writeFile(staging,text,{mode:0o600});
   try{await rename(staging,file);}catch(e){await unlink(staging).catch(()=>{});throw e;}
   return file;
  },
 };
}

// Commits and uncommitted changes to a repository that already exists here (the
// same five commands as src-tauri/src/teleport.rs, same rules): git's own bundle
// and patch formats, a git top-level only, hex commit ids only, fast-forward only
// and never onto a dirty tree.
const MAX_GIT_BYTES=48*1024*1024;
const isSha=v=>typeof v==='string'&&/^[0-9a-fA-F]{7,64}$/.test(v);
let counter=0;
const tempFile=kind=>path.join(os.tmpdir(),`canopy-teleport-${process.pid}-${counter++}.${kind}`);
const run=(cwd,args)=>new Promise(resolve=>execFile('git',['-C',cwd,...args],{encoding:'buffer',maxBuffer:MAX_GIT_BYTES*2},(error,stdout,stderr)=>resolve({ok:!error,stdout,stderr:String(stderr||'').trim()})));
const gitOk=async(cwd,args)=>{const r=await run(cwd,args);if(!r.ok)throw Error(r.stderr||'git failed');return String(r.stdout).trim();};
async function topLevel(p){
 if(typeof p!=='string'||!p.startsWith('/')||/[\u0000-\u001f]/.test(p))throw Error('path must be absolute');
 const given=await realpath(p);
 const top=await realpath(await gitOk(given,['rev-parse','--show-toplevel']));
 if(top!==given)throw Error('path is not the top of a git working tree');
 return given;
}
const hasCommit=async(top,sha)=>(await run(top,['cat-file','-e',`${sha}^{commit}`])).ok;
const isAncestor=async(top,a,b)=>(await run(top,['merge-base','--is-ancestor',a,b])).ok;

export function teleportGit(){
 return {
  async relation({path:p,other}){
   if(!isSha(other))throw Error('not a commit id');
   const top=await topLevel(p),head=await gitOk(top,['rev-parse','HEAD']);
   if(!await hasCommit(top,other))return 'unknown';
   const full=await gitOk(top,['rev-parse',`${other}^{commit}`]);
   if(full===head)return 'same';
   if(await isAncestor(top,full,head))return 'behind';
   if(await isAncestor(top,head,full))return 'ahead';
   return 'diverged';
  },
  async bundleCreate({path:p,since}){
   if(!isSha(since))throw Error('not a commit id');
   const top=await topLevel(p);
   if(!await hasCommit(top,since)||!await isAncestor(top,since,'HEAD'))throw Error("the destination's commit is not part of this history");
   const file=tempFile('bundle');
   try{
    await gitOk(top,['bundle','create',file,'HEAD',`^${since}`]);
    const bytes=await readFile(file);
    if(bytes.length>MAX_GIT_BYTES)throw Error('the commits are too large to move this way');
    return bytes.toString('base64');
   }finally{await unlink(file).catch(()=>{});}
  },
  async bundleApply({path:p,data}){
   const top=await topLevel(p);
   if(await gitOk(top,['status','--porcelain']))throw Error('the destination has uncommitted changes; nothing was applied');
   if(typeof data!=='string')throw Error('the commits were damaged in transit');
   const bytes=Buffer.from(data,'base64');
   if(bytes.length>MAX_GIT_BYTES)throw Error('the commits are too large to move this way');
   const file=tempFile('bundle');
   await writeFile(file,bytes,{mode:0o600});
   try{
    await gitOk(top,['bundle','verify',file]).catch(e=>{throw Error(`the commits do not fit this repository: ${e.message}`);});
    await gitOk(top,['fetch','--no-tags',file,'+HEAD:refs/canopy/teleport']);
    await gitOk(top,['merge','--ff-only','refs/canopy/teleport']).catch(e=>{throw Error(`the destination has diverged, so nothing was applied: ${e.message}`);});
    return await gitOk(top,['rev-parse','HEAD']);
   }finally{
    await unlink(file).catch(()=>{});
    await run(top,['update-ref','-d','refs/canopy/teleport']);
   }
  },
  async patchCreate({path:p}){
   const top=await topLevel(p);
   const r=await run(top,['diff','--binary','HEAD']);
   if(!r.ok)throw Error(r.stderr||'git failed');
   if(r.stdout.length>MAX_GIT_BYTES)throw Error('the changes are too large to move this way');
   return Buffer.from(r.stdout).toString('base64');
  },
  async patchApply({path:p,data}){
   const top=await topLevel(p);
   if(await gitOk(top,['status','--porcelain']))throw Error('the destination has uncommitted changes; nothing was applied');
   if(typeof data!=='string')throw Error('the changes were damaged in transit');
   const file=tempFile('patch');
   await writeFile(file,Buffer.from(data,'base64'),{mode:0o600});
   try{await gitOk(top,['apply','--binary','--whitespace=nowarn',file]);}finally{await unlink(file).catch(()=>{});}
  },
 };
}

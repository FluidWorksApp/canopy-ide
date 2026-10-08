import {mkdir,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const SCRATCH_ENV={
 CANOPY_SCRATCH_DIR:'/scratch',
 // Codex's default workspace-write sandbox grants TMPDIR too. Keep it at the
 // private scratch root so builds and caches remain inside that bounded grant.
 TMPDIR:'/scratch',
 XDG_CACHE_HOME:'/scratch/cache',
 NPM_CONFIG_CACHE:'/scratch/cache/npm',
 PIP_CACHE_DIR:'/scratch/cache/pip',
 UV_CACHE_DIR:'/scratch/cache/uv',
};
export const scratchDockerEnv=()=>Object.entries(SCRATCH_ENV).flatMap(([key,value])=>['--env',`${key}=${value}`]);

// Called before either the native server or any PTY can start. A marked but
// missing/unwritable mount must fail rather than quietly use persistent space.
async function scratchDirectory(root,relative){
 let directory=root;
 for(const component of relative.split('/')){
  directory=path.join(directory,component);
  try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  if(!(await lstat(directory)).isDirectory()||await realpath(directory)!==directory)throw Error('Scratch directories must not be symlinks');
 }
 return directory;
}
export async function initializeScratch(env=process.env){
 const root=env.CANOPY_SCRATCH_DIR;
 if(!root)return {};
 if(!path.isAbsolute(root)||root!==path.resolve(root)||root==='/'||await realpath(root)!==root||!(await lstat(root)).isDirectory())throw Error('Invalid workspace scratch mount');
 for(const relative of ['cache/npm','cache/pip','cache/uv','build','jobs']){
  await scratchDirectory(root,relative);
 }
 return Object.fromEntries(Object.entries(SCRATCH_ENV).map(([key,value])=>[key,env[key]??root+value.slice('/scratch'.length)]));
}

// Distinct sessions never overwrite one another's Cargo outputs. This also
// covers commands entered later in a bare shell, whose future cwd is unknown.
export async function scratchSessionEnv(requestId,env=process.env){
 if(!env.CANOPY_SCRATCH_DIR)return {};
 const key=createHash('sha256').update(requestId).digest('hex').slice(0,32);
 const target=await scratchDirectory(env.CANOPY_SCRATCH_DIR,`build/${key}/cargo`);
 return {...Object.fromEntries(Object.keys(SCRATCH_ENV).map(key=>[key,env[key]]).filter(([,value])=>value!=null)),CARGO_TARGET_DIR:env.CARGO_TARGET_DIR??target};
}

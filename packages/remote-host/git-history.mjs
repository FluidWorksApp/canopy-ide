// Commit and branch history for the Linux workspace, with the same results as
// the desktop's git.rs commands (git_commit_detail, git_commit_patch,
// git_branch_commits, git_branch_patch). `git(argv, cwd, options)` runs a
// read-only Git inspection and resolves to stdout.
export const MAX_PATCH_BYTES=2*1024*1024;
const MAX_UNTRACKED=100;

export function checkedHash(hash){
 const value=String(hash??'').trim();
 if(!value||!/^[0-9a-fA-F]+$/.test(value)||value.length>64)throw Error('invalid commit hash');
 return value;
}
export function checkedRef(name){
 const value=String(name??'').trim();
 if(!value||value.startsWith('-')||value.includes('..')||/\s/.test(value)||/[~^:\\]/.test(value)||value.length>255)throw Error('invalid branch name');
 return value;
}
export function patchStats(patch){
 let files=0,adds=0,dels=0,hunk=false;
 for(const line of patch.split('\n')){
  if(line.startsWith('diff --git ')){files++;hunk=false;}
  else if(line.startsWith('@@'))hunk=true;
  else if(hunk){if(line[0]==='+')adds++;else if(line[0]==='-')dels++;}
 }
 return {files,adds,dels};
}
/** Cut at most `max` bytes on a line boundary, never inside a character. */
export function truncatePatch(patch,max=MAX_PATCH_BYTES){
 const bytes=Buffer.from(patch);
 if(bytes.length<=max)return {patch,truncated:false};
 let cut=max;while(cut>0&&(bytes[cut]&0xc0)===0x80)cut--;
 const head=bytes.subarray(0,cut),newline=head.lastIndexOf(10);
 return {patch:(newline>=0?head.subarray(0,newline+1):head).toString('utf8'),truncated:true};
}
const result=(patch,stats)=>{const cut=truncatePatch(patch);return {patch:cut.patch,files_changed:stats.files,insertions:stats.adds,deletions:stats.dels,truncated:cut.truncated};};
const numstat=text=>{let files=0,adds=0,dels=0;for(const line of text.split('\n').filter(Boolean)){const [a,d]=line.split('\t');files++;adds+=Number(a)||0;dels+=Number(d)||0;}return {files,adds,dels};};

export function gitHistory({git}){
 const top=async repo=>(await git(['rev-parse','--show-toplevel'],repo)).trim();
 async function defaultBase(dir){
  try{const head=(await git(['rev-parse','--abbrev-ref','origin/HEAD'],dir)).trim();if(head&&head!=='origin/HEAD')return head;}catch{}
  for(const candidate of ['origin/main','origin/master','main','master']){try{await git(['rev-parse','--verify','--quiet',candidate],dir);return candidate;}catch{}}
  try{return (await git(['rev-parse','--abbrev-ref','HEAD'],dir)).trim()||'HEAD';}catch{return 'HEAD';}
 }
 // A capped read keeps what fits and says so; the counts then come from
 // numstat, which covers the whole diff.
 async function capped(argv,dir,stat){
  const output=await git(argv,dir,{maxBuffer:MAX_PATCH_BYTES+1,partial:true});
  if(!output.partial)return result(output.stdout,patchStats(output.stdout));
  const counts=numstat(await git(stat,dir,{maxBuffer:4*1024*1024}));
  return {...result(output.stdout,counts),truncated:true};
 }
 return {
  async commitDetail({repo,hash}){
   const dir=await top(repo),id=checkedHash(hash);
   const fields=(await git(['show','-s','--date=iso','--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f%D%x1f%P',id],dir)).split('\x1f');
   if(fields.length<9)throw Error('commit not found');
   return {hash:fields[0],short:fields[1],author:fields[2],email:fields[3],date:fields[4],subject:fields[5],body:fields[6].trim(),refs:fields[7],parents:fields[8].split(/\s+/).filter(Boolean)};
  },
  // Merges print no patch under plain `git show`; reported as empty, as on the desktop.
  async commitPatch({repo,hash}){
   const dir=await top(repo),id=checkedHash(hash);
   return capped(['show','--patch','--format=',id],dir,['show','--numstat','--format=',id]);
  },
  async branchCommits({repo,branch}){
   const dir=await top(repo),name=checkedRef(branch),base=await defaultBase(dir);
   let text='';try{text=await git(['log','-200','--date=short','--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D',`${base}..${name}`],dir);}catch{}
   return text.split('\n').map(line=>line.split('\x1f')).filter(f=>f.length>=5).map(f=>({hash:f[0],short:f[1],author:f[2],date:f[3],subject:f[4],refs:f[5]??''}));
  },
  async branchPatch({repo,branch,worktree,uncommitted}){
   const dir=await top(repo),name=checkedRef(branch);
   if(!uncommitted){
    const base=await defaultBase(dir);
    try{return await capped(['diff',`${base}...${name}`],dir,['diff','--numstat',`${base}...${name}`]);}catch{return result('',{files:0,adds:0,dels:0});}
   }
   let target=dir;
   if(worktree!=null){
    // Git's own worktree list decides what belongs to this repository.
    const listed=(await git(['worktree','list','--porcelain'],dir)).split('\n').filter(line=>line.startsWith('worktree ')).map(line=>line.slice(9));
    if(!listed.includes(String(worktree)))throw Error('not a worktree of this repository');
    target=String(worktree);
   }
   let patch='';try{patch=await git(['diff','HEAD'],target,{maxBuffer:MAX_PATCH_BYTES+1,partial:true}).then(o=>o.stdout);}catch{}
   let status='';try{status=await git(['status','--porcelain=v1','-z','--untracked-files=all'],target);}catch(error){if(/no such file|ENOENT|cannot change to/i.test(error.message))throw Error("this worktree's directory no longer exists");}
   const untracked=status.split('\0').filter(entry=>entry.startsWith('?? ')).map(entry=>entry.slice(3)).slice(0,MAX_UNTRACKED);
   for(const file of untracked){
    if(Buffer.byteLength(patch)>=MAX_PATCH_BYTES)break;
    // Exit status 1 means "they differ", which against /dev/null is always.
    try{patch+=await git(['diff','--no-index','--','/dev/null',file],target,{allowDiffExit:true,maxBuffer:MAX_PATCH_BYTES});}catch{}
   }
   return result(patch,patchStats(patch));
  },
 };
}

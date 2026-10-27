// Branch, worktree, sync and discard operations for the Linux workspace, with
// the same arguments, result shapes and refusals as the desktop's git.rs,
// sync.rs and fsx.rs commands. Refusals a person can act on come back as
// `CheckoutOutcome`s (`{kind:...}`, as git.rs serialises them); thrown errors
// stay reserved for "git couldn't run" and for the guards Rust also throws.
// Inspection goes through ctx.run (safeGitRead for read subcommands); commands
// whose exit code or both output streams matter use ctx.execute.
import path from 'node:path';
import {access,stat,lstat,mkdir,copyFile,rm,realpath,constants} from 'node:fs/promises';
import {listWorkspaceFiles} from './file-search.mjs';
import {checkedRef} from './git-history.mjs';

export const GIT_OPS_READ_ONLY=['git_rev_count','git_share_context','git_show_at','git_work_audit','git_sync_probe','git_pr_merge_probe','fs_repo_path','fs_snapshot_files'];

const NET_TIMEOUT=120000,NET_TIMEOUT_MESSAGE="timed out after 120s — remote unreachable, or it wants credentials this app can't prompt for";
const SHOW_AT_MAX=4*1024*1024,CONFLICT_LIMIT=50,SUBJECT_LIMIT=8,MAX_EDIT_PATHS=4096;
const PROTECTED=['main','master','develop','development','trunk','staging','production'];

// ---------- pure helpers (exported for tests) ----------
export const isProtectedBranch=(name,base)=>name===base.split('/').at(-1)||PROTECTED.includes(name);
export const isFullSha=s=>typeof s==='string'&&(s.length===40||s.length===64)&&/^[0-9a-f]+$/.test(s);
const fullSha=s=>{const v=String(s??'').trim().toLowerCase();return isFullSha(v)?v:'';};
const lineCount=s=>s.split('\n').filter(l=>l.trim()).length;
const nulFields=raw=>raw.split('\0').filter(Boolean);
const joinStreams=(out,err)=>[String(out??'').trim(),String(err??'').trim()].filter(Boolean).join('\n');
const isAgentWorktree=p=>p.includes('/.claude/worktrees/');
// A name that reaches a command line: never an option, never multi-line.
function plainName(value,what='branch name'){
 const name=typeof value==='string'?value.trim():'';
 if(!name||name.length>255||name.startsWith('-')||/[\s\0]/.test(name))throw Error(`invalid ${what}`);
 return name;
}
export function validRepoRel(rel){
 if(typeof rel!=='string'||!rel||rel.length>1024||rel.startsWith('/'))return false;
 if(/[\p{Cc}\\‪-‮⁦-⁩]/u.test(rel))return false;
 if(['%2e','%2f','%5c','%00'].some(p=>rel.toLowerCase().includes(p)))return false;
 const segments=rel.split('/');
 if(/^[a-zA-Z]:/.test(segments[0]))return false;
 return segments.every(s=>s&&s!=='.'&&s!=='..'&&s.toLowerCase()!=='.git');
}
export function parseWorktrees(out){
 const list=[];let cur=null;
 for(const line of out.split('\n')){
  if(!line.trim()){if(cur)list.push(cur);cur=null;continue;}
  const at=line.indexOf(' '),key=at<0?line:line.slice(0,at),value=at<0?'':line.slice(at+1);
  if(key==='worktree'){if(cur)list.push(cur);cur={path:value,name:value.split('/').at(-1),head:'',branch:null,detached:false,bare:false,locked:null,prunable:null,is_main:false,dirty:0};continue;}
  if(!cur)continue;
  if(key==='HEAD')cur.head=value.slice(0,8);
  else if(key==='branch')cur.branch=value.replace(/^refs\/heads\//,'');
  else if(key==='detached')cur.detached=true;
  else if(key==='bare')cur.bare=true;
  else if(key==='locked')cur.locked=value||'locked';
  else if(key==='prunable')cur.prunable=value||'prunable';
 }
 if(cur)list.push(cur);
 list.forEach((w,i)=>{w.is_main=i===0;});
 return list;
}
export function classifyCheckout(err){
 const held=err.split('\n').find(l=>l.includes('is already used by worktree at'));
 if(held)return {kind:'branch_in_worktree',path:held.slice(held.indexOf('worktree at ')+12).trim().replace(/^'+|'+$/g,'')};
 const lines=err.split('\n');
 for(let i=0;i<lines.length;i++){
  if(!lines[i].includes('would be overwritten by'))continue;
  const files=[];for(let j=i+1;j<lines.length&&/^\s/.test(lines[j])&&lines[j].trim();j++)files.push(lines[j].trim());
  return {kind:'local_changes',files,untracked:lines[i].includes('untracked')};
 }
 return {kind:'unknown'};
}
const quoted=line=>{const m=/'([^']*)'/.exec(line);return m?m[1]:null;};
export function classifyExtra(err){
 for(const raw of err.split('\n')){
  const l=raw.trim();
  if(l.includes('refusing to fetch into branch ')&&l.includes(' checked out at '))return {kind:'branch_in_worktree',path:l.split(' checked out at ')[1].trim().replace(/^'+|'+$/g,'')};
  const op=l.includes('cannot switch branch while merging')?'merge':l.includes('cannot switch branch while rebasing')?'rebase':l.includes('cannot switch branch while cherry-picking')?'cherry-pick':l.includes('cannot switch branch while reverting')?'revert':l.includes('in the middle of an am session')?'am':l.includes('you need to resolve your current index first')?'merge':null;
  if(op)return {kind:'mid_operation',op};
  if(l.includes('a branch named ')&&l.includes(' already exists')&&quoted(l)!=null)return {kind:'name_taken',branch:quoted(l)};
  if(l.includes("' already exists")&&!l.includes('a branch named ')&&quoted(l)!=null)return {kind:'path_in_use',path:quoted(l)};
  if(l.includes('pathspec ')&&l.includes(' did not match')&&quoted(l)!=null)return {kind:'nothing_called',name:quoted(l)};
  const invalid=l.indexOf('invalid reference: ');if(invalid>=0)return {kind:'nothing_called',name:l.slice(invalid+19).trim().replace(/^'+|'+$/g,'')};
  if(l.includes('cannot remove a locked working tree')||l.includes('cannot move a locked working tree')){const at=l.indexOf('lock reason: ');return {kind:'locked_workspace',path:'',reason:at>=0&&l.slice(at+13).trim()||'locked'};}
  if(l.includes("Unable to create '")&&l.includes("index.lock': File exists"))return {kind:'another_command'};
  if(l.includes("couldn't find remote ref pull/")||l.includes('no git remotes found')||l.includes('Could not resolve to a PullRequest')||l.includes('remote unreachable, or it wants credentials')||l.includes('gh auth login'))return {kind:'remote_unreachable',summary:l.replace(/^fatal: /,'')};
 }
 return null;
}
export function stripGhNoise(err){
 const lines=err.split('\n');
 while(lines.length&&(!lines.at(-1).trim()||/^failed to run git: exit status -?\d+$/.test(lines.at(-1).trim())))lines.pop();
 return lines.join('\n').trim();
}
export function remoteUnreachableFor(err,pr=null){
 const detail=stripGhNoise(err),l=detail.toLowerCase();
 const summary=['gh auth login','not logged in','requires authentication','wants credentials','authentication failed'].some(s=>l.includes(s))?"Canopy couldn't reach GitHub with the sign-in it has."
  :l.includes('no git remotes found')||l.includes('does not appear to be a git repo')?'This project has no remote to fetch from.'
  :l.includes("couldn't find remote ref")||l.includes('could not resolve to a pullrequest')?`GitHub doesn't have a copy of ${pr==null?'those':`#${pr}'s`} changes to fetch. A private fork you can't read is the usual reason.`
  :"Canopy couldn't reach GitHub just now.";
 return {kind:'remote_unreachable',summary,detail};
}
const repoBusy=op=>({kind:'repo_busy',operation:op,detail:`git ${op} --quit — the ${op} state is cleared; the working tree is untouched.`});

// ---------- git plumbing over ctx ----------
export function gitTools(ctx){
 const {run,scoped}=ctx,root=ctx.root??'/workspace';
 const env={...process.env,HOME:ctx.home??process.env.HOME,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'};
 const read=(dir,argv,timeout)=>run('git',argv,dir,timeout);
 const opt=async(dir,argv)=>{try{return (await read(dir,argv)).trim();}catch{return null;}};
 const ok=async(dir,argv)=>{try{await read(dir,argv);return true;}catch{return false;}};
 // Exit code plus both streams: a refusal routinely spans stdout and stderr.
 // Working-tree writes get the same ceiling as a merge: a monorepo checkout is slow.
 async function exec(dir,argv,{timeout=120000,maxBuffer=1024*1024,network=false}={}){
  const cwd=await scoped(dir);
  try{const {stdout,stderr}=await ctx.execute('git',argv,{cwd,timeout,maxBuffer,env});return {code:0,stdout:String(stdout),stderr:String(stderr)};}
  catch(error){
   if(error.killed||error.signal)throw Error(network?NET_TIMEOUT_MESSAGE:'git timed out');
   if(typeof error.code!=='number')throw Error(String(error.stderr||error.message||'git failed').slice(0,4096));
   return {code:error.code,stdout:String(error.stdout??''),stderr:String(error.stderr??'')};
  }
 }
 async function must(dir,argv,options){const r=await exec(dir,argv,options);if(r.code)throw Error(joinStreams(r.stdout,r.stderr)||'git failed');return r.stdout;}
 const exists=async p=>{try{await access(p);return true;}catch{return false;}};
 const canon=async p=>{try{return await realpath(p);}catch{return p;}};
 const sameDir=async(a,b)=>a===b||await canon(a)===await canon(b);
 async function repoPath(repo){
  if(typeof repo!=='string'||!repo)throw Error('Invalid workspace path');
  const dir=await scoped(repo);
  return scoped((await read(dir,['rev-parse','--show-toplevel'])).trim());
 }
 // A path git is about to create: its nearest existing ancestor must resolve
 // inside the workspace, and nothing past it may climb back out.
 async function scopedNew(value){
  if(typeof value!=='string'||!value||value.length>4096||/[\0\n\r]/.test(value))throw Error('Invalid workspace path');
  let base=path.resolve(root,value);const rest=[];
  for(;;){
   try{return path.join(await scoped(base),...rest);}
   catch(error){if(error.code!=='ENOENT'||base==='/')throw error;rest.unshift(path.basename(base));base=path.dirname(base);}
  }
 }
 async function defaultBase(top){
  const sym=await opt(top,['symbolic-ref','--short','refs/remotes/origin/HEAD']);if(sym)return sym;
  for(const candidate of ['origin/main','origin/master','main','master'])if(await ok(top,['rev-parse','--verify','--quiet',candidate]))return candidate;
  return (await opt(top,['rev-parse','--abbrev-ref','HEAD']))||'HEAD';
 }
 async function headBranch(dir){
  const branch=await opt(dir,['symbolic-ref','--quiet','--short','HEAD']);
  if(branch)return {branch,detached:false};
  return {branch:(await opt(dir,['rev-parse','--short','HEAD']))||null,detached:true};
 }
 async function scanWorktrees(top){
  const list=parseWorktrees(await read(top,['worktree','list','--porcelain']));
  // Git omits `prunable` for a locked worktree whose folder is gone.
  for(const w of list)if(!w.prunable&&w.locked&&!w.is_main&&!await exists(w.path))w.prunable='its folder is gone';
  return list;
 }
 // Sequential: one status per worktree, and the host allows four children.
 async function listWorktrees(top){
  const list=await scanWorktrees(top);
  for(const w of list)if(!w.prunable&&!w.bare){try{w.dirty=lineCount(await read(w.path,['status','--porcelain']));}catch{}}
  return list;
 }
 async function branchCommitsOf(top,base,branch){
  let out='';try{out=await read(top,['log','-200','--date=short','--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D',`${base}..${branch}`]);}catch{}
  return out.split('\n').map(l=>l.split('\x1f')).filter(f=>f.length>=5).map(f=>({hash:f[0],short:f[1],author:f[2],date:f[3],subject:f[4],refs:f[5]??''}));
 }
 return {env,read,opt,ok,exec,must,exists,canon,sameDir,repoPath,scopedNew,defaultBase,headBranch,scanWorktrees,listWorktrees,branchCommitsOf};
}

export function gitOpsCommands(ctx){
 const t=gitTools(ctx),{read,opt,ok,exec,must,exists,sameDir,repoPath,scopedNew,defaultBase,scanWorktrees,listWorktrees}=t,{scoped}=ctx;

 // ---------- checkout outcomes (git.rs "switching branches") ----------
 async function branchHolder(top,branch){
  let list;try{list=await scanWorktrees(top);}catch{return null;}
  let w=null;for(const x of list)if(x.branch===branch&&!await sameDir(x.path,top)){w=x;break;}
  if(!w)return null;
  let dirty=0;if(!w.prunable&&!w.bare){try{dirty=lineCount(await read(w.path,['status','--porcelain']));}catch{}}
  return {branch,path:w.path,name:w.name,agent:isAgentWorktree(w.path),is_main:w.is_main,dirty,locked:w.locked,prunable:w.prunable,head:w.head};
 }
 async function holderAt(top,branch,at){
  const held=await branchHolder(top,branch);if(held)return held;
  let list=[];try{list=await scanWorktrees(top);}catch{}
  for(const w of list)if(await sameDir(w.path,at))return {branch,path:w.path,name:w.name,agent:isAgentWorktree(w.path),is_main:w.is_main,dirty:0,locked:w.locked,prunable:w.prunable,head:w.head};
  return {branch,path:at,name:at.replace(/[/\\]+$/,'').split(/[/\\]/).at(-1)||at,agent:isAgentWorktree(at),is_main:await sameDir(at,top),dirty:0,locked:null,prunable:null,head:''};
 }
 async function repoState(top){
  const gitDir=await opt(top,['rev-parse','--git-dir']),dir=gitDir?path.resolve(top,gitDir):path.join(top,'.git');
  const has=p=>exists(path.join(dir,p));
  const mid=await has('rebase-merge')?'rebase':await has('rebase-apply')?(await has('rebase-apply/applying')?'am':'rebase'):await has('MERGE_HEAD')?'merge':await has('CHERRY_PICK_HEAD')?'cherry-pick':await has('REVERT_HEAD')?'revert':null;
  const unborn=!await ok(top,['rev-parse','--verify','--quiet','HEAD']);
  const detached=!await ok(top,['symbolic-ref','--quiet','HEAD']);
  let orphans=[];
  if(detached&&!unborn){const out=await opt(top,['log','--max-count=20','--format=%h %s','HEAD','--not','--branches','--remotes']);orphans=(out??'').split('\n').map(l=>l.trim()).filter(Boolean);}
  return {mid,unborn,orphans};
 }
 function settled(message,where,before){
  if(!before.orphans.length)return {kind:'switched',message,path:where};
  const first=before.orphans[0].split(/\s+/)[0];
  return {kind:'switched_with_leftovers',message,commits:before.orphans,detail:`git branch saved-${first} ${first} — the commit gets a name, and stops being reachable only by luck.`};
 }
 const canCreateBranch=async(top,name)=>!(await repoState(top)).unborn&&await ok(top,['check-ref-format','--branch',name])&&!await ok(top,['rev-parse','--verify','--quiet',`refs/heads/${name}`]);
 async function isKnownWorktree(top,at){try{for(const w of await scanWorktrees(top))if(await sameDir(w.path,at))return true;}catch{}return false;}
 async function switchFailed(top,target,err){
  const detail=stripGhNoise(err),first=classifyCheckout(err);
  if(first.kind==='branch_in_worktree')return {kind:'branch_in_worktree',holder:await holderAt(top,target,first.path)};
  if(first.kind==='local_changes')return {kind:'local_changes',files:first.files,untracked:first.untracked,detail};
  const extra=classifyExtra(err);
  switch(extra?.kind){
   case 'branch_in_worktree':return {kind:'branch_in_worktree',holder:await holderAt(top,target,extra.path)};
   case 'mid_operation':return repoBusy(extra.op);
   case 'another_command':return {kind:'repo_busy',operation:'another-command',detail};
   case 'name_taken':return {kind:'name_taken',branch:extra.branch,detail};
   case 'nothing_called':return {kind:'nothing_called',name:extra.name,can_create:await canCreateBranch(top,extra.name),detail};
   case 'path_in_use':return {kind:'path_in_use',path:extra.path,usable:await isKnownWorktree(top,extra.path),detail};
   case 'locked_workspace':{const holder=await holderAt(top,target,extra.path);holder.locked??=extra.reason;return {kind:'branch_in_worktree',holder};}
   case 'remote_unreachable':return remoteUnreachableFor(err);
   default:return {kind:'failed',summary:`Git couldn't switch to ${target}.`,detail};
  }
 }
 // Run a switch; a refusal becomes an outcome, never a thrown error.
 async function attempt(top,argv,dir=top){const r=await exec(dir,argv);return r.code?joinStreams(r.stdout,r.stderr)||'git failed':null;}
 const stashTop=top=>opt(top,['rev-parse','-q','--verify','refs/stash']).then(s=>s||null);
 async function resolveRef(top,name){
  const remotes=((await opt(top,['remote']))??'').split('\n').map(r=>r.trim()).filter(Boolean);
  for(const candidate of [name,...remotes.map(r=>`refs/remotes/${r}/${name}`)])if(await ok(top,['rev-parse','--verify',`${candidate}^{commit}`]))return candidate;
  return null;
 }
 function repoFiles(top,files){
  if(!Array.isArray(files)||files.length>MAX_EDIT_PATHS)throw Error('Choose files');
  for(const file of files){
   if(typeof file!=='string'||!file||file.includes('\0'))throw Error('Invalid file path');
   const candidate=path.resolve(top,file);if(candidate!==top&&!candidate.startsWith(top+'/'))throw Error('File outside repository');
  }
  // A deleted tracked file (or its whole folder) is still restorable.
  return Promise.all(files.map(file=>scopedNew(path.resolve(top,file)))).then(()=>files);
 }
 const worktreeOf=async(top,at)=>{for(const w of await scanWorktrees(top))if(!w.is_main&&(w.path===at||await sameDir(w.path,at)))return w;return null;};

 // ---------- sync (sync.rs) ----------
 async function inProgress(top){
  const dir=await opt(top,['rev-parse','--absolute-git-dir']);if(!dir)return null;
  for(const [file,what] of [['MERGE_HEAD','a merge'],['rebase-merge','a rebase'],['rebase-apply','a rebase'],['CHERRY_PICK_HEAD','a cherry-pick'],['REVERT_HEAD','a revert'],['BISECT_LOG','a bisect']])if(await exists(path.join(dir,file)))return `${what} is already in progress here`;
  return null;
 }
 async function dirtyPaths(top){
  let raw;try{raw=await read(top,['status','--porcelain','-z']);}catch{return [];}
  const parts=raw.split('\0'),out=[];
  for(let i=0;i<parts.length;i++){const part=parts[i];if(part.length<4)continue;if(part[0]==='R'||part[0]==='C')i++;out.push(part.slice(3));}
  return out;
 }
 // Exit 0 clean, 1 conflicts (paths after the tree id), anything else: can't tell.
 async function mergeTree(top,a,b){
  let r;try{r=await exec(top,['merge-tree','--write-tree','--name-only','--no-messages','-z',a,b],{timeout:60000,maxBuffer:4*1024*1024});}catch{return {clean:null,conflicts:[]};}
  if(r.code===0)return {clean:true,conflicts:[]};
  if(r.code===1)return {clean:false,conflicts:nulFields(r.stdout).slice(1,1+CONFLICT_LIMIT)};
  return {clean:null,conflicts:[]};
 }
 const checkedBase=value=>plainName(value,'base branch');

 return {
  async git_checkout_detached({repo,refname}){
   const top=await repoPath(repo),name=typeof refname==='string'?refname.trim():'';
   if(!name)throw Error('need a branch or commit to look at');
   plainName(name,'ref');
   const before=await repoState(top);if(before.mid)return repoBusy(before.mid);
   const target=await resolveRef(top,name);
   if(!target)return {kind:'nothing_called',can_create:await canCreateBranch(top,name),name,detail:`git rev-parse --verify ${name} finds nothing — not locally, and not on any remote this checkout knows.`};
   const err=await attempt(top,['checkout','--detach',target]);
   return err?switchFailed(top,name,err):settled(`Looking at ${name} — nothing moved`,null,before);
  },
  async git_branch_release({repo,branch}){
   const top=await repoPath(repo);branch=plainName(branch);
   const free=()=>({kind:'switched',message:`${branch} is free`,path:null});
   const holder=await branchHolder(top,branch);if(!holder)return free();
   if(holder.prunable){
    // `prune` skips locked records; a locked-and-gone one needs force first.
    if(holder.locked)await exec(top,['worktree','remove','--force','--force',holder.path]).catch(()=>{});
    await must(top,['worktree','prune']);
    const still=await branchHolder(top,branch);
    return still?{kind:'branch_in_worktree',holder:still}:free();
   }
   if(holder.locked)return {kind:'branch_in_worktree',holder};
   let err;try{err=await attempt(top,['switch','--detach'],holder.path);}catch(error){err=String(error.message);}
   if(!err)return free();
   if(err.includes("cannot change to '")||err.includes('No such file or directory')||err.includes('ENOENT')){await must(top,['worktree','prune']);return free();}
   return switchFailed(top,branch,err);
  },
  async git_checkout_carry({repo,branch}){
   const top=await repoPath(repo);branch=plainName(branch);
   const before=await repoState(top);if(before.mid)return repoBusy(before.mid);
   const holder=await branchHolder(top,branch);if(holder)return {kind:'branch_in_worktree',holder};
   const prior=await stashTop(top);
   const push=await exec(top,['stash','push','--include-untracked','-m',`canopy: switching to ${branch}`]);
   if(push.code)return {kind:'failed',summary:"Your changes couldn't be set aside, so nothing was moved.",detail:stripGhNoise(joinStreams(push.stdout,push.stderr))};
   const after=await stashTop(top),stashed=!!after&&after!==prior;
   const err=await attempt(top,['checkout',branch]);
   if(err){if(stashed)await exec(top,['stash','pop']).catch(()=>{});return switchFailed(top,branch,err);}
   if(!stashed)return settled(`Switched to ${branch}`,null,before);
   const pop=await exec(top,['stash','pop']);
   // A conflicting pop leaves the stash in place: name the entry we made.
   if(pop.code)return {kind:'changes_stashed',stash:after||'refs/stash',detail:joinStreams(pop.stdout,pop.stderr)};
   return settled(`Switched to ${branch} with your changes`,null,before);
  },
  async git_discard({repo,tracked=[],untracked=[]}){
   const top=await repoPath(repo);
   await repoFiles(top,tracked);await repoFiles(top,untracked);
   if(tracked.length)await must(top,['checkout','HEAD','--',...tracked]);
   if(untracked.length)await must(top,['clean','-f','-d','--',...untracked]);
   return null;
  },
  async git_operation_quit({repo}){
   const top=await repoPath(repo),{mid}=await repoState(top);
   if(!mid)return 'Nothing was half-finished';
   await must(top,[mid,'--quit']);
   return `Called it off — your files are exactly as you left them (${mid})`;
  },
  async git_branch_at({repo,name,commit}){
   const top=await repoPath(repo);name=typeof name==='string'?name.trim():'';commit=typeof commit==='string'?commit.trim():'';
   if(!name||!commit)throw Error('need a name and a commit to save it at');
   plainName(name);plainName(commit,'commit');
   await must(top,['branch',name,commit]);
   return `Saved as ${name}`;
  },
  async git_branch_delete({repo,branch,force}){
   const top=await repoPath(repo);branch=checkedRef(branch);
   if(isProtectedBranch(branch,await defaultBase(top)))throw Error(`${branch} is a protected branch and can't be deleted here`);
   if(branch===(await opt(top,['rev-parse','--abbrev-ref','HEAD'])??''))throw Error("can't delete the branch you're on — switch away first");
   await must(top,['branch',force?'-D':'-d',branch]);
   return `Deleted ${branch}`;
  },
  async git_branch_delete_remote({repo,branch}){
   const top=await repoPath(repo);branch=checkedRef(branch);
   if(isProtectedBranch(branch,await defaultBase(top)))throw Error(`${branch} is a protected branch and can't be deleted here`);
   await must(top,['push','origin','--delete',branch],{timeout:NET_TIMEOUT,network:true});
   return `Deleted ${branch} on GitHub`;
  },
  async git_rev_count({repo,from,to}){
   if(!isFullSha(from)||!isFullSha(to))throw Error('invalid commit id');
   const top=await repoPath(repo),n=Number((await read(top,['rev-list','--count',`${from}..${to}`,'--'])).trim());
   if(!Number.isSafeInteger(n))throw Error('git returned an unexpected count');
   return n;
  },
  async git_show_at({repo,sha,path:rel}){
   const top=await repoPath(repo);
   if(!isFullSha(sha))throw Error('invalid commit id');
   if(!validRepoRel(rel))throw Error('invalid repo path');
   const object=`${sha}:${rel}`,short=sha.slice(0,7);
   const kind=await opt(top,['cat-file','-t','--',object]);
   if(kind==null)throw Error(`${rel} is not in this checkout at ${short}`);
   if(kind!=='blob')throw Error(`${rel} is not a file at ${short}`);
   const size=Number((await read(top,['cat-file','-s','--',object])).trim());
   if(!Number.isSafeInteger(size))throw Error('git returned an unexpected size');
   if(size>SHOW_AT_MAX)throw Error(`${rel} is too large to show (${size} bytes)`);
   const cwd=await scoped(top);let stdout;
   try{({stdout}=await ctx.execute('git',['cat-file','blob',object],{cwd,timeout:30000,maxBuffer:SHOW_AT_MAX+1,encoding:'buffer',env:t.env}));}
   catch(error){throw Error(String(error.stderr??error.message).trim());}
   if(stdout.includes(0))throw Error(`${rel} is a binary file`);
   return stdout.toString('utf8');
  },
  async git_share_context({path:target}){
   const file=await scoped(target);
   const dir=(await stat(file)).isDirectory()?file:path.dirname(file);
   const top=await scoped((await read(dir,['rev-parse','--show-toplevel'])).trim());
   const rel=file===top?'':file.startsWith(top+'/')?file.slice(top.length+1):'';
   const head=fullSha((await read(top,['rev-parse','HEAD'])).trim());
   const origin=(await opt(top,['remote','get-url','origin']))??'';
   const dirty=!!rel&&!!(await opt(top,['status','--porcelain','--',rel]));
   return {root:top,rel,head,origin,dirty};
  },
  async git_work_audit({repo}){
   const top=await repoPath(repo),base=await defaultBase(top);
   const worktrees=await listWorktrees(top);
   const current=(await opt(top,['rev-parse','--abbrev-ref','HEAD']))??'';
   const refs=await read(top,['for-each-ref','--format','%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(contents:subject)%1f%(authorname)','refs/heads']);
   // %(ahead-behind:) needs git 2.41; older git degrades to "no counts".
   const vsBase=new Map();let degraded=true;
   try{
    for(const line of (await read(top,['for-each-ref','--format',`%(refname:short)%1f%(ahead-behind:${base})`,'refs/heads'])).split('\n')){
     const [name,counts]=line.split('\x1f');if(name==null||counts==null)continue;
     const [a,b]=counts.trim().split(/\s+/).map(Number);if(Number.isInteger(a)&&Number.isInteger(b))vsBase.set(name,[a,b]);
    }
    degraded=vsBase.size===0;
   }catch{}
   const merged=new Set(((await opt(top,['branch','--merged',base,'--format','%(refname:short)']))??'').split('\n').map(l=>l.trim()).filter(Boolean));
   const now=Math.floor(Date.now()/1000),items=[];
   for(const line of refs.split('\n')){
    const f=line.split('\x1f');if(f.length<6)continue;
    const branch=f[0],upstream=f[1]||null,track=f[2],gone=track.includes('gone');
    const tracked=kw=>{for(const p of track.split(/[[\],]/)){const s=p.trim();if(s.startsWith(kw)){const n=Number(s.slice(kw.length).trim());if(Number.isInteger(n))return n;}}return 0;};
    const [ahead,behind]=upstream&&!gone?[tracked('ahead '),tracked('behind ')]:vsBase.get(branch)??[0,0];
    const ts=/^\d+$/.test(f[3])?Number(f[3]):now,wt=worktrees.find(w=>w.branch===branch);
    items.push({branch,worktree:wt?.path??null,is_main:wt?.is_main??false,prunable:!!wt?.prunable,current:branch===current,dirty:wt?.dirty??0,ahead,behind,upstream,upstream_gone:gone,merged:merged.has(branch),protected:isProtectedBranch(branch,base),last_commit:f[3],age_days:Math.floor(Math.max(0,now-ts)/86400),subject:f[4],author:f[5]});
   }
   return {base,counts_degraded:degraded,items};
  },
  async git_worktree_add({repo,path:where,branch,create}){
   const top=await repoPath(repo);branch=typeof branch==='string'?branch.trim():'';
   if(!branch)throw Error('branch name is required');
   plainName(branch);
   // Outside /workspace is refused, not relocated: the frontend keeps using
   // the path it asked for (workspaceAdd, the agent's cwd).
   const target=await scopedNew(where);
   if(!create){const holder=await branchHolder(top,branch);if(holder)return {kind:'branch_in_worktree',holder};}
   const err=await attempt(top,['worktree','add',...(create?['-b',branch,target]:[target,branch])]);
   return err?switchFailed(top,branch,err):{kind:'switched',message:`Workspace created at ${where}`,path:where};
  },
  async git_worktree_add_pr({repo,path:where,number,branch}){
   const top=await repoPath(repo);
   if(typeof branch!=='string'||!branch.trim())throw Error('branch name is required');
   if(!Number.isInteger(number)||number<1||number>0xffffffff)throw Error('invalid pull request number');
   const target=await scopedNew(where);
   const fetch=await exec(top,['fetch','origin',`pull/${number}/head`],{timeout:NET_TIMEOUT,network:true}).catch(error=>({code:-1,stdout:'',stderr:error.message}));
   if(fetch.code)return remoteUnreachableFor(fetch.stderr.trim()?fetch.stderr:fetch.stdout,number);
   // Detached at FETCH_HEAD: the PR's branch is usually checked out elsewhere.
   const err=await attempt(top,['worktree','add','--detach',target,'FETCH_HEAD']);
   return err?switchFailed(top,branch.trim(),err):{kind:'switched',message:`Workspace created at ${where}, at #${number}'s head`,path:where};
  },
  async git_worktree_bootstrap({repo,path:where,phase}){
   const wantsConfig=phase!=='deps',wantsDeps=phase!=='config';
   const top=await repoPath(repo);
   let dest;try{dest=await scoped(where);if(!(await stat(dest)).isDirectory())throw Error();}catch{throw Error(`${where} is not a directory`);}
   if(!await worktreeOf(top,dest))throw Error(`${where} is not a workspace of this repository`);
   const listing=(await opt(top,['ls-files','--others','--ignored','--exclude-standard','--directory']))??'';
   const report={carried:[],cloned:[],install:null,note:null};let failure=null,wantedDeps=false;
   for(const entry of listing.split('\n').map(e=>e.trim()).filter(Boolean)){
    const rel=entry.replace(/\/+$/,'');
    if(!rel||rel.split('/').some(p=>p==='..'||p==='.git'))continue;
    const src=path.join(top,rel),dst=path.join(dest,rel);
    if(await lstat(dst).then(()=>true,()=>false))continue;
    const isDir=entry.endsWith('/'),name=rel.split('/').at(-1);
    if(isDir&&name==='node_modules'){
     wantedDeps=true;if(!wantsDeps)continue;
     try{await mkdir(path.dirname(dst),{recursive:true});await scoped(path.dirname(dst));}catch{continue;}
     try{await ctx.run('cp',['--reflink=always','-r','--',src,dst],top,120000);report.cloned.push(rel);}
     catch(error){failure??=String(error.message).trim();await rm(dst,{recursive:true,force:true}).catch(()=>{});}
    }else if(!isDir&&wantsConfig&&(name.startsWith('.env')||name==='.envrc'||name==='.tool-versions')){
     // Regular files only: a symlinked .env could point outside the workspace.
     const info=await lstat(src).catch(()=>null);if(!info?.isFile()||info.size>512*1024)continue;
     try{await mkdir(path.dirname(dst),{recursive:true});await scoped(path.dirname(dst));await copyFile(src,dst,constants.COPYFILE_EXCL);report.carried.push(rel);}catch{}
    }
   }
   if(wantsDeps&&!report.cloned.length){
    for(const [lock,command] of [['pnpm-lock.yaml','pnpm install'],['yarn.lock','yarn install'],['bun.lockb','bun install'],['package-lock.json','npm ci']])if(await exists(path.join(top,lock))){report.install=command;break;}
    if(!report.install&&await exists(path.join(top,'package.json')))report.install='npm install';
    report.note=failure?`Couldn't clone dependencies: ${failure}`:!wantedDeps&&report.install?'No dependencies installed in the main checkout to clone from.':null;
   }else if(failure)report.note=`Some dependencies couldn't be cloned: ${failure}`;
   return report;
  },
  async git_worktree_remove({repo,path:where,force=0}){
   const top=await repoPath(repo),count=Math.min(2,Math.max(0,Math.trunc(Number(force))||0));
   if(typeof where!=='string'||!where)throw Error('Invalid workspace path');
   // Only a linked worktree git itself lists for this repository; the folder
   // may already be gone (a locked, missing workspace takes force 2).
   const known=await worktreeOf(top,path.resolve(ctx.root??'/workspace',where));
   if(!known)throw Error(`${where} is not a workspace of this repository`);
   const lexical=path.resolve(known.path);if(lexical!==(ctx.root??'/workspace')&&!lexical.startsWith((ctx.root??'/workspace')+'/'))throw Error('Path outside selected workspace');
   await must(top,['worktree','remove',...Array(count).fill('--force'),known.path]);
   return 'Workspace removed';
  },
  async git_worktree_realign({repo,path:where}){
   const top=await repoPath(repo);
   const known=(await scanWorktrees(top)).find(w=>!w.is_main&&w.path===where);
   if(!known)throw Error(`${where} is not a workspace of this repository`);
   if(known.locked)throw Error('workspace is locked');
   if((await read(known.path,['status','--porcelain'])).trim())throw Error('workspace has uncommitted changes');
   const target=(await read(top,['rev-parse','HEAD'])).trim(),head=(await read(known.path,['rev-parse','HEAD'])).trim();
   if(head===target)return 'Workspace already current';
   if(!await ok(known.path,['merge-base','--is-ancestor','HEAD',target]))throw Error('workspace has its own commits');
   await must(known.path,['reset','--hard',target]);
   return 'Workspace fast-forwarded';
  },
  async git_worktree_prune({repo}){
   const top=await repoPath(repo),pruned=(await must(top,['worktree','prune','-v'])).trim();
   const stuck=[];for(const w of await scanWorktrees(top).catch(()=>[]))if(!w.is_main&&!await exists(w.path))stuck.push(w.name);
   const note=`${stuck.join(', ')} is still recorded even though its folder is gone — it's locked, so clearing it takes force.`;
   return !pruned&&!stuck.length?'Nothing to clear':!stuck.length?pruned:!pruned?note:`${pruned}\n${note}`;
  },
  async git_sync_probe({repo,fetch,base:override}){
   const top=await repoPath(repo),{branch,detached}=await t.headBranch(top);
   const base=typeof override==='string'&&override.trim()?checkedBase(override):await defaultBase(top);
   let fetchError=null;
   if(fetch&&base.includes('/')){
    const remote=base.split('/')[0];
    try{await must(top,['fetch','--quiet','--prune',remote],{timeout:NET_TIMEOUT,network:true});}catch(error){fetchError=String(error.message);}
   }
   const baseHead=await opt(top,['rev-parse','--verify','--quiet',`${base}^{commit}`]);
   if(!baseHead)throw Error(`base branch "${base}" doesn't exist in this repository`);
   let ahead=0,behind=0;
   const counts=await opt(top,['rev-list','--left-right','--count',`HEAD...${base}`]);
   if(counts){const [a,b]=counts.split(/\s+/).map(Number);ahead=Number.isInteger(a)?a:0;behind=Number.isInteger(b)?b:0;}
   const dirty=await dirtyPaths(top);
   const probe={repo:top,branch,base,base_head:baseHead,behind,ahead,dirty:dirty.length,state:'current',conflicts:[],overlap:[],subjects:[],blocked:null,fetch_error:fetchError};
   const blocked=detached?'HEAD is detached — check out a branch to merge into':branch===base.split('/').at(-1)&&behind===0?`this is the ${base} branch itself`:await inProgress(top);
   if(blocked){probe.blocked=blocked;probe.state=behind===0?'current':'blocked';return probe;}
   if(behind===0)return probe;
   probe.subjects=((await opt(top,['log','--no-merges','--format=%s',`-${SUBJECT_LIMIT}`,`HEAD..${base}`]))??'').split('\n').filter(Boolean);
   if(dirty.length){
    let raw=null;try{raw=await read(top,['diff','--name-only','-z',`HEAD...${base}`]);}catch{}
    if(raw!=null){const incoming=new Set(nulFields(raw));probe.overlap=dirty.filter(p=>incoming.has(p)).slice(0,CONFLICT_LIMIT);}
   }
   const dry=await mergeTree(top,'HEAD',base);
   probe.state=dry.clean===true?'clean':dry.clean===false?'conflict':'unknown';
   if(dry.clean===false)probe.conflicts=dry.conflicts;
   return probe;
  },
  async git_sync_apply({repo,base}){
   const top=await repoPath(repo),{branch,detached}=await t.headBranch(top);
   if(detached)throw Error('HEAD is detached — check out a branch before merging');
   if(!branch)throw Error('no current branch to merge into');
   const busy=await inProgress(top);if(busy)throw Error(`can't merge: ${busy}`);
   base=typeof base==='string'?base.trim():'';
   if(!base)throw Error('no base branch to merge from');
   if(base===branch)throw Error("that's the branch you're on");
   checkedBase(base);
   if(!await ok(top,['rev-parse','--verify','--quiet',`${base}^{commit}`]))throw Error(`base branch "${base}" doesn't exist in this repository`);
   const r=await exec(top,['merge','--no-edit',base],{timeout:120000});
   const firstLine=s=>s.split('\n').map(l=>l.trim()).find(Boolean)??null;
   if(!r.code)return {merged:true,conflicts:[],message:firstLine(r.stdout)??`Merged ${base} into ${branch}`};
   // Unmerged paths: the merge started and stopped. None: git refused outright.
   let conflicts=[];try{conflicts=nulFields(await read(top,['diff','--name-only','--diff-filter=U','-z'])).slice(0,CONFLICT_LIMIT);}catch{}
   if(!conflicts.length)throw Error(r.stderr.trim()||r.stdout.trim());
   return {merged:false,conflicts,message:firstLine(r.stderr)??firstLine(r.stdout)??'merge stopped on conflicts'};
  },
  async git_sync_abort({repo}){
   const top=await repoPath(repo),dir=await opt(top,['rev-parse','--absolute-git-dir']);
   if(dir&&!await exists(path.join(dir,'MERGE_HEAD')))throw Error('no merge in progress');
   await must(top,['merge','--abort']);
   return 'Merge aborted — your branch is back as it was';
  },
  async git_pr_merge_probe({repo,candidates,fetch}){
   const top=await repoPath(repo);
   if(!Array.isArray(candidates)||candidates.length>64)throw Error('Invalid merge candidates');
   for(const c of candidates){
    if(!c||!Number.isInteger(c.number)||c.number<0||c.number>0xffffffff||typeof c.base_sha!=='string'||typeof c.head_sha!=='string'||typeof c.base!=='string')throw Error('Invalid merge candidates');
    if(c.base.trim())checkedRef(c.base);
   }
   const hasCommit=async oid=>/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(oid)&&await ok(top,['cat-file','-e',`${oid}^{commit}`]);
   const available=async c=>await hasCommit(c.head_sha)&&await hasCommit(c.base_sha);
   let fetchError=null;
   if(fetch){
    let missing=false;for(const c of candidates)if(!await available(c)){missing=true;break;}
    if(missing){
     const refs=new Set();for(const c of candidates){refs.add(`refs/pull/${c.number}/head`);if(c.base.trim())refs.add(`refs/heads/${c.base}`);}
     try{await must(top,['fetch','--quiet','--no-tags','--no-write-fetch-head','origin',...[...refs].sort()],{timeout:NET_TIMEOUT,network:true});}catch(error){fetchError=String(error.message);}
    }
   }
   const unavailable=[];for(const c of candidates)if(!await available(c))unavailable.push(c.number);
   const pairs=[];
   for(let i=0;i<candidates.length;i++){
    const first=candidates[i];if(unavailable.includes(first.number))continue;
    for(const second of candidates.slice(i+1)){if(unavailable.includes(second.number))continue;pairs.push(await pairProbe(top,first,second));}
   }
   return {repo:top,pairs,unavailable,fetch_error:fetchError};
  },
  async fs_repo_path({repo,path:rel}){
   const dir=await scoped(repo);
   if(!validRepoRel(rel))throw Error('invalid repo path');
   const base=await realpath(dir);
   let full;try{full=await realpath(path.join(base,rel));}catch{throw Error('file not found in this checkout');}
   if(!full.startsWith(base+'/'))throw Error('path leaves the repository');
   return scoped(full);
  },
  async fs_snapshot_files({roots,limit}){
   if(!Array.isArray(roots)||roots.length>64)throw Error('Invalid roots');
   const cap=Math.min(20000,Math.max(0,Math.trunc(Number(limit??20000))||0));
   const dirs=[];for(const r of roots)dirs.push(await scoped(r));
   const files=await listWorkspaceFiles([...new Set(dirs)],cap),out=[];
   // Bounded batches; a file that vanished since the walk is left out.
   for(let i=0;i<files.length;i+=64){
    const batch=await Promise.all(files.slice(i,i+64).map(file=>stat(file).then(info=>({path:file,size:info.size,modified_ms:Math.trunc(info.mtimeMs)}),()=>null)));
    for(const item of batch)if(item)out.push(item);
   }
   return out;
  },
 };

 // Cached by the two immutable heads, as sync.rs does.
 async function pairProbe(top,first,second){
  const firstLow=first.head_sha<=second.head_sha,[low,high]=firstLow?[first.head_sha,second.head_sha]:[second.head_sha,first.head_sha],key=low+':'+high;
  let value=PAIR_CACHE.get(key);
  if(!value){
   const dry=await mergeTree(top,low,high);
   value={...dry,lowHigh:await ok(top,['merge-base','--is-ancestor',low,high]),highLow:await ok(top,['merge-base','--is-ancestor',high,low])};
   if(PAIR_CACHE.size>=2048)PAIR_CACHE.clear();
   PAIR_CACHE.set(key,value);
  }
  return {first:first.number,second:second.number,clean:value.clean,conflicts:value.conflicts,first_ancestor_second:firstLow?value.lowHigh:value.highLow,second_ancestor_first:firstLow?value.highLow:value.lowHigh};
 }
}
const PAIR_CACHE=new Map();

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveWorkspacePath} from './workspace-file-paths.mjs';
import {gitOpsCommands,classifyCheckout,classifyExtra,stripGhNoise,remoteUnreachableFor,parseWorktrees,validRepoRel,isProtectedBranch,GIT_OPS_READ_ONLY} from './git-ops.mjs';

const execute=promisify(execFile);
Object.assign(process.env,{GIT_AUTHOR_NAME:'Ada',GIT_AUTHOR_EMAIL:'ada@example.com',GIT_COMMITTER_NAME:'Ada',GIT_COMMITTER_EMAIL:'ada@example.com',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'});
const sh=(cwd,...args)=>execute('git',args,{cwd}).then(r=>r.stdout.trim());
const exists=p=>access(p).then(()=>true,()=>false);
// The host's ctx over a temp "/workspace": run throws Error(stderr) like native.mjs.
function ctxFor(root,home=root){
 const scoped=(p,create=false)=>resolveWorkspacePath(p,{workspace:root,create});
 const run=async(bin,argv,cwd=root,timeout=15000)=>{try{return (await execute(bin,argv,{cwd:await scoped(cwd),timeout,env:process.env})).stdout;}catch(error){throw Error(String(error.stderr||'Workspace command failed'));}};
 return {run,scoped,home,root,execute};
}
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'git-ops-'))),repo=join(root,'repo');
 await mkdir(repo);await sh(repo,'init','-q','-b','main');
 await writeFile(join(repo,'a.txt'),'one\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','First');
 return {root,repo,ops:gitOpsCommands(ctxFor(root)),done:()=>rm(root,{recursive:true,force:true})};
}

test('classifiers read git refusals the way git.rs does',()=>{
 assert.deepEqual(classifyCheckout("fatal: 'feat/x' is already used by worktree at '/w/repo/.claude/worktrees/agent-1'"),{kind:'branch_in_worktree',path:'/w/repo/.claude/worktrees/agent-1'});
 assert.deepEqual(classifyCheckout('error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts\n\tsrc/index.css\nPlease commit your changes or stash them before you switch branches.\nAborting'),{kind:'local_changes',files:['src/app.ts','src/index.css'],untracked:false});
 assert.equal(classifyCheckout('error: The following untracked working tree files would be overwritten by checkout:\n\tnotes.md\nPlease move').untracked,true);
 assert.deepEqual(classifyCheckout('fatal: invalid reference: nope'),{kind:'unknown'});
 assert.deepEqual(classifyExtra('f.txt: needs merge\nerror: you need to resolve your current index first'),{kind:'mid_operation',op:'merge'});
 assert.deepEqual(classifyExtra("fatal: refusing to fetch into branch 'refs/heads/new' checked out at '/w/repo-wt-new'\nfailed to run git: exit status 128"),{kind:'branch_in_worktree',path:'/w/repo-wt-new'});
 assert.deepEqual(classifyExtra('fatal: cannot switch branch in the middle of an am session'),{kind:'mid_operation',op:'am'});
 assert.deepEqual(classifyExtra("fatal: a branch named 'feat/x' already exists"),{kind:'name_taken',branch:'feat/x'});
 assert.deepEqual(classifyExtra("fatal: '/w/canopy-wt-feat-x' already exists"),{kind:'path_in_use',path:'/w/canopy-wt-feat-x'});
 assert.deepEqual(classifyExtra("error: pathspec 'feat/x' did not match any file(s) known to git."),{kind:'nothing_called',name:'feat/x'});
 assert.deepEqual(classifyExtra('fatal: invalid reference: nope'),{kind:'nothing_called',name:'nope'});
 assert.deepEqual(classifyExtra('fatal: cannot remove a locked working tree, lock reason: review in progress\nuse'),{kind:'locked_workspace',path:'',reason:'review in progress'});
 assert.deepEqual(classifyExtra("fatal: Unable to create '/w/.git/index.lock': File exists."),{kind:'another_command'});
 for(const err of ["fatal: couldn't find remote ref pull/142/head",'no git remotes found',"timed out after 120s — remote unreachable, or it wants credentials this app can't prompt for"])assert.equal(classifyExtra(err).kind,'remote_unreachable');
 assert.equal(stripGhNoise('Aborting\nfailed to run git: exit status 1'),'Aborting');
 assert.equal(remoteUnreachableFor('To get started with GitHub CLI, please run: gh auth login').summary,"Canopy couldn't reach GitHub with the sign-in it has.");
 assert.match(remoteUnreachableFor("fatal: couldn't find remote ref pull/142/head",142).summary,/^GitHub doesn't have a copy of #142's changes/);
 const list=parseWorktrees('worktree /w/repo\nHEAD abc1234567\nbranch refs/heads/main\n\nworktree /w/repo-wt-gone\nHEAD def4567890\nbranch refs/heads/feat/x\nlocked review\n');
 assert.deepEqual(list.map(w=>[w.name,w.head,w.branch,w.is_main,w.locked]),[['repo','abc12345','main',true,null],['repo-wt-gone','def45678','feat/x',false,'review']]);
 for(const bad of ['','/etc/passwd','a/../b','.git/config','a\\b','%2e%2e/x','C:/x','a//b'])assert.equal(validRepoRel(bad),false,bad);
 assert.equal(validRepoRel('src/app.ts'),true);
 assert.equal(isProtectedBranch('trunk','origin/main'),true);assert.equal(isProtectedBranch('release','origin/release'),true);assert.equal(isProtectedBranch('feat','main'),false);
 assert.ok(GIT_OPS_READ_ONLY.every(c=>!/delete|discard|remove|apply/.test(c)));
});

test('switches come back as outcomes: detached look, carry, leftovers, nothing called',async()=>{
 const {repo,ops,done}=await fixture();
 try{
  const first=await sh(repo,'rev-parse','HEAD');
  await sh(repo,'checkout','-qb','feature');await writeFile(join(repo,'b.txt'),'b\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Feature');await sh(repo,'checkout','-q','main');
  assert.deepEqual(await ops.git_checkout_detached({repo,refname:first}),{kind:'switched',message:`Looking at ${first} — nothing moved`,path:null});
  await writeFile(join(repo,'loose.txt'),'x\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Loose');
  const left=await ops.git_checkout_detached({repo,refname:'main'});
  assert.equal(left.kind,'switched_with_leftovers');assert.match(left.commits[0],/ Loose$/);assert.match(left.detail,/^git branch saved-/);
  const missing=await ops.git_checkout_detached({repo,refname:'nope'});
  assert.deepEqual([missing.kind,missing.name,missing.can_create],['nothing_called','nope',true]);
  await assert.rejects(ops.git_checkout_detached({repo,refname:'  '}),/need a branch or commit/);
  await assert.rejects(ops.git_checkout_detached({repo,refname:'--orphan'}),/invalid ref/);
  await sh(repo,'checkout','-q','main');
  await writeFile(join(repo,'a.txt'),'edited\n');
  assert.deepEqual(await ops.git_checkout_carry({repo,branch:'feature'}),{kind:'switched',message:'Switched to feature with your changes',path:null});
  assert.equal(await readFile(join(repo,'a.txt'),'utf8'),'edited\n');assert.equal(await sh(repo,'branch','--show-current'),'feature');
  await sh(repo,'checkout','-q','main');
  // A conflicting merge leaves the repo mid-operation: switching is refused up front.
  await sh(repo,'checkout','-q','.');await writeFile(join(repo,'b.txt'),'main side\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Main b');
  await execute('git',['merge','feature'],{cwd:repo}).catch(()=>{});
  assert.equal((await ops.git_checkout_carry({repo,branch:'feature'})).operation,'merge');
  assert.equal(await ops.git_operation_quit({repo}),'Called it off — your files are exactly as you left them (merge)');
  assert.equal(await ops.git_operation_quit({repo}),'Nothing was half-finished');
 }finally{await done();}
});

test('worktrees: add, held branch, release, realign, remove and prune stay inside the workspace',async()=>{
 const {root,repo,ops,done}=await fixture();
 try{
  const wt=join(root,'repo-wt-feat');
  assert.deepEqual(await ops.git_worktree_add({repo,path:wt,branch:'feat',create:true}),{kind:'switched',message:`Workspace created at ${wt}`,path:wt});
  const held=await ops.git_worktree_add({repo,path:join(root,'other'),branch:'feat',create:false});
  assert.equal(held.kind,'branch_in_worktree');assert.equal(held.holder.path,wt);assert.equal(held.holder.is_main,false);
  assert.equal((await ops.git_checkout_carry({repo,branch:'feat'})).kind,'branch_in_worktree');
  const taken=await ops.git_worktree_add({repo,path:wt,branch:'feat2',create:true});
  assert.equal(taken.kind,'path_in_use');assert.equal(taken.usable,true);
  await assert.rejects(ops.git_worktree_add({repo,path:'/etc/canopy-wt',branch:'x',create:true}),/outside/);
  await assert.rejects(ops.git_worktree_add({repo,path:join(root,'w'),branch:'-b',create:true}),/invalid branch name/);
  const nested=join(repo,'.claude','worktrees','agent-1');
  assert.equal((await ops.git_worktree_add({repo,path:nested,branch:'agent-1',create:true})).kind,'switched');
  assert.equal((await ops.git_worktree_add({repo,path:join(root,'w2'),branch:'agent-1',create:false})).holder.agent,true);
  // Release frees the name and leaves that checkout detached at the same commit.
  assert.deepEqual(await ops.git_branch_release({repo,branch:'feat'}),{kind:'switched',message:'feat is free',path:null});
  assert.equal(await sh(wt,'branch','--show-current'),'');
  // Realign fast-forwards a clean workspace; refuses dirty ones and strangers.
  await writeFile(join(repo,'c.txt'),'c\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Advance');
  assert.equal(await ops.git_worktree_realign({repo,path:wt}),'Workspace fast-forwarded');
  assert.equal(await ops.git_worktree_realign({repo,path:wt}),'Workspace already current');
  await writeFile(join(wt,'dirty.txt'),'d\n');
  await assert.rejects(ops.git_worktree_realign({repo,path:wt}),/uncommitted changes/);
  await assert.rejects(ops.git_worktree_realign({repo,path:repo}),/not a workspace of this repository/);
  // Remove: dirty needs force; the main checkout and unknown folders are refused.
  await assert.rejects(ops.git_worktree_remove({repo,path:wt,force:0}),/untracked|modified/);
  await assert.rejects(ops.git_worktree_remove({repo,path:repo,force:2}),/not a workspace of this repository/);
  await assert.rejects(ops.git_worktree_remove({repo,path:join(root,'nowhere'),force:2}),/not a workspace of this repository/);
  assert.equal(await ops.git_worktree_remove({repo,path:wt,force:1}),'Workspace removed');
  assert.equal(await exists(wt),false);
  assert.equal(await ops.git_worktree_prune({repo}),'Nothing to clear');
  // A locked workspace whose folder is gone survives prune (git -v speaks on
  // stderr, which git.rs never reads), and release clears it with force.
  await sh(repo,'worktree','lock','--reason','review',nested);await rm(nested,{recursive:true,force:true});
  assert.equal(await ops.git_worktree_prune({repo}),"agent-1 is still recorded even though its folder is gone — it's locked, so clearing it takes force.");
  assert.deepEqual(await ops.git_branch_release({repo,branch:'agent-1'}),{kind:'switched',message:'agent-1 is free',path:null});
  assert.equal(await ops.git_worktree_prune({repo}),'Nothing to clear');
 }finally{await done();}
});

test('bootstrap carries ignored config and offers the install when nothing clones',async()=>{
 const {root,repo,ops,done}=await fixture();
 try{
  await writeFile(join(repo,'.gitignore'),'.env\nnode_modules/\n');await writeFile(join(repo,'package-lock.json'),'{}');await sh(repo,'add','.');await sh(repo,'commit','-qm','Ignore');
  await writeFile(join(repo,'.env'),'SECRET=1\n');
  const wt=join(root,'repo-wt-boot');await ops.git_worktree_add({repo,path:wt,branch:'boot',create:true});
  const config=await ops.git_worktree_bootstrap({repo,path:wt,phase:'config'});
  assert.deepEqual(config,{carried:['.env'],cloned:[],install:null,note:null});
  assert.equal(await readFile(join(wt,'.env'),'utf8'),'SECRET=1\n');
  const deps=await ops.git_worktree_bootstrap({repo,path:wt,phase:'deps'});
  assert.deepEqual(deps,{carried:[],cloned:[],install:'npm ci',note:'No dependencies installed in the main checkout to clone from.'});
  await mkdir(join(repo,'node_modules','left-pad'),{recursive:true});await writeFile(join(repo,'node_modules','left-pad','index.js'),'x');
  const cloned=await ops.git_worktree_bootstrap({repo,path:wt});
  // Reflink support depends on the filesystem: either cloned, or the install with the reason.
  if(cloned.cloned.length)assert.deepEqual(cloned.cloned,['node_modules']);else{assert.equal(cloned.install,'npm ci');assert.match(cloned.note,/^Couldn't clone dependencies: /);assert.equal(await exists(join(wt,'node_modules')),false);}
  await assert.rejects(ops.git_worktree_bootstrap({repo,path:join(root,'missing')}),/is not a directory/);
  await assert.rejects(ops.git_worktree_bootstrap({repo,path:root}),/not a workspace of this repository/);
 }finally{await done();}
});

test('discard, branch naming and deletion refuse what git.rs refuses',async()=>{
 const {root,repo,ops,done}=await fixture();
 try{
  await writeFile(join(repo,'a.txt'),'changed\n');await writeFile(join(repo,'new.txt'),'new\n');
  assert.equal(await ops.git_discard({repo,tracked:['a.txt'],untracked:['new.txt']}),null);
  assert.equal(await readFile(join(repo,'a.txt'),'utf8'),'one\n');assert.equal(await exists(join(repo,'new.txt')),false);
  await assert.rejects(ops.git_discard({repo,tracked:['../outside'],untracked:[]}),/outside repository/);
  const head=await sh(repo,'rev-parse','HEAD');
  assert.equal(await ops.git_branch_at({repo,name:'saved',commit:head}),'Saved as saved');
  await assert.rejects(ops.git_branch_at({repo,name:'',commit:head}),/need a name and a commit/);
  await assert.rejects(ops.git_branch_delete({repo,branch:'main',force:true}),/main is a protected branch/);
  await sh(repo,'checkout','-qb','work');
  await assert.rejects(ops.git_branch_delete({repo,branch:'work',force:true}),/the branch you're on/);
  await writeFile(join(repo,'w.txt'),'w\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Work');await sh(repo,'checkout','-q','main');
  await assert.rejects(ops.git_branch_delete({repo,branch:'work',force:false}),/not fully merged/);
  assert.equal(await ops.git_branch_delete({repo,branch:'work',force:true}),'Deleted work');
  await assert.rejects(ops.git_branch_delete({repo,branch:'a..b',force:true}),/invalid branch name/);
  // Remote deletion against a local bare origin: no network.
  const origin=join(root,'origin.git');await sh(root,'init','-q','--bare',origin);await sh(repo,'remote','add','origin',origin);await sh(repo,'push','-q','origin','main','saved');
  assert.equal(await ops.git_branch_delete_remote({repo,branch:'saved'}),'Deleted saved on GitHub');
  assert.equal(await sh(origin,'branch','--list','saved'),'');
  await assert.rejects(ops.git_branch_delete_remote({repo,branch:'main'}),/protected branch/);
 }finally{await done();}
});

test('read-only lookups: rev count, show at, share context, repo path, snapshot, work audit',async()=>{
 const {root,repo,ops,done}=await fixture();
 try{
  const first=await sh(repo,'rev-parse','HEAD');
  await writeFile(join(repo,'bin.dat'),Buffer.from([1,0,2]));await mkdir(join(repo,'src'));await writeFile(join(repo,'src','x.ts'),'x\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Second');
  const second=await sh(repo,'rev-parse','HEAD');
  assert.equal(await ops.git_rev_count({repo,from:first,to:second}),1);
  await assert.rejects(ops.git_rev_count({repo,from:'HEAD',to:second}),/invalid commit id/);
  assert.equal(await ops.git_show_at({repo,sha:first,path:'a.txt'}),'one\n');
  await assert.rejects(ops.git_show_at({repo,sha:second,path:'bin.dat'}),/binary file/);
  await assert.rejects(ops.git_show_at({repo,sha:first,path:'src/x.ts'}),new RegExp(`not in this checkout at ${first.slice(0,7)}`));
  await assert.rejects(ops.git_show_at({repo,sha:second,path:'src'}),/is not a file at/);
  await assert.rejects(ops.git_show_at({repo,sha:second,path:'../a.txt'}),/invalid repo path/);
  await writeFile(join(repo,'src','x.ts'),'dirty\n');
  assert.deepEqual(await ops.git_share_context({path:join(repo,'src','x.ts')}),{root:repo,rel:'src/x.ts',head:second,origin:'',dirty:true});
  assert.deepEqual(await ops.git_share_context({path:repo}),{root:repo,rel:'',head:second,origin:'',dirty:false});
  assert.equal(await ops.fs_repo_path({repo,path:'src/x.ts'}),join(repo,'src','x.ts'));
  await assert.rejects(ops.fs_repo_path({repo,path:'nope.ts'}),/file not found in this checkout/);
  await assert.rejects(ops.fs_repo_path({repo,path:'../x'}),/invalid repo path/);
  const snap=await ops.fs_snapshot_files({roots:[repo]});
  const x=snap.find(f=>f.path===join(repo,'src','x.ts'));assert.equal(x.size,6);assert.ok(Number.isInteger(x.modified_ms));
  assert.ok(!snap.some(f=>f.path.includes('/.git/')));
  assert.equal((await ops.fs_snapshot_files({roots:[repo],limit:1})).length,1);
  await assert.rejects(ops.fs_snapshot_files({roots:['/etc']}),/outside/);
  await sh(repo,'branch','merged-one',first);await sh(repo,'checkout','-qb','ahead');await writeFile(join(repo,'z.txt'),'z\n');await sh(repo,'add','z.txt');await sh(repo,'commit','-qm','Ahead work');
  const audit=await ops.git_work_audit({repo});
  assert.equal(audit.base,'main');assert.equal(typeof audit.counts_degraded,'boolean');
  const by=Object.fromEntries(audit.items.map(i=>[i.branch,i]));
  assert.deepEqual(Object.keys(by).sort(),['ahead','main','merged-one']);
  assert.equal(by.main.protected,true);assert.equal(by.main.is_main,false);assert.equal(by.ahead.current,true);assert.equal(by.ahead.worktree,repo);assert.equal(by.ahead.dirty,1);
  assert.equal(by['merged-one'].merged,true);assert.equal(by.ahead.merged,false);assert.equal(by.ahead.subject,'Ahead work');assert.equal(by.ahead.author,'Ada');assert.equal(by.ahead.upstream,null);
  if(!audit.counts_degraded)assert.equal(by.ahead.ahead,1);
 }finally{await done();}
});

test('sync probes without writing, applies on request, and aborts a conflicted merge',async()=>{
 const {repo,ops,done}=await fixture();
 try{
  await sh(repo,'checkout','-qb','feature');await writeFile(join(repo,'f.txt'),'f\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Feature');
  await sh(repo,'checkout','-q','main');await writeFile(join(repo,'m.txt'),'m\n');await sh(repo,'add','.');await sh(repo,'commit','-qm','Main moves');await sh(repo,'checkout','-q','feature');
  const clean=await ops.git_sync_probe({repo,fetch:false,base:null});
  assert.deepEqual({state:clean.state,behind:clean.behind,ahead:clean.ahead,base:clean.base,branch:clean.branch,subjects:clean.subjects,blocked:clean.blocked,fetch_error:clean.fetch_error},{state:'clean',behind:1,ahead:1,base:'main',branch:'feature',subjects:['Main moves'],blocked:null,fetch_error:null});
  assert.equal(clean.base_head,await sh(repo,'rev-parse','main'));
  await assert.rejects(ops.git_sync_probe({repo,fetch:false,base:'nope'}),/base branch "nope" doesn't exist/);
  const applied=await ops.git_sync_apply({repo,base:'main'});
  assert.equal(applied.merged,true);assert.deepEqual(applied.conflicts,[]);
  assert.equal((await ops.git_sync_probe({repo,fetch:false})).state,'current');
  await sh(repo,'checkout','-q','main');await writeFile(join(repo,'a.txt'),'main side\n');await sh(repo,'commit','-qam','Main a');
  await sh(repo,'checkout','-q','feature');await writeFile(join(repo,'a.txt'),'feature side\n');await sh(repo,'commit','-qam','Feature a');
  await writeFile(join(repo,'a.txt'),'uncommitted\n');
  const conflict=await ops.git_sync_probe({repo,fetch:false});
  assert.equal(conflict.state,'conflict');assert.deepEqual(conflict.conflicts,['a.txt']);assert.deepEqual(conflict.overlap,['a.txt']);assert.equal(conflict.dirty,1);
  await sh(repo,'checkout','-q','a.txt');
  await assert.rejects(ops.git_sync_abort({repo}),/no merge in progress/);
  const stopped=await ops.git_sync_apply({repo,base:'main'});
  assert.equal(stopped.merged,false);assert.deepEqual(stopped.conflicts,['a.txt']);
  assert.equal((await ops.git_sync_probe({repo,fetch:false})).blocked,'a merge is already in progress here');
  await assert.rejects(ops.git_sync_apply({repo,base:'main'}),/can't merge: a merge is already in progress here/);
  assert.equal(await ops.git_sync_abort({repo}),'Merge aborted — your branch is back as it was');
  await assert.rejects(ops.git_sync_apply({repo,base:'feature'}),/that's the branch you're on/);
  await assert.rejects(ops.git_sync_apply({repo,base:'--strategy=x'}),/invalid base branch/);
 }finally{await done();}
});

test('PR workspaces and merge probes fetch pull heads from origin',async()=>{
 const {root,repo,ops,done}=await fixture();
 try{
  const origin=join(root,'origin.git');await sh(root,'init','-q','--bare',origin);await sh(repo,'remote','add','origin',origin);await sh(repo,'push','-q','origin','main');
  const base=await sh(repo,'rev-parse','HEAD'),heads=[];
  for(const [n,text] of [[7,'seven\n'],[8,'eight\n'],[9,'one\n']]){
   await sh(repo,'checkout','-q','--detach',base);await writeFile(join(repo,n===9?'nine.txt':'a.txt'),text);await sh(repo,'add','.');await sh(repo,'commit','-qm',`PR ${n}`);
   const head=await sh(repo,'rev-parse','HEAD');heads.push(head);await sh(repo,'push','-q','origin',`${head}:refs/pull/${n}/head`);
  }
  await sh(repo,'checkout','-q','main');
  // Drop the local objects so the probe has to fetch them.
  for(const n of [7,8,9])await sh(repo,'update-ref','-d',`refs/pull/${n}/head`).catch(()=>{});
  await sh(repo,'reflog','expire','--expire=now','--all');await sh(repo,'gc','-q','--prune=now');
  const wt=join(root,'repo-wt-pr-7');
  assert.deepEqual(await ops.git_worktree_add_pr({repo,path:wt,number:7,branch:'pr-branch'}),{kind:'switched',message:`Workspace created at ${wt}, at #7's head`,path:wt});
  assert.equal(await sh(wt,'rev-parse','HEAD'),heads[0]);
  const gone=await ops.git_worktree_add_pr({repo,path:join(root,'repo-wt-pr-99'),number:99,branch:'x'});
  assert.equal(gone.kind,'remote_unreachable');assert.match(gone.summary,/#99's changes/);
  const again=await ops.git_worktree_add_pr({repo,path:wt,number:7,branch:'pr-branch'});
  assert.deepEqual([again.kind,again.usable],['path_in_use',true]);
  const candidates=[7,8,9].map((number,i)=>({number,branch:`b${number}`,base:'main',base_sha:base,head_sha:heads[i]}));
  const plan=await ops.git_pr_merge_probe({repo,candidates,fetch:true});
  assert.equal(plan.fetch_error,null);assert.deepEqual(plan.unavailable,[]);
  const pair=(a,b)=>plan.pairs.find(p=>p.first===a&&p.second===b);
  assert.deepEqual([pair(7,8).clean,pair(7,8).conflicts],[false,['a.txt']]);
  assert.equal(pair(7,9).clean,true);assert.equal(pair(7,9).first_ancestor_second,false);
  const offline=await ops.git_pr_merge_probe({repo,candidates:[{number:5,branch:'x',base:'main',base_sha:base,head_sha:'f'.repeat(40)}],fetch:false});
  assert.deepEqual(offline.unavailable,[5]);
  await assert.rejects(ops.git_pr_merge_probe({repo,candidates:[{number:1,base:'-x',base_sha:base,head_sha:base}],fetch:true}),/invalid branch name/);
 }finally{await done();}
});

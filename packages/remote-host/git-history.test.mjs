import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeGitRead} from './git-read.mjs';
import {gitHistory,checkedHash,checkedRef,truncatePatch,patchStats,MAX_PATCH_BYTES} from './git-history.mjs';

const execute=promisify(execFile);
const sh=(cwd,...args)=>execute('git',args,{cwd,env:{...process.env,GIT_AUTHOR_NAME:'Ada',GIT_AUTHOR_EMAIL:'ada@example.com',GIT_COMMITTER_NAME:'Ada',GIT_COMMITTER_EMAIL:'ada@example.com'}}).then(r=>r.stdout.trim());
// The same wrapper native.mjs builds, over a real repository.
const historyFor=root=>gitHistory({git:async(argv,cwd,{maxBuffer=1024*1024,partial=false,allowDiffExit=false}={})=>{
 try{const {stdout}=await safeGitRead(execute,argv,{allowedRoot:root,cwd,maxBuffer,env:process.env});return partial?{stdout,partial:false}:stdout;}
 catch(error){
  if(partial&&error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return {stdout:error.stdout,partial:true};
  if(allowDiffExit&&error.code===1)return error.stdout;
  throw error;
 }
}});

async function repo(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'git-history-')));
 await sh(root,'init','-q','-b','main');
 await writeFile(join(root,'a.txt'),'one\ntwo\n');await sh(root,'add','.');await sh(root,'commit','-q','-m','First','-m','Body line');
 await writeFile(join(root,'a.txt'),'one\nTWO\nthree\n');await sh(root,'commit','-qam','Second');
 return root;
}

test('commit detail and patch match the desktop shape',async()=>{
 const root=await repo();
 try{
  const history=historyFor(root),hash=await sh(root,'rev-parse','HEAD'),first=await sh(root,'rev-parse','HEAD~1');
  const detail=await history.commitDetail({repo:root,hash});
  assert.equal(detail.hash,hash);assert.equal(detail.subject,'Second');assert.equal(detail.author,'Ada');assert.equal(detail.email,'ada@example.com');assert.deepEqual(detail.parents,[first]);
  assert.equal((await history.commitDetail({repo:root,hash:first})).body,'Body line');
  const patch=await history.commitPatch({repo:root,hash});
  assert.match(patch.patch,/^diff --git a\/a.txt b\/a.txt/);
  assert.deepEqual({files:patch.files_changed,adds:patch.insertions,dels:patch.deletions,truncated:patch.truncated},{files:1,adds:2,dels:1,truncated:false});
  await assert.rejects(history.commitPatch({repo:root,hash:'HEAD@{1}'}),/invalid commit hash/);
  await assert.rejects(history.commitPatch({repo:root,hash:'--output=/tmp/x'}),/invalid commit hash/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a patch past the cap is cut on a line boundary, with counts for the whole commit',async()=>{
 const root=await repo();
 try{
  await writeFile(join(root,'big.txt'),Array.from({length:120000},(_,i)=>`line ${i} ${'x'.repeat(20)}`).join('\n')+'\n');
  await sh(root,'add','big.txt');await sh(root,'commit','-q','-m','Big');
  const patch=await historyFor(root).commitPatch({repo:root,hash:await sh(root,'rev-parse','HEAD')});
  assert.equal(patch.truncated,true);
  assert.ok(Buffer.byteLength(patch.patch)<=MAX_PATCH_BYTES);assert.ok(patch.patch.endsWith('\n'));
  assert.deepEqual([patch.files_changed,patch.insertions,patch.deletions],[1,120000,0]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('branch commits and patch are measured against the base; uncommitted includes new files',async()=>{
 const root=await repo();
 try{
  await sh(root,'checkout','-q','-b','feature');
  await writeFile(join(root,'b.txt'),'new\n');await sh(root,'add','b.txt');await sh(root,'commit','-q','-m','Feature work');
  const history=historyFor(root);
  const commits=await history.branchCommits({repo:root,branch:'feature'});
  assert.deepEqual(commits.map(c=>c.subject),['Feature work']);
  assert.equal(commits[0].author,'Ada');
  const committed=await history.branchPatch({repo:root,branch:'feature',worktree:null,uncommitted:false});
  assert.deepEqual([committed.files_changed,committed.insertions],[1,1]);
  await writeFile(join(root,'a.txt'),'changed\n');await writeFile(join(root,'fresh.txt'),'untracked\n');
  const pending=await history.branchPatch({repo:root,branch:'feature',worktree:null,uncommitted:true});
  assert.match(pending.patch,/a\/a.txt/);assert.match(pending.patch,/fresh.txt/);assert.match(pending.patch,/\+untracked/);
  assert.equal(pending.files_changed,2);
  await assert.rejects(history.branchPatch({repo:root,branch:'feature',worktree:'/etc',uncommitted:true}),/not a worktree of this repository/);
  await assert.rejects(history.branchCommits({repo:root,branch:'main..evil'}),/invalid branch name/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('input checks and helpers',()=>{
 assert.equal(checkedHash(' ABCdef12 '),'ABCdef12');
 for(const bad of ['','HEAD','abc def','a'.repeat(65)])assert.throws(()=>checkedHash(bad),/invalid commit hash/);
 assert.equal(checkedRef('feat/x'),'feat/x');
 for(const bad of ['-x','a..b','a b','a~1','a^','a:b'])assert.throws(()=>checkedRef(bad),/invalid branch name/);
 const cut=truncatePatch('ab\ncdé\nf\n',6);assert.deepEqual(cut,{patch:'ab\n',truncated:true});
 assert.deepEqual(patchStats('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'),{files:1,adds:1,dels:1});
});

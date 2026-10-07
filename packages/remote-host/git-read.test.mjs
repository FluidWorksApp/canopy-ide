import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {safeGitRead} from './git-read.mjs';
const execute=promisify(execFile);
test('real Git automatic status/diff/log cannot execute shared fsmonitor, clean filters, textconv or external diff',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'canopy-untrusted-git-'));try{
  const git=args=>execute('git',args,{cwd:dir,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  await git(['init']);await git(['config','user.name','Synthetic']);await git(['config','user.email','synthetic@example.invalid']);await writeFile(path.join(dir,'file.txt'),'original\n');await git(['add','file.txt']);await git(['commit','-m','synthetic']);
  const marker=path.join(dir,'EXECUTED'),script=path.join(dir,'evil.sh');await writeFile(script,`#!/bin/sh\nprintf executed >> '${marker}'\ncat\n`,{mode:0o700});
  await git(['config','core.fsmonitor',script]);await git(['config','filter.evil.clean',script]);await git(['config','filter.evil.process',script]);await git(['config','filter.evil.required','true']);await git(['config','diff.evil.textconv',script]);await git(['config','diff.external',script]);await writeFile(path.join(dir,'.gitattributes'),'*.txt filter=evil diff=evil\n');await writeFile(path.join(dir,'file.txt'),'changed\n');
  for(const args of [['status','--porcelain'],['diff','--','file.txt'],['show','HEAD:file.txt'],['log','-1','--oneline']])await safeGitRead(execute,args,{allowedRoot:dir,cwd:dir,env:process.env,maxBuffer:1024*1024,timeout:10000});
  await assert.rejects(access(marker));
  await git(['config','core.worktree',os.tmpdir()]);await assert.rejects(safeGitRead(execute,['status','--porcelain'],{allowedRoot:dir,cwd:dir,env:process.env,timeout:10000}),/outside the workspace/);
  assert.equal(await readFile(path.join(dir,'file.txt'),'utf8'),'changed\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});

import test from 'node:test';import assert from 'node:assert/strict';
import {gitIdentityEnvironment,validateGitIdentity} from './git-identity.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
test('Git commits use member attribution independently of repository identity',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'canopy-git-member-'));
 const git=(args,env={})=>execFileSync('git',args,{cwd:directory,env:{...process.env,...env},encoding:'utf8'}).trim();
 try{
  git(['init','-q']);git(['config','user.name','Repository Owner']);git(['config','user.email','owner@example.invalid']);
  await writeFile(path.join(directory,'work.txt'),'member work');git(['add','work.txt']);
  git(['-c','commit.gpgsign=false','commit','-qm','Member change'],gitIdentityEnvironment({name:'Ada Member',email:'ada@example.invalid'}));
  assert.equal(git(['log','-1','--format=%an <%ae> / %cn <%ce>']),'Ada Member <ada@example.invalid> / Ada Member <ada@example.invalid>');
  assert.equal(git(['config','user.email']),'owner@example.invalid');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('Git identities cannot inject environment keys or invalid author headers',()=>{
 for(const identity of [null,{name:'Ada',email:'ada\x00@example.invalid'},{name:'Ada\nowner',email:'ada@example.invalid'},{name:'Ada',email:'ada@example.invalid\nGIT_CONFIG=x'},{name:'Ada <owner>',email:'ada@example.invalid'}])assert.throws(()=>validateGitIdentity(identity));
 assert.deepEqual(Object.keys(gitIdentityEnvironment({name:'Ada',email:'ada@example.invalid'})).sort(),['GIT_AUTHOR_EMAIL','GIT_AUTHOR_NAME','GIT_COMMITTER_EMAIL','GIT_COMMITTER_NAME']);
});

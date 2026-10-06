import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {sharedGitArguments,sharedGitInvocations} from './shared-git-launch.mjs';
const exec=promisify(execFile),config={url:'https://workspace.example/v1/agent-sessions/scoped/git',token:'s'.repeat(43),repository:'team/project'};
test('real Git configuration targets exact shared remote and leaves personal similar-name remote untouched',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'shared-git-'));const git=(args)=>exec('/usr/bin/git',args,{cwd:directory});
 try{
  await git(['init']);await git(['remote','add','origin','https://github.com/team/project.git']);await git(['remote','add','personal','https://github.com/team/project-other.git']);
  const remotes=[{name:'origin',url:'https://github.com/team/project.git'},{name:'personal',url:'https://github.com/team/project-other.git'}];
  const args=sharedGitArguments(['remote','get-url','origin'],config,remotes);assert.equal((await git(args)).stdout.trim(),config.url);
  assert.equal((await git(sharedGitArguments(['remote','get-url','personal'],config,remotes))).stdout.trim(),'https://github.com/team/project-other.git');
  assert.equal(sharedGitArguments(['clone','https://github.com/team/project'],config).at(-1),config.url);
  assert.equal(sharedGitArguments(['clone','https://github.com/team/project-other'],config).at(-1),'https://github.com/team/project-other');
  const all=sharedGitInvocations(['fetch','--all','--prune'],config,remotes);assert.equal(all.length,2);assert.ok(all[0].includes('url.'+config.url+'.insteadOf=https://github.com/team/project.git'));assert.ok(!all[1].some(value=>value.startsWith('url.')));assert.deepEqual(all[0].slice(-3),['fetch','origin','--prune']);assert.deepEqual(all[1].slice(-3),['fetch','personal','--prune']);
  assert.equal(sharedGitInvocations(['fetch','--all'],config,[remotes[0],{...remotes[1],skipFetchAll:true}]).length,1);
  assert.ok(!args.includes('credential.helper='));await assert.rejects(git(sharedGitArguments(['remote','get-url','unknown'],config,remotes)));
 }finally{await rm(directory,{recursive:true,force:true});}
});

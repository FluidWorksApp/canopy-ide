import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {agentWorkspaceAt} from './agent-workspace.mjs';
const exec=promisify(execFile);
test('agent workspace inspects feature branch, dirty files and refuses unrelated repositories',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'canopy-agent-view-'))),repo=path.join(root,'repo'),other=path.join(root,'other');
 const run=async(bin,args,cwd)=> (await exec(bin,args,{cwd})).stdout;
 const scoped=async p=>{assert.ok(p===root||p.startsWith(root+'/'));return p;};
 try{
 await exec('git',['init','-b','main',repo]);await exec('git',['init','-b','main',other]);
 await run('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','base'],repo);
 await run('git',['checkout','-b','feature'],repo);await writeFile(path.join(repo,'change.txt'),'one');await run('git',['add','.'],repo);await run('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','feature work'],repo);await writeFile(path.join(repo,'change.txt'),'two');
 const result=await agentWorkspaceAt({repo,cwd:repo,agent:'claude'},{run,scoped});assert.equal(result.branch,'feature');assert.equal(result.dirty,1);assert.equal(result.ahead,1);assert.equal(result.behind,0);assert.equal(result.on_base,false);assert.equal(result.commits[0].subject,'feature work');assert.equal(result.active_secs,null);assert.equal(result.unpushed,null);
 await assert.rejects(agentWorkspaceAt({repo,cwd:other},{run,scoped}),/another repository/);
 }finally{await rm(root,{recursive:true,force:true});}
});

import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {agentWorkspaceAt,agentWorkspaceCommands,AGENT_WORKSPACE_READ_ONLY} from './agent-workspace.mjs';
import {resolveWorkspacePath} from './workspace-file-paths.mjs';
const exec=promisify(execFile);
const git=(cwd,...args)=>exec('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args],{cwd}).then(r=>r.stdout.trim());
async function fixture(){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'canopy-agent-view-'))),repo=path.join(root,'repo'),other=path.join(root,'other'),home=path.join(root,'home');
 await exec('git',['init','-b','main',repo]);await exec('git',['init','-b','main',other]);await mkdir(path.join(home,'.canopy','sessions'),{recursive:true});
 await git(repo,'commit','--allow-empty','-m','base');
 await git(repo,'checkout','-b','feature');await writeFile(path.join(repo,'change.txt'),'one\n');await git(repo,'add','.');await git(repo,'commit','-m','feature work');await writeFile(path.join(repo,'change.txt'),'two\n');
 const scoped=(p,create=false)=>resolveWorkspacePath(p,{workspace:root,create});
 const run=async(bin,args,cwd=root)=>{try{return (await exec(bin,args,{cwd:await scoped(cwd)})).stdout;}catch(error){throw Error(String(error.stderr||'Workspace command failed'));}};
 return {root,repo,other,home,ctx:{run,scoped,home,root,execute:exec},done:()=>rm(root,{recursive:true,force:true})};
}
test('agent workspace at a cwd: feature branch, dirty files; an unrelated cwd degrades instead of failing',async()=>{
 const {repo,other,ctx,done}=await fixture();
 try{
  // native.mjs still passes only {run,scoped}: the git view needs nothing else.
  const result=await agentWorkspaceAt({repo,cwd:repo,agent:'claude'},{run:ctx.run,scoped:ctx.scoped});
  assert.equal(result.branch,'feature');assert.equal(result.dirty,1);assert.equal(result.ahead,1);assert.equal(result.behind,0);assert.equal(result.on_base,false);assert.equal(result.commits[0].subject,'feature work');assert.match(result.commits[0].date,/^\d{4}-\d\d-\d\d$/);
  assert.deepEqual([result.active_secs,result.unpushed,result.workdir,result.isolated,result.session_id,result.agent,result.base],[null,null,repo,false,'','claude','main']);
  const stray=await agentWorkspaceAt({repo,cwd:other},ctx);
  assert.deepEqual([stray.workdir,stray.cwd_missing,stray.dirty,stray.branch],[null,false,0,null]);
  const gone=await agentWorkspaceAt({repo,cwd:path.join(repo,'gone')},ctx);
  assert.equal(gone.cwd_missing,true);
  await assert.rejects(agentWorkspaceAt({repo:'/etc',cwd:repo},ctx),/outside/);
 }finally{await done();}
});
test('agent workspace from a hook digest, and agent edits from its journal',async()=>{
 const {root,repo,home,ctx,done}=await fixture();
 try{
  const commands=agentWorkspaceCommands(ctx),sessions=path.join(home,'.canopy','sessions');
  assert.deepEqual(Object.keys(commands).sort(),[...AGENT_WORKSPACE_READ_ONLY].sort());
  await assert.rejects(commands.agent_workspace({repo,sessionId:'s-1'}),/no digest for this session/);
  await assert.rejects(commands.agent_workspace({repo,sessionId:'../x'}),/invalid session id/);
  const wt=path.join(root,'repo-wt-agent');await git(repo,'worktree','add','-b','agent-branch',wt);
  await writeFile(path.join(sessions,'s-1.json'),JSON.stringify({session_id:'s-1',agent:'claude',state:'working',state_via:'hook',updated:1700000000,files:['change.txt',3],cwd:wt,branch:'stale',active_secs:42}));
  const view=await commands.agent_workspace({repo,sessionId:'s-1'});
  assert.deepEqual([view.agent,view.state,view.state_via,view.updated,view.active_secs,view.run_secs,view.touched],['claude','working','hook',1700000000,42,null,['change.txt']]);
  assert.deepEqual([view.workdir,view.isolated,view.branch,view.detached,view.on_base,view.cwd_missing],[wt,true,'agent-branch',false,false,false]);
  // Gone cwd: the digest's branch still names the work.
  await writeFile(path.join(sessions,'s-2.json'),JSON.stringify({agent:'codex',cwd:path.join(root,'deleted'),branch:'feature'}));
  const stale=await commands.agent_workspace({repo,sessionId:'s-2'});
  assert.deepEqual([stale.cwd_missing,stale.workdir,stale.branch,stale.ahead,stale.commits.length],[true,null,'feature',1,1]);
  const enriched=await commands.agent_workspace_at({repo,cwd:repo,agent:'amp',sessionId:'s-1'});
  assert.deepEqual([enriched.agent,enriched.state,enriched.session_id],['amp','working','s-1']);
  // Journal: present when the new text is still there; outside paths never read.
  assert.deepEqual(await commands.agent_edits({repo,sessionId:'none'}),[]);
  await writeFile(path.join(root,'outside.txt'),'two\n');
  await writeFile(path.join(sessions,'s-1.edits.jsonl'),[
   {ts:1,path:path.join(repo,'change.txt'),tool:'Edit',old:'one',new:'two'},
   {ts:2,path:path.join(repo,'change.txt'),tool:'Edit',old:'two',new:'three'},
   {ts:3,path:path.join(root,'outside.txt'),tool:'Write',new:'two'},
   'not json',
   {ts:4,path:path.join(repo,'change.txt'),tool:'Edit',new:'tw\n…(truncated)'},
  ].map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n')+'\n');
  const edits=await commands.agent_edits({repo,sessionId:'s-1'});
  assert.deepEqual(edits.map(e=>[e.ts,e.path,e.tool,e.old,e.present]),[[1,'change.txt','Edit','one',true],[2,'change.txt','Edit','two',false],[3,path.join(root,'outside.txt'),'Write',null,false],[4,'change.txt','Edit',null,true]]);
  const noRepo=await commands.agent_edits({repo:null,sessionId:'s-1'});
  assert.equal(noRepo[0].path,path.join(repo,'change.txt'));assert.equal(noRepo[0].present,false);
  await assert.rejects(commands.agent_edits({repo,sessionId:'a/b'}),/invalid session id/);
 }finally{await done();}
});

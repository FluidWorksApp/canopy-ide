import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink,utimes,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveWorkspacePath} from './workspace-file-paths.mjs';
import {safeGitRead,GIT_READ_COMMANDS} from './git-read.mjs';
import {workspaceCleanupCommands,WORKSPACE_CLEANUP_READ_ONLY,verdict,classify} from './workspace-cleanup.mjs';

const execute=promisify(execFile);
const env={...process.env,GIT_AUTHOR_NAME:'Ada',GIT_AUTHOR_EMAIL:'ada@example.com',GIT_COMMITTER_NAME:'Ada',GIT_COMMITTER_EMAIL:'ada@example.com'};
const sh=(cwd,...args)=>execute('git',args,{cwd,env}).then(r=>r.stdout.trim());
const OLD=Date.now()/1000-60*86400;

async function fixture(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'ws-cleanup-'))),root=join(base,'workspace'),home=join(base,'home');
 await mkdir(root);await mkdir(home);
 const run=async(cmd,argv,cwd=root,timeout=15000)=>{const options={allowedRoot:root,cwd:await resolveWorkspacePath(cwd,{workspace:root}),timeout,env:{...process.env,HOME:home}};try{return (await (cmd==='git'&&GIT_READ_COMMANDS.has(argv[0])?safeGitRead(execute,argv,options):execute(cmd,argv,options))).stdout;}catch(error){throw Error(String(error.stderr||'Workspace command failed'));}};
 const ctx={run,execute,home,root,scoped:(v,create=false)=>resolveWorkspacePath(v,{workspace:root,create})};
 const put=async(p,body='x',old=true)=>{await mkdir(join(p,'..'),{recursive:true});await writeFile(p,body);if(old)await utimes(p,OLD,OLD);};
 return {base,root,home,ctx,put,cmds:workspaceCleanupCommands(ctx),done:()=>rm(base,{recursive:true,force:true})};
}
// A repo with an old commit, an ignored node_modules + dist, a tracked dist, and a merged worktree.
async function project(f){
 const app=join(f.root,'app');await mkdir(app);
 await sh(app,'init','-q','-b','main');
 await f.put(join(app,'package.json'),'{}');await f.put(join(app,'.gitignore'),'node_modules\n__pycache__\n.claude\ntarget\n');
 await f.put(join(app,'web/package.json'),'{}');await f.put(join(app,'web/dist/keep.js'),'tracked');
 await sh(app,'add','.');
 await execute('git',['commit','-q','-m','init'],{cwd:app,env:{...env,GIT_AUTHOR_DATE:`@${Math.floor(OLD)}`,GIT_COMMITTER_DATE:`@${Math.floor(OLD)}`}});
 await f.put(join(app,'node_modules/left-pad/index.js'),'x'.repeat(1000));
 await f.put(join(app,'src/__pycache__/m.pyc'),'y'.repeat(10),false);
 await f.put(join(app,'target/out'),'no Cargo.toml here');
 await sh(app,'worktree','add','-q','-b','feature',join(app,'.claude/worktrees/feature'));
 await f.put(join(app,'.claude/worktrees/feature/node_modules/a.js'),'z'.repeat(500));
 return app;
}

test('read-only list',()=>assert.deepEqual(WORKSPACE_CLEANUP_READ_ONLY.sort(),['cleanup_disk','cleanup_scan']));

test('verdict mirrors the desktop rules',()=>{
 const idle=d=>({busy:false,asleep:false,dirty:0,idle_days:d,landed:null});
 assert.deepEqual(verdict({...idle(400),busy:true},'deps',400),[false,'a terminal or agent is live in this workspace']);
 assert.deepEqual(verdict({...idle(5),dirty:1},'deps',40),[false,'1 uncommitted file here']);
 assert.deepEqual(verdict({...idle(5),landed:'already merged into main'},'build',0),[true,null]);
 assert.deepEqual(verdict(idle(40),'deps',1),[false,'written yesterday']);
 assert.deepEqual(verdict(idle(5),'cache',10),[true,null]);
 assert.deepEqual(verdict(idle(5),'deps',10),[false,'last commit 5 days ago']);
 assert.deepEqual(verdict(idle(null),'deps',10),[false,'not a git checkout — no history to judge by']);
});

test('cleanup_scan finds ignored artifacts per checkout with the desktop shape',async()=>{
 const f=await fixture();
 try{
  const app=await project(f);
  const out=await f.cmds.cleanup_scan({roots:[app,'/etc'],busy:[],asleep:[]});
  assert.deepEqual(Object.keys(out).sort(),['bytes','recommended_bytes','skipped','targets','truncated','workspaces']);
  assert.match(out.skipped[0],/^\/etc — not in this window's scope/);
  assert.deepEqual(out.workspaces.map(w=>[w.name,w.main,w.branch]),[['app',true,'main'],['feature',false,'feature']]);
  const feature=out.workspaces[1];
  assert.equal(feature.landed,'already merged into main');
  const rels=out.targets.map(t=>[t.workspace.endsWith('feature')?'feature':'app',t.rel,t.category,t.recommended]);
  assert.deepEqual(rels,[['app','node_modules','deps',true],['app','src/__pycache__','cache',false],['feature','node_modules','deps',true]]);
  const nm=out.targets[0];
  assert.deepEqual(Object.keys(nm).sort(),['bytes','category','files','hold','idle_days','name','partial','path','recommended','regenerate','rel','workspace'].sort());
  assert.equal(nm.bytes,1000);assert.equal(nm.regenerate,'npm install');assert.ok(nm.idle_days>=59);
  assert.equal(out.targets[1].hold,'written today');
  assert.equal(out.bytes,1510);assert.equal(out.recommended_bytes,1500);
  // Busy and dirty both take rows out of the default selection.
  await f.put(join(app,'new.txt'),'u');
  const dirty=await f.cmds.cleanup_scan({roots:[app],busy:[],asleep:[]});
  assert.equal(dirty.targets.find(t=>t.workspace===app&&t.name==='node_modules').hold,'1 uncommitted file here');
  const busy=await f.cmds.cleanup_scan({roots:[app],busy:[join(app,'.claude/worktrees/feature')],asleep:[]});
  assert.equal(busy.targets.find(t=>t.workspace!==app).hold,'a terminal or agent is live in this workspace');
  await assert.rejects(f.cmds.cleanup_scan({roots:[],busy:[],asleep:[]}),/no project folders to scan/);
  await assert.rejects(f.cmds.cleanup_scan({roots:['/etc'],busy:[],asleep:[]}),/nothing to scan/);
 }finally{await f.done();}
});

test('cleanup_run deletes or trashes only allowlisted directories',async()=>{
 const f=await fixture();
 try{
  const app=await project(f);
  await f.put(join(f.base,'outside/node_modules/x'),'x');await f.put(join(f.base,'outside/package.json'),'{}');
  await symlink(join(f.base,'outside/node_modules'),join(app,'web/node_modules'));
  const out=await f.cmds.cleanup_run({paths:[join(app,'node_modules'),join(app,'src'),join(app,'target')],trash:false});
  assert.deepEqual(out.removed,[join(app,'node_modules')]);assert.equal(out.bytes,1000);assert.equal(out.trashed,false);
  assert.deepEqual(out.refused,[`${join(app,'src')} — not something a build can make again`,`${join(app,'target')} — not something a build can make again`]);
  await assert.rejects(stat(join(app,'node_modules')));
  // The worktree root is a checkout; a link out of the workspace never resolves in scope.
  await assert.rejects(f.cmds.cleanup_run({paths:[join(app,'web/node_modules')],trash:false}),/outside selected workspace/);
  const trashed=await f.cmds.cleanup_run({paths:[join(app,'.claude/worktrees/feature/node_modules')],trash:true});
  assert.equal(trashed.removed.length,1);assert.equal(trashed.trashed,true);
  // One filesystem all the way up, so the trash lands at the workspace root.
  const trashDir=join(f.root,`.Trash-${process.getuid()}`);
  assert.deepEqual(await readdir(join(trashDir,'files')),['node_modules']);
  assert.match(await readFile(join(trashDir,'info','node_modules.trashinfo'),'utf8'),/^\[Trash Info\]\nPath=.*\/feature\/node_modules\nDeletionDate=\d{4}-/);
  // A project folder itself is never deletable even with an allowlisted name.
  await f.put(join(f.root,'package.json'),'{}');await f.put(join(f.root,'dist/a'),'a');
  const top=await f.cmds.cleanup_run({paths:[join(f.root,'dist')],trash:false});
  assert.match(top.refused[0],/one of your project folders/);
 }finally{await f.done();}
});

test('cleanup_disk reports the volume behind each root once',async()=>{
 const f=await fixture();
 try{
  await mkdir(join(f.root,'a'));await mkdir(join(f.root,'b'));
  const disks=await f.cmds.cleanup_disk({roots:[join(f.root,'a'),join(f.root,'b'),'/etc']});
  assert.equal(disks.length,1);
  assert.deepEqual(Object.keys(disks[0]).sort(),['free_bytes','label','mount','total_bytes']);
  assert.ok(disks[0].total_bytes>=disks[0].free_bytes&&disks[0].free_bytes>0);
 }finally{await f.done();}
});

test('classify needs the marker that explains the directory',async()=>{
 const f=await fixture();
 try{
  await f.put(join(f.root,'r/Cargo.toml'),'');await mkdir(join(f.root,'r/target'));await mkdir(join(f.root,'s/target'),{recursive:true});
  assert.equal((await classify(join(f.root,'r/target'))).regenerate,'cargo build');
  assert.equal(await classify(join(f.root,'s/target')),null);
  await f.put(join(f.root,'g/Gemfile'),'');
  assert.equal((await classify(join(f.root,'g/vendor/bundle'))).regenerate,'bundle install');
 }finally{await f.done();}
});

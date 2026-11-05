import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile,symlink,lstat} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {MirrorJobs,checkMembers,installPlan,mirrorStaging,toolchainNotes,validBranch} from './mirror-apply.mjs';

const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'T',GIT_AUTHOR_EMAIL:'t@e',GIT_COMMITTER_NAME:'T',GIT_COMMITTER_EMAIL:'t@e'}});
const wait=async(jobs,id)=>{for(let i=0;i<400;i++){const status=jobs.status(id);if(status.state!=='running')return status;await new Promise(r=>setTimeout(r,25));}throw Error('job did not finish');};

// The Mac side, as src-tauri/src/mirror.rs produces it.
async function snapshot(mac,staging,{bundle=true,files=['notes/todo.md','.env']}={}){
 await mkdir(staging,{recursive:true});
 if(bundle){try{git(mac,'bundle','create',path.join(staging,'commits.bundle'),'HEAD','--not','--remotes=origin');}catch{/* nothing unpushed */}}
 const staged=git(mac,'diff','--cached','--binary','--no-ext-diff','--no-textconv');if(staged)await writeFile(path.join(staging,'staged.patch'),staged);
 const unstaged=git(mac,'diff','--binary','--no-ext-diff','--no-textconv');if(unstaged)await writeFile(path.join(staging,'unstaged.patch'),unstaged);
 if(files.length)execFileSync('tar',['-czf',path.join(staging,'files.tgz'),'--null','-T','-'],{cwd:mac,input:files.join('\0')});
}

async function fixture(){
 const base=await mkdtemp(path.join(os.tmpdir(),'canopy-mirror-'));
 const origin=path.join(base,'origin.git'),mac=path.join(base,'mac'),root=path.join(base,'workspace'),home=path.join(base,'home');
 await mkdir(root);await mkdir(home);
 git(base,'init','--bare','-b','main',origin);git(base,'clone',origin,mac);
 await writeFile(path.join(mac,'app.js'),'one\n');await writeFile(path.join(mac,'.gitignore'),'.env\nnode_modules\n');git(mac,'add','.');git(mac,'commit','-m','first');git(mac,'push','origin','main');
 git(mac,'switch','-c','feature');await writeFile(path.join(mac,'feature.js'),'unpushed\n');git(mac,'add','.');git(mac,'commit','-m','local only');
 await writeFile(path.join(mac,'app.js'),'one\nstaged\n');git(mac,'add','app.js');
 await writeFile(path.join(mac,'app.js'),'one\nstaged\nunstaged\n');
 await mkdir(path.join(mac,'notes'));await writeFile(path.join(mac,'notes','todo.md'),'untracked\n');
 await writeFile(path.join(mac,'.env'),'SECRET=1\n');
 git(root,'clone',origin,'repo');
 const jobs=new MirrorJobs({scoped:async p=>path.resolve(root,p),root,home});
 return {base,origin,mac,root,home,repo:path.join(root,'repo'),jobs,cleanup:()=>rm(base,{recursive:true,force:true})};
}

test('reproduces the Mac working tree: unpushed commits, branch, staged, unstaged, new and opted-in files',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID(),head=git(f.mac,'rev-parse','HEAD').trim();
  await snapshot(f.mac,mirrorStaging(f.root,id));
  await f.jobs.start({id,repo:'repo',head,branch:'feature',install:false});
  const status=await wait(f.jobs,id);
  assert.equal(status.state,'complete',JSON.stringify(status));
  assert.equal(git(f.repo,'rev-parse','HEAD').trim(),head);
  assert.equal(git(f.repo,'branch','--show-current').trim(),'feature');
  assert.equal(git(f.repo,'diff','--cached','--name-only').trim(),'app.js');
  assert.equal(git(f.repo,'show',':app.js'),'one\nstaged\n');
  assert.equal(await readFile(path.join(f.repo,'app.js'),'utf8'),'one\nstaged\nunstaged\n');
  assert.equal(await readFile(path.join(f.repo,'notes','todo.md'),'utf8'),'untracked\n');
  assert.equal(await readFile(path.join(f.repo,'.env'),'utf8'),'SECRET=1\n');
  assert.deepEqual(status.steps.map(s=>[s.name,s.state]),[['commits','done'],['checkout','done'],['staged','done'],['unstaged','done'],['files','done']]);
  await assert.rejects(lstat(mirrorStaging(f.root,id)),{code:'ENOENT'});
  assert.throws(()=>git(f.repo,'rev-parse','--verify','--quiet','refs/canopy/mirror'));
 }finally{await f.cleanup();}
});

test('a pushed branch needs no bundle and tracks its origin branch',async()=>{
 const f=await fixture();
 try{
  git(f.mac,'push','origin','feature');git(f.repo,'fetch','origin');
  const id=randomUUID(),head=git(f.mac,'rev-parse','HEAD').trim();
  await snapshot(f.mac,mirrorStaging(f.root,id),{bundle:false,files:[]});
  await f.jobs.start({id,repo:'repo',head,branch:'feature',install:false});
  const status=await wait(f.jobs,id);
  assert.equal(status.state,'complete',JSON.stringify(status));
  assert.equal(status.steps[0].detail,'Commit found on origin');
  assert.equal(git(f.repo,'rev-parse','--abbrev-ref','feature@{upstream}').trim(),'origin/feature');
 }finally{await f.cleanup();}
});

test('an unpushed commit without a bundle fails with a clear reason',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID();
  await mkdir(mirrorStaging(f.root,id),{recursive:true});
  await f.jobs.start({id,repo:'repo',head:git(f.mac,'rev-parse','HEAD').trim(),branch:'feature',install:false});
  const status=await wait(f.jobs,id);
  assert.equal(status.state,'failed');assert.match(status.error,/not on origin/);
 }finally{await f.cleanup();}
});

test('a patch that does not apply is kept, and the rest still runs',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID(),staging=mirrorStaging(f.root,id),head=git(f.mac,'rev-parse','HEAD').trim();
  await snapshot(f.mac,staging);
  await writeFile(path.join(staging,'unstaged.patch'),'diff --git a/missing b/missing\n--- a/missing\n+++ b/missing\n@@ -1 +1 @@\n-x\n+y\n');
  await f.jobs.start({id,repo:'repo',head,branch:'feature',install:false});
  const status=await wait(f.jobs,id);
  assert.equal(status.state,'complete');
  const failed=status.steps.find(s=>s.name==='unstaged');assert.equal(failed.state,'failed');
  assert.match(failed.detail,/kept at/);
  assert.match(await readFile(path.join(f.home,'.canopy','mirror',id,'unstaged.patch'),'utf8'),/missing/);
  assert.equal(status.steps.find(s=>s.name==='files').state,'done');
 }finally{await f.cleanup();}
});

test('archives cannot write through a symlink or into .git',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID(),staging=mirrorStaging(f.root,id),outside=path.join(f.base,'outside');await mkdir(outside);
  await symlink(outside,path.join(f.repo,'linked'));
  await mkdir(staging,{recursive:true});await mkdir(path.join(f.base,'src','linked'),{recursive:true});await writeFile(path.join(f.base,'src','linked','x'),'escape');
  execFileSync('tar',['-czf',path.join(staging,'files.tgz'),'linked/x'],{cwd:path.join(f.base,'src')});
  await f.jobs.start({id,repo:'repo',head:git(f.repo,'rev-parse','HEAD').trim(),branch:'main',install:false});
  const status=await wait(f.jobs,id);
  const files=status.steps.find(s=>s.name==='files');assert.equal(files.state,'failed');assert.match(files.detail,/symlink/);
  await assert.rejects(lstat(path.join(outside,'x')),{code:'ENOENT'});
 }finally{await f.cleanup();}
});

test('member and input validation',async()=>{
 assert.doesNotThrow(()=>checkMembers(['a.txt','dir/b'],['-','-']));
 for(const [names,types] of [[['../x'],['-']],[['/etc/x'],['-']],[['.git/config'],['-']],[['a/.git/hooks/x'],['-']],[['link'],['l']],[['dir/'],['d']],[['a'],[]]])assert.throws(()=>checkMembers(names,types));
 assert.equal(validBranch('feature/one'),true);
 for(const bad of ['-x','a..b','a b','x.lock','HEAD','a~1','',null])assert.equal(validBranch(bad),false);
 const jobs=new MirrorJobs({scoped:async p=>p,root:'/workspace',home:'/tmp'});
 await assert.rejects(jobs.start({id:'nope',repo:'/x',head:'a'.repeat(40)}),/identifier/);
 await assert.rejects(jobs.start({id:randomUUID(),repo:'/x',head:'zz'}),/commit/);
 await assert.rejects(jobs.start({id:randomUUID(),repo:'/x',head:'a'.repeat(40),branch:'--force'}),/branch/);
 await assert.rejects(jobs.start({id:randomUUID(),repo:'/x',head:'a'.repeat(40),components:['../up']}),/component/);
});

test('install plan uses the nearest lockfile per component and skips existing installs',async()=>{
 const files=new Set(['/r/pnpm-lock.yaml','/r/package.json','/r/apps/web/package.json','/r/api/requirements.txt','/r/tools/package-lock.json','/r/tools/node_modules','/r/docs/readme','/s/package.json']);
 const exists=async file=>files.has(file);
 const plans=await installPlan('/r',['apps/web','api','tools','docs',''],exists);
 assert.deepEqual(plans.map(p=>[p.cwd,p.tool,p.installed]),[['/r','pnpm',false],['/r/api','pip',false],['/r/tools','npm',true]]);
 assert.deepEqual(plans[0].argv,['corepack','pnpm','install','--frozen-lockfile']);
 assert.deepEqual((await installPlan('/s',[],exists)).map(p=>[p.cwd,p.argv.join(' ')]),[['/s','npm install']]);
});

test('toolchain notes state what the workspace cannot match',async()=>{
 const files={'/r/.nvmrc':'v18.19.0\n','/r/.gitattributes':'*.bin filter=lfs diff=lfs\n','/r/Cargo.toml':''};
 const notes=await toolchainNotes('/r',async file=>{if(file in files)return files[file];throw Error('missing');},22);
 assert.deepEqual(notes,['Project asks for Node 18; this workspace has Node 22.','Uses Git LFS; large files may be pointers until git-lfs is available in the workspace.','Rust toolchain is not installed in the workspace image; install it before building.']);
 assert.deepEqual(await toolchainNotes('/r',async file=>{if(file==='/r/.node-version')return '22.1';throw Error('missing');},22),[]);
});

test('a failed dependency install is reported with its output and does not fail setup',async()=>{
 const f=await fixture();
 try{
  const {spawn}=await import('node:child_process');
  const jobs=new MirrorJobs({scoped:async p=>path.resolve(f.root,p),root:f.root,home:f.home,launch:(bin,args,options)=>bin==='npm'?spawn('/bin/sh',['-c','echo lockfile mismatch >&2; exit 1'],options):spawn(bin,args,options)});
  await writeFile(path.join(f.repo,'package-lock.json'),'{}');
  const id=randomUUID();await mkdir(mirrorStaging(f.root,id),{recursive:true});
  await jobs.start({id,repo:'repo',head:git(f.repo,'rev-parse','HEAD').trim(),branch:'main'});
  const status=await wait(jobs,id);
  assert.equal(status.state,'complete');
  assert.deepEqual(status.installs.map(i=>[i.cwd,i.tool,i.state]),[['.','npm','failed']]);
  assert.match(status.installs[0].detail,/lockfile mismatch/);
  assert.match(await readFile(status.log,'utf8'),/\$ npm ci/);
 }finally{await f.cleanup();}
});

test('a non-ASCII directory name cannot hide a symlink from the check',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID(),staging=mirrorStaging(f.root,id),outside=path.join(f.base,'outside');await mkdir(outside);
  await symlink(outside,path.join(f.repo,'é'));
  await mkdir(staging,{recursive:true});await mkdir(path.join(f.base,'src','é'),{recursive:true});await writeFile(path.join(f.base,'src','é','x'),'escape');
  execFileSync('tar',['-czf',path.join(staging,'files.tgz'),'é/x'],{cwd:path.join(f.base,'src')});
  await f.jobs.start({id,repo:'repo',head:git(f.repo,'rev-parse','HEAD').trim(),branch:'main',install:false});
  const status=await wait(f.jobs,id);
  const files=status.steps.find(s=>s.name==='files');assert.equal(files.state,'failed');assert.match(files.detail,/symlink/);
  await assert.rejects(lstat(path.join(outside,'x')),{code:'ENOENT'});
 }finally{await f.cleanup();}
});

test('refuses to start when an artifact the sender listed is missing or short',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID(),staging=mirrorStaging(f.root,id);await mkdir(staging,{recursive:true});
  await writeFile(path.join(staging,'staged.patch'),'abc');
  const head=git(f.repo,'rev-parse','HEAD').trim();
  await assert.rejects(f.jobs.start({id,repo:'repo',head,expect:{'staged.patch':3,'unstaged.patch':10}}),/unstaged\.patch.*missing/);
  await assert.rejects(f.jobs.start({id,repo:'repo',head,expect:{'staged.patch':99}}),/staged\.patch.*incomplete/);
  assert.equal((await f.jobs.start({id,repo:'repo',head,branch:'main',install:false,expect:{'staged.patch':3}})).id,id);
  await wait(f.jobs,id);
 }finally{await f.cleanup();}
});

test('discard removes staged files, but not while that setup is running',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID(),staging=mirrorStaging(f.root,id);await mkdir(staging,{recursive:true});await writeFile(path.join(staging,'files.tgz'),'x');
  await f.jobs.discard({id});
  await assert.rejects(lstat(staging),{code:'ENOENT'});
  await f.jobs.discard({id});// already gone is fine
  await assert.rejects(f.jobs.discard({id:'../x'}),/identifier/);
  f.jobs.jobs.set(id,{state:'running'});
  await assert.rejects(f.jobs.discard({id}),/running/);
 }finally{await f.cleanup();}
});

test('staging nobody applied is swept after a day',async()=>{
 const f=await fixture();
 try{
  const old=randomUUID(),fresh=randomUUID();
  for(const id of [old,fresh]){await mkdir(mirrorStaging(f.root,id),{recursive:true});}
  const later=new MirrorJobs({scoped:async p=>path.resolve(f.root,p),root:f.root,home:f.home,now:()=>Date.now()+25*3600000});
  await later.sweep();
  await assert.rejects(lstat(mirrorStaging(f.root,old)),{code:'ENOENT'});
  const same=new MirrorJobs({scoped:async p=>path.resolve(f.root,p),root:f.root,home:f.home});
  await mkdir(mirrorStaging(f.root,fresh),{recursive:true});await same.sweep();
  assert.ok(await lstat(mirrorStaging(f.root,fresh)));
 }finally{await f.cleanup();}
});

test('a step that ignores SIGTERM is abandoned instead of hanging the job',async()=>{
 const {EventEmitter}=await import('node:events');
 const f=await fixture();
 try{
  const kills=[];
  const launch=()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=sig=>kills.push(sig);return c;};
  const jobs=new MirrorJobs({scoped:async p=>p,root:f.root,home:f.home,launch,killGrace:10});
  const job={repo:f.repo,log:path.join(f.home,'x.log')};
  const hold=setInterval(()=>{},1000);// a real child keeps the process alive; the fake one does not
  const result=await jobs.exec(job,['sleep','1'],{timeout:20}).finally(()=>clearInterval(hold));
  assert.equal(result.ok,false);assert.deepEqual(kills,['SIGTERM','SIGKILL']);assert.match(result.output,/Timed out/);
 }finally{await f.cleanup();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {scratchVolume,prepareScratchVolume,clearScratch} from './scratch-storage.mjs';
import {initializeScratch,scratchSessionEnv,SCRATCH_ENV} from './scratch-environment.mjs';
import {DockerWorkspaces} from './docker.mjs';
import {createRunner} from './runner.mjs';
import {prepareForSnapshot} from './storage-prep.mjs';

async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'canopy-scratch-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function engine(){
 const calls=[],volumes=new Map();let current;
 const option=(args,key)=>args[args.indexOf(key)+1];
 const options=(args,key)=>args.flatMap((value,index)=>value===key?[args[index+1]]:[]);
 const missing=()=>{throw Object.assign(Error('missing'),{missingResource:true});};
 return {calls,volumes,get current(){return current;},set current(value){current=value;},docker:async args=>{
  calls.push(args);
  if(args[0]==='volume'&&args[1]==='inspect')return volumes.has(args[2])?{stdout:JSON.stringify([volumes.get(args[2])])}:missing();
  if(args[0]==='volume'&&args[1]==='create'){
   const name=args.at(-1);volumes.set(name,{Name:name,Driver:'local',Labels:Object.fromEntries(options(args,'--label').map(v=>v.split('='))),Options:Object.fromEntries(options(args,'--opt').map(v=>v.split('=')))});
  }
  if(args[0]==='inspect')return current?{stdout:JSON.stringify([current])}:missing();
  if(args[0]==='run'&&args.includes('-d')){
   current={Config:{Labels:Object.fromEntries(options(args,'--label').map(v=>v.split('='))),Image:args.at(-1),User:'1000:1000',Env:options(args,'--env')},
    HostConfig:{Memory:parseInt(option(args,'--memory'))*1048576,MemorySwap:parseInt(option(args,'--memory-swap'))*1048576,NanoCpus:Number(option(args,'--cpus'))*1e9,PidsLimit:1024,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],NetworkMode:option(args,'--network'),RestartPolicy:{Name:'on-failure',MaximumRetryCount:3}},
    Mounts:options(args,'--mount').map(v=>{const fields=Object.fromEntries(v.split(',').map(v=>v.split('=')));return {Type:fields.type,Name:fields.source,Destination:fields.target,RW:!('readonly'in fields)};}),
    State:{Running:true},NetworkSettings:{Networks:{[option(args,'--network')]:{IPAddress:'172.18.0.2'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'45000'}]}}};
  }
  return {stdout:''};
 }};
}
const workspace={id:'owner',cpus:1,memoryMiB:1024,accounts:[]};

test('scratch identities isolate owners, members and collaboration runtimes',()=>{
 const root='/var/lib/canopy-scratch',a=scratchVolume(workspace,root);
 const b=scratchVolume({id:'member-version-a',parentWorkspaceId:'owner',storageId:'member-alice'},root);
 assert.notEqual(a.name,b.name);
 assert.equal(b.name,scratchVolume({id:'member-version-b',parentWorkspaceId:'owner',storageId:'member-alice'},root).name);
 assert.notEqual(b.name,scratchVolume({id:'other',parentWorkspaceId:'owner',storageId:'member-bob'},root).name);
 for(const root of ['/', '/tmp/../data','/tmp/a,b'])assert.throws(()=>scratchVolume(workspace,root),/Invalid scratch root/);
 assert.throws(()=>scratchVolume({id:'../../other'},'/tmp'),/Invalid scratch owner/);
});

test('private scratch volume binds VM storage and checks exact ownership before the helper runs',async t=>{
 const root=await fixture(t),e=engine(),volume=await prepareScratchVolume(workspace,{root,docker:e.docker,image:'trusted-image'});
 assert.equal((await stat(volume.source)).mode&0o777,0o700);
 assert.deepEqual(e.volumes.get(volume.name).Options,{type:'none',o:'bind',device:volume.source});
 const helper=e.calls.find(args=>args[0]==='run');
 assert.ok(helper.includes('--read-only'));assert.ok(helper.includes('none'));assert.ok(helper.includes('--no-dereference'));assert.ok(!helper.includes('--privileged'));
 await prepareScratchVolume(workspace,{root,docker:e.docker,image:'trusted-image'});
 assert.equal(e.calls.filter(args=>args[0]==='volume'&&args[1]==='create').length,1);
 e.volumes.get(volume.name).Options.device='/somebody-elses-data';const before=e.calls.length;
 await assert.rejects(prepareScratchVolume(workspace,{root,docker:e.docker,image:'trusted-image'}),/ownership differs/);
 assert.equal(e.calls.slice(before).some(args=>args[0]==='run'),false);
});

test('scratch preparation refuses symlink roots and child directories',async t=>{
 const root=await fixture(t),e=engine();
 const alias=root+'-alias';await symlink(root,alias);t.after(()=>rm(alias,{force:true}));
 await assert.rejects(prepareScratchVolume(workspace,{root:alias,docker:e.docker,image:'image'}),/real directory/);
 const volume=scratchVolume(workspace,root);await symlink(root,volume.source);
 await assert.rejects(prepareScratchVolume(workspace,{root,docker:e.docker,image:'image'}),/Invalid scratch directory/);
 assert.equal(e.calls.length,0);
});

test('fresh managed runtimes get scratch defaults and exact mount validation; legacy running jobs remain intact',async t=>{
 const root=await fixture(t),e=engine(),host=new DockerWorkspaces({secret:'test',scratchRoot:root,docker:e.docker});
 await host.ensure(workspace);const mount=e.current.Mounts.find(m=>m.Destination==='/scratch');
 assert.equal(mount.Name,scratchVolume(workspace,root).name);
 for(const [key,value]of Object.entries(SCRATCH_ENV))assert.ok(e.current.Config.Env.includes(`${key}=${value}`));
 await host.ensure(workspace);
 const good=structuredClone(e.current);e.current.Mounts.find(m=>m.Destination==='/scratch').Name='foreign';
 await assert.rejects(host.ensure(workspace),/scratch configuration differs/);
 e.current=structuredClone(good);e.current.Config.Env=e.current.Config.Env.filter(v=>!v.startsWith('TMPDIR='));
 await assert.rejects(host.ensure(workspace),/scratch environment differs/);
 e.current=structuredClone(good);e.current.Mounts=e.current.Mounts.filter(m=>m.Destination!=='/scratch');e.current.Config.Env=e.current.Config.Env.filter(v=>!Object.keys(SCRATCH_ENV).some(key=>v.startsWith(key+'=')));
 const before=e.calls.length;await host.ensure(workspace);
 assert.equal(e.calls.slice(before).some(args=>['run','stop','rm'].includes(args[0])),false);
});

test('terminal environment uses scratch for temp/caches and isolates Cargo outputs per session',async t=>{
 const root=await fixture(t),env=await initializeScratch({CANOPY_SCRATCH_DIR:root});
 assert.equal(env.TMPDIR,root);assert.equal(env.NPM_CONFIG_CACHE,path.join(root,'cache/npm'));
 const a=await scratchSessionEnv('session-1',env),b=await scratchSessionEnv('session-2',env);
 assert.notEqual(a.CARGO_TARGET_DIR,b.CARGO_TARGET_DIR);assert.ok(a.CARGO_TARGET_DIR.startsWith(root+'/build/'));
 assert.equal((await scratchSessionEnv('session-1',env)).CARGO_TARGET_DIR,a.CARGO_TARGET_DIR);
 assert.equal((await scratchSessionEnv('custom',{...env,CARGO_TARGET_DIR:'/explicit/build'})).CARGO_TARGET_DIR,'/explicit/build');
 assert.deepEqual(await initializeScratch({}),{});assert.deepEqual(await scratchSessionEnv('local',{}),{});
 const server=createRunner({secret:'x'.repeat(64),environment:env,spawnPty:(_bin,_args,options)=>{assert.equal(options.env.TMPDIR,root);assert.equal(options.env.UV_CACHE_DIR,env.UV_CACHE_DIR);assert.ok(options.env.CARGO_TARGET_DIR.startsWith(root+'/build/'));return {onData(){},onExit(){}};}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/sessions`,{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(64),'content-type':'application/json'},body:JSON.stringify({requestId:'scratch-session-1',command:'cargo build'})});
 assert.equal(response.status,200);
});

test('cache symlinks cannot redirect automatic directory creation into persistent data',async t=>{
 const root=await fixture(t),outside=path.join(root,'persistent');await mkdir(outside);await symlink(outside,path.join(root,'cache'));
 await assert.rejects(initializeScratch({CANOPY_SCRATCH_DIR:root}),/must not be symlinks/);
 await assert.rejects(stat(path.join(outside,'npm')),{code:'ENOENT'});
});

test('snapshot preparation clears scratch only after containers stop and preserves unrelated paths',async t=>{
 const root=await fixture(t),directory=path.join(root,'a'.repeat(40)),retained=path.join(root,'retained');await mkdir(directory);await writeFile(path.join(directory,'build'),'disposable');await writeFile(retained,'keep');
 let stopped=false,cleaned=false;
 const run=async(command,args)=>{if(command==='docker'&&args[0]==='ps')return {code:0,stdout:stopped?'':'canopy-ws-owner\n'};if(command==='docker'&&args[0]==='stop')stopped=true;return {code:0,stdout:''};};
 await prepareForSnapshot({run,cleanScratch:async()=>{assert.ok(stopped);cleaned=true;await clearScratch(root);},cleanTmp:async()=>{},userMounted:async()=>false,dataDiskMounted:async()=>false,usage:async()=>null});
 assert.ok(cleaned);await assert.rejects(stat(directory),{code:'ENOENT'});assert.equal(await readFile(retained,'utf8'),'keep');
 cleaned=false;stopped=false;
 await prepareForSnapshot({run:async(command,args)=>command==='docker'&&args[0]==='stop'?{code:1,stdout:''}:run(command,args),cleanScratch:async()=>{cleaned=true;},cleanTmp:async()=>{},userMounted:async()=>false,dataDiskMounted:async()=>false,usage:async()=>null});
 assert.equal(cleaned,false);
});


test('a container still running after shutdown prevents scratch cleanup',async()=>{
 let cleaned=false;
 const run=async(command,args)=>({code:0,stdout:command==='docker'&&args[0]==='ps'?'canopy-ws-owner\n':''});
 const report=await prepareForSnapshot({run,cleanScratch:async()=>{cleaned=true;},cleanTmp:async()=>{},userMounted:async()=>false,dataDiskMounted:async()=>false,usage:async()=>null});
 assert.equal(cleaned,false);assert.ok(report.warnings.some(w=>w.includes('scratch retained')));
});

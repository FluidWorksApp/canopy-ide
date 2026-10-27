import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delegate} from './cgroup-delegate.mjs';
import {SessionCgroups,fakeDelegatedTree} from './cgroup-sessions.mjs';
import {TerminalGovernor,governorSampler} from './terminal-governor.mjs';

const GIB=1024**3;

test('delegation mounts, empties the root into canopy-host, enables memory and hands the tree to the runner',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'cg-delegate-'));const root=path.join(base,'mnt'),statusFile=path.join(base,'status.json');
 const files={'/proc/self/cgroup':'0::/\n'};
 const read=async f=>{if(f in files)return files[f];return readFile(f,'utf8');};
 const mount=async target=>{await writeFile(path.join(target,'cgroup.controllers'),'cpu memory pids');await writeFile(path.join(target,'cgroup.procs'),'1\n7\n');};
 const chowned=[];
 const status=await delegate({root,statusFile,mount,read,uid:1000,gid:1000,own:async(file,uid)=>chowned.push([path.relative(root,file),uid])});
 assert.equal(status.ok,true,JSON.stringify(status));
 assert.equal(await readFile(path.join(root,'cgroup.subtree_control'),'utf8'),'+memory');
 assert.equal(await readFile(path.join(root,'sessions','cgroup.subtree_control'),'utf8'),'+memory');
 assert.ok((await stat(path.join(root,'canopy-host'))).isDirectory());
 assert.equal(JSON.parse(await readFile(statusFile,'utf8')).ok,true);
 assert.deepEqual(chowned.map(([f])=>f),['cgroup.procs','sessions','sessions/cgroup.procs','sessions/cgroup.subtree_control','canopy-host/cgroup.procs'],'the container\'s own limits stay root\'s');
 // In the host's namespace it refuses before mounting anything.
 files['/proc/self/cgroup']='0::/system.slice/docker-abc.scope\n';
 const refused=await delegate({root:path.join(base,'other'),statusFile,mount:()=>{throw Error('must not mount');},read});
 assert.equal(refused.ok,false);assert.match(refused.error,/host's cgroup namespace/);
 // A kernel refusal names the step.
 files['/proc/self/cgroup']='0::/\n';
 const denied=await delegate({root:path.join(base,'denied'),statusFile,mount:async()=>{throw Object.assign(Error('mount: permission denied'),{code:'EPERM'});},read});
 assert.deepEqual([denied.ok,denied.step],[false,'mount a writable cgroup2']);
});

test('the runner says exactly why limits are off, and places, measures and limits each terminal when they are on',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'cg-sessions-'));
 const statusFile=path.join(base,'status.json'),proc=path.join(base,'proc'),cgroupFs=path.join(base,'sysfs');
 await mkdir(cgroupFs);await writeFile(path.join(cgroupFs,'cgroup.controllers'),'memory');
 const {root}=await fakeDelegatedTree(base);
 let cg=new SessionCgroups({root,statusFile,procRoot:proc,cgroupFs});
 assert.match((await cg.probe(1)).detail,/never delegated.*recreate the workspace/);
 await writeFile(statusFile,JSON.stringify({ok:false,step:'mount a writable cgroup2',error:'EPERM: denied'}));
 cg=new SessionCgroups({root,statusFile,procRoot:proc,cgroupFs});
 assert.equal((await cg.probe(1)).detail,'the kernel refused to mount a writable cgroup2: EPERM: denied');
 await writeFile(statusFile,JSON.stringify({ok:true}));
 cg=new SessionCgroups({root,statusFile,procRoot:proc,cgroupFs});
 assert.equal((await cg.probe(1)).active,true);
 // A fake kernel: writing a pid records it; memory files are plain files.
 await mkdir(path.join(proc,'41'),{recursive:true});await writeFile(path.join(proc,'41','cgroup'),'0::/canopy-host\n');
 await mkdir(path.join(root,'sessions','7'),{recursive:true});
 await writeFile(path.join(root,'sessions','7','memory.current'),String(GIB/2));
 await writeFile(path.join(root,'sessions','7','memory.events'),'low 0\nhigh 3\nmax 0\noom 0\noom_kill 0\n');
 const governor=new TerminalGovernor({defaultsFile:path.join(base,'defaults.json'),now:()=>1000});
 const sampler=governorSampler({governor,cgroups:cg,memory:async()=>({total:8*GIB,available:6*GIB}),sample:async()=>[{id:7,bytes:1,cliKey:'bin:claude',pids:[41,1]}]});
 await sampler.tick();
 assert.equal(await readFile(path.join(root,'sessions','7','cgroup.procs'),'utf8'),'41','pid 1 is never moved');
 assert.equal(await readFile(path.join(root,'sessions','7','memory.high'),'utf8'),String(GIB));
 assert.equal(await readFile(path.join(root,'sessions','7','memory.max'),'utf8'),'max');
 const snap=governor.snapshot();
 assert.equal(snap.sessions[0].current_bytes,GIB/2,'measured as the kernel charges it');
 assert.deepEqual([snap.capability.enforcement,snap.capability.mechanism,snap.capability.soft_limit,snap.capability.hard_limit],['soft_limit','cgroup_v2_memory_high',true,true]);
 // A maximum for the agent becomes memory.max.
 await governor.setMaximum('bin:claude',2*GIB);
 await sampler.tick();
 assert.equal(await readFile(path.join(root,'sessions','7','memory.max'),'utf8'),String(2*GIB));
});

test('without delegation the governor stays monitor-only and says why',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'cg-off-'));
 const cg=new SessionCgroups({root:path.join(base,'none'),statusFile:path.join(base,'none.json'),cgroupFs:path.join(base,'nofs')});
 const governor=new TerminalGovernor({defaultsFile:path.join(base,'d.json')});
 const sampler=governorSampler({governor,cgroups:cg,memory:async()=>({total:8*GIB,available:6*GIB}),sample:async()=>[{id:3,bytes:GIB/4,pids:[]}]});
 await sampler.tick();
 const cap=governor.snapshot().capability;
 assert.equal(cap.enforcement,'monitor_only');assert.match(cap.detail,/Per-terminal limits are off: this kernel does not offer cgroup v2/);
});

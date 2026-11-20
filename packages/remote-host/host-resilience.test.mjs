import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {serviceUnit,serviceMemory,reopenWorkspaces} from './canopy-host.mjs';
import {delegateHostCgroup,cgroupEnv,UPGRADE_HINT} from './host-cgroup.mjs';
import {SessionCgroups} from './cgroup-sessions.mjs';
import {TerminalGovernor,governorSampler,workspaceMemory} from './terminal-governor.mjs';
import {expendablePids} from './session-processes.mjs';
import {raiseOomScore,EXPENDABLE_SCORE} from './oom-score.mjs';
import {ProcessWorkspaces} from './process-workspaces.mjs';

const GIB=1024**3;
const SERVICE='/user.slice/user-1000.slice/user@1000.service/app.slice/canopy-host.service';

test('the service survives one process being killed for memory, divides its own cgroup, and stops short of the machine',()=>{
 const unit=serviceUnit({node:'/usr/bin/node',script:'/opt/ch/canopy-host.mjs',totalMemory:16*GIB});
 for(const line of ['OOMPolicy=continue','Delegate=yes','MemoryAccounting=yes','Restart=always'])assert.match(unit,new RegExp(`^${line}$`,'m'));
 assert.match(unit,/^Environment=.*CANOPY_CGROUP_DELEGATE=1/m);
 const max=Number(/^MemoryMax=(\d+)$/m.exec(unit)[1]),high=Number(/^MemoryHigh=(\d+)$/m.exec(unit)[1]);
 assert.ok(16*GIB-max>=GIB&&max>=14*GIB,'10% (at least 1 GiB) left to the OS');
 assert.ok(high<max&&high>0.85*max,'throttled a little before the cap');
 const small=serviceMemory(2*GIB);assert.equal(small.max,GIB,'a 2 GiB machine keeps 1 GiB');
 const tiny=serviceMemory(GIB);assert.equal(tiny.max,0.75*GIB,'too small to keep 1 GiB: three quarters');
});

async function fakeService(base,{controllers='cpu memory pids',pids=['500','501']}={}){
 const fs=path.join(base,'sysfs'),root=path.join(fs,SERVICE);
 await mkdir(root,{recursive:true});
 await writeFile(path.join(root,'cgroup.controllers'),controllers);
 await writeFile(path.join(root,'cgroup.procs'),pids.join('\n')+'\n');
 // A fake kernel: writes into cgroup.procs append the pid; the root empties.
 const moved=[];
 const write=async(file,value)=>{
  if(file.endsWith(path.join('host','cgroup.procs'))){moved.push(value);await writeFile(path.join(root,'cgroup.procs'),'');return;}
  await writeFile(file,value);
 };
 const read=file=>file==='/proc/self/cgroup'?Promise.resolve(`0::${SERVICE}\n`):readFile(file,'utf8');
 return {fs,root,moved,write,read};
}

test('the host moves itself into host/ and opens sessions/ with the memory controller, without root',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'host-cg-'));
 try{
  const f=await fakeService(base),statusFile=path.join(base,'state','cgroup.json');
  const status=await delegateHostCgroup({statusFile,delegated:true,read:f.read,write:f.write,cgroupFs:f.fs,now:()=>1});
  assert.deepEqual(status,{ok:true,root:f.root,sessions:path.join(f.root,'sessions'),cgroupPath:SERVICE,at:1});
  assert.deepEqual(f.moved,['500','501'],'every process leaves the service root');
  assert.equal(await readFile(path.join(f.root,'cgroup.subtree_control'),'utf8'),'+memory');
  assert.equal(await readFile(path.join(f.root,'sessions','cgroup.subtree_control'),'utf8'),'+memory');
  assert.deepEqual(JSON.parse(await readFile(statusFile,'utf8')),status,'the runner reads the outcome');
  assert.deepEqual(cgroupEnv(status,statusFile),{CANOPY_CGROUP_STATUS:statusFile,CANOPY_CGROUP_ROOT:f.root,CANOPY_CGROUP_PATH:SERVICE});
 }finally{await rm(base,{recursive:true,force:true});}
});

test('an older unit, or no memory controller, leaves limits off and says how to turn them on',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'host-cg-off-'));
 try{
  const statusFile=path.join(base,'cgroup.json');
  const old=await delegateHostCgroup({statusFile,delegated:false});
  assert.equal(old.ok,false);assert.match(old.detail,/not delegated.*re-run `npx canopy-host up`/);
  assert.deepEqual(cgroupEnv(old,statusFile),{CANOPY_CGROUP_STATUS:statusFile},'no tree handed to the runner');
  const cg=new SessionCgroups({root:path.join(base,'none'),statusFile,cgroupFs:base});
  assert.deepEqual(await cg.probe(1),{active:false,detail:`this service's cgroup is not delegated to it; ${UPGRADE_HINT}`});
  const f=await fakeService(base,{controllers:'cpu pids'});
  const none=await delegateHostCgroup({statusFile,delegated:true,read:f.read,write:f.write,cgroupFs:f.fs});
  assert.equal(none.ok,false);assert.match(none.detail,/memory controller is not delegated/);
 }finally{await rm(base,{recursive:true,force:true});}
});

test('on an own machine terminals are placed under the service\'s full cgroup path and throttled at memory.high',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'host-cg-place-'));
 try{
  const f=await fakeService(base),statusFile=path.join(base,'state','cgroup.json'),proc=path.join(base,'proc');
  const status=await delegateHostCgroup({statusFile,delegated:true,read:f.read,write:f.write,cgroupFs:f.fs});
  await writeFile(path.join(status.sessions,'cgroup.subtree_control'),'memory');
  await mkdir(path.join(proc,'41'),{recursive:true});await writeFile(path.join(proc,'41','cgroup'),`0::${SERVICE}/host\n`);
  await mkdir(path.join(proc,'42'),{recursive:true});await writeFile(path.join(proc,'42','cgroup'),`0::${SERVICE}/sessions/7\n`);
  const cg=new SessionCgroups({root:status.root,statusFile,cgroupPath:status.cgroupPath,procRoot:proc,cgroupFs:f.fs});
  const governor=new TerminalGovernor({defaultsFile:path.join(base,'defaults.json'),now:()=>1000});
  const raised=[];
  const sampler=governorSampler({governor,cgroups:cg,memory:async()=>({total:8*GIB,available:6*GIB}),oom:async pids=>{raised.push(...pids);},
   sample:async()=>[{id:7,bytes:1,cliKey:null,pids:[41,42],expendable:[42]}]});
  await sampler.tick();
  assert.equal(await readFile(path.join(status.sessions,'7','cgroup.procs'),'utf8'),'41','only the process not already there is moved');
  assert.equal(await readFile(path.join(status.sessions,'7','memory.high'),'utf8'),String(2*GIB),'the governor\'s allowance, as in a container');
  assert.equal(governor.snapshot().capability.mechanism,'cgroup_v2_memory_high');
  assert.deepEqual(raised,[42],'only the expendable pids are raised');
  assert.deepEqual(await workspaceMemory(async file=>file===status.root+'/memory.max'?String(14*GIB):String(GIB),status.root),{total:14*GIB,available:13*GIB},'the governor sizes against the service\'s cap');
 }finally{await rm(base,{recursive:true,force:true});}
});

test('an agent and the shells holding it keep their score; its builds and servers are expendable',()=>{
 const procs=[
  {pid:10,parent:1,agent:false},   // the terminal's login shell
  {pid:11,parent:10,agent:true},   // claude
  {pid:12,parent:11,agent:false},  // bash -c tsc, run by the agent
  {pid:13,parent:12,agent:false},  // tsc
  {pid:20,parent:1,agent:false},   // a plain terminal running next dev
 ];
 assert.deepEqual(expendablePids(procs),[12,13,20]);
 assert.deepEqual(expendablePids([{pid:5,parent:1,agent:false}]),[5],'a terminal without an agent is all expendable');
});

test('oom scores are only ever raised',async()=>{
 const scores=new Map([['/proc/40/oom_score_adj','200'],['/proc/41/oom_score_adj','900']]),writes=[];
 const n=await raiseOomScore([40,41,40,1,99],EXPENDABLE_SCORE,{read:async f=>{if(!scores.has(f))throw Object.assign(Error('gone'),{code:'ENOENT'});return scores.get(f)+'\n';},write:async(f,v)=>{writes.push([f,v]);}});
 assert.equal(n,1);assert.deepEqual(writes,[['/proc/40/oom_score_adj','800']],'never lowers, never pid 1, skips exited');
});

test('with no desktop, the host starts the runner of every workspace that had live terminals, then resumes',async()=>{
 const opened=[],checked=[];
 const files={'/s/a.json':JSON.stringify({live:{3:{kind:'terminal'}}}),'/s/b.json':JSON.stringify({live:{}})};
 const config={workspaces:[{id:'a'},{id:'b'},{id:'c'},{id:'d',desiredState:'stopped'}]};
 const resume={eligible:w=>w.desiredState!=='stopped',file:id=>`/s/${id}.json`,checkAll:async()=>{checked.push(true);}};
 const workspaces={runtimes:new Map(),open:async w=>{opened.push(w.id);workspaces.runtimes.set(w.id,{});}};
 const read=async file=>{if(!(file in files))throw Object.assign(Error('no'),{code:'ENOENT'});return files[file];};
 assert.deepEqual(await reopenWorkspaces({config,workspaces,resume,read}),['a'],'no live terminals, no state, or stopped: left alone');
 assert.equal(checked.length,1);
 assert.deepEqual(await reopenWorkspaces({config,workspaces,resume,read}),[],'a runner already running is not restarted');
});

test('a process workspace reports its runner as session-resume reads a container, and forgets a runner that exited',async()=>{
 const listeners={};const child={once:(event,fn)=>{listeners[event]=fn;},kill(){}};
 const ws=new ProcessWorkspaces({secret:'s'.repeat(64),home:tmpdir(),spawn:()=>child,port:async()=>1,fetchImpl:async()=>({ok:true}),log:{warn(){}}});
 const workspace={id:'w1',root:path.join(tmpdir(),'pw-root')};
 const runtime=await ws.open(workspace);
 assert.deepEqual(ws.runtimes.get('w1'),{workspace,runtime});
 const state=ws.runnerState(workspace);
 assert.equal(state.State.Running,true);assert.ok(Date.parse(state.State.StartedAt)>0);
 listeners.exit(1);await new Promise(r=>setImmediate(r));
 assert.equal(ws.runnerState(workspace),null);assert.equal(ws.runtimes.has('w1'),false);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {MachineMetrics,parseMeminfo,parseProcStat} from './machine-metrics.mjs';
import {hostResources} from './host-resources.mjs';

const GIB=1024**3;
const id=c=>c.repeat(64);
// A VM with the owner's workspace and two members' runtime containers, each
// with its own cgroup, as the host sees them.
function machine(){
 const files={
  '/proc/meminfo':`MemTotal:       ${32*1024*1024} kB\nMemFree:  1000 kB\nMemAvailable:   ${20*1024*1024} kB\n`,
  '/proc/stat':'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 1 1 1\n',
 };
 const containers={};
 const add=(name,c,pid,{current,inactive,usage})=>{
  containers[name]={Id:id(c),State:{Running:true,Pid:pid}};
  const root=`/sys/fs/cgroup/system.slice/docker-${id(c)}.scope`;
  files[`/proc/${pid}/cgroup`]=`0::/system.slice/docker-${id(c)}.scope\n`;
  files[`${root}/memory.current`]=String(current);
  files[`${root}/memory.stat`]=`anon ${current-inactive}\ninactive_file ${inactive}\n`;
  files[`${root}/memory.events`]='low 0\nhigh 0\nmax 0\n';
  files[`${root}/cpu.stat`]=`usage_usec ${usage}\nnr_periods 0\nnr_throttled 0\n`;
  return root;
 };
 const roots={
  shared:add('shared','a',101,{current:12*GIB,inactive:4*GIB,usage:0}),
  'member-alice':add('member-alice','b',102,{current:3*GIB,inactive:1*GIB,usage:0}),
  'member-bob':add('member-bob','c',103,{current:2*GIB,inactive:0,usage:0}),
 };
 const read=async file=>{if(file in files)return files[file];throw Object.assign(Error('ENOENT'),{code:'ENOENT'});};
 return {files,roots,read,containers,inspect:async runtime=>containers[runtime.id]??null};
}
const member=(memberId,runtimeId,parent='shared')=>({memberId,name:memberId==='alice'?'Alice':null,runtime:{id:runtimeId,parentWorkspaceId:parent}});

test('the machine: memory free is MemAvailable, cores free from /proc/stat between samples',async()=>{
 assert.deepEqual(parseMeminfo('MemTotal: 4 kB\nMemAvailable: 2 kB\n'),{totalBytes:4096,availableBytes:2048});
 assert.throws(()=>parseMeminfo('MemTotal: 4 kB\n'));
 assert.deepEqual(parseProcStat('cpu  1 2 3 4 5 6 7 8 9 10\n'),{busy:1+2+3+6+7+8,total:36});
 const m=machine();let now=0;
 const metrics=new MachineMetrics({inspect:m.inspect,read:m.read,readResources:i=>hostResources(i,m.read),cpus:()=>8,now:()=>now});
 const first=await metrics.machine();
 assert.deepEqual(first,{memoryTotalBytes:32*GIB,memoryAvailableBytes:20*GIB,cpus:8,cpusUsed:null,cpusAvailable:null});
 // 1000 more jiffies, 250 of them busy: a quarter of 8 cores.
 m.files['/proc/stat']='cpu  200 0 250 1550 0 0 0 0 0 0\n';now=500;
 assert.equal((await metrics.machine()).cpusUsed,null,'a second poll inside the interval reuses the reading');
 now=2000;const second=await metrics.machine();
 assert.equal(second.cpusUsed,2);assert.equal(second.cpusAvailable,6);
});

test('a member sees the main workspace and other members; never its own runtime or another workspace',async()=>{
 const m=machine();let now=0;
 const metrics=new MachineMetrics({inspect:m.inspect,read:m.read,readResources:i=>hostResources(i,m.read),cpus:()=>8,now:()=>now});
 const members=[member('alice','member-alice'),member('bob','member-bob'),member('carol','member-carol','elsewhere')];
 const first=await metrics.forWorkspace({id:'shared'},{memberId:'bob'},members);
 assert.deepEqual(first.runtimes,[
  {kind:'workspace',memberId:null,name:null,workingSetBytes:8*GIB,cpusUsed:null},
  {kind:'member',memberId:'alice',name:'Alice',workingSetBytes:2*GIB,cpusUsed:null},
 ]);
 // Alice's container used 1.5 cores over the next two seconds.
 m.files[`${m.roots['member-alice']}/cpu.stat`]='usage_usec 3000000\nnr_periods 0\nnr_throttled 0\n';now=2000;
 const second=await metrics.forWorkspace({id:'shared'},{memberId:'bob'},members);
 assert.equal(second.runtimes.find(r=>r.memberId==='alice').cpusUsed,1.5);
});

test('the owner sees every member runtime; one row per member; stopped or unreadable runtimes are left out',async()=>{
 const m=machine();
 m.containers['member-bob'].State.Running=false;
 m.containers['member-alice2']={Id:id('d'),State:{Running:true,Pid:104}};
 m.files['/proc/104/cgroup']=`0::/system.slice/docker-${id('d')}.scope\n`;
 const root=`/sys/fs/cgroup/system.slice/docker-${id('d')}.scope`;
 Object.assign(m.files,{[`${root}/memory.current`]:String(GIB),[`${root}/memory.stat`]:'inactive_file 0\n',[`${root}/memory.events`]:'max 0\n',[`${root}/cpu.stat`]:'usage_usec 0\nnr_periods 0\nnr_throttled 0\n'});
 m.containers['member-dan']={Id:id('e'),State:{Running:true,Pid:105}};
 const metrics=new MachineMetrics({inspect:m.inspect,read:m.read,readResources:i=>hostResources(i,m.read),cpus:()=>8,now:()=>0});
 const result=await metrics.forWorkspace({id:'shared'},{},[member('alice','member-alice'),member('alice','member-alice2'),member('bob','member-bob'),member('dan','member-dan')]);
 assert.deepEqual(result.runtimes,[{kind:'member',memberId:'alice',name:'Alice',workingSetBytes:3*GIB,cpusUsed:null}]);
 assert.equal(result.memoryAvailableBytes,20*GIB);
});

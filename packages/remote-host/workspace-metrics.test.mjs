import test from 'node:test';import assert from 'node:assert/strict';import {cpuPercent,cpusUsed,memoryFigures,metricsReader,parseMemoryStat,sessionOwner,sessionUsage} from './workspace-metrics.mjs';
test('workspace CPU is normalized to its quota and handles first sample/reset',()=>{assert.equal(cpuPercent(null,{time:1000,usage:1},1),null);assert.equal(cpuPercent({time:0,usage:0},{time:1000,usage:500000},1),50);assert.equal(cpuPercent({time:0,usage:0},{time:1000,usage:500000},2),25);assert.equal(cpuPercent({time:0,usage:5},{time:1000,usage:0},1),null);assert.equal(cpusUsed({time:0,usage:0},{time:1000,usage:2500000}),2.5);assert.equal(cpusUsed(null,{time:1,usage:1}),null);});
test('reads container counters, not client or whole VM counters',async()=>{let time=0,usage=0;const read=async file=>file.endsWith('memory.current')?'1024':file.endsWith('memory.max')?'2048':file.endsWith('cpu.max')?'100000 100000':file.endsWith('memory.stat')?Promise.reject(Object.assign(Error('missing'),{code:'ENOENT'})):`usage_usec ${usage}`;const sample=metricsReader(read,()=>time);assert.equal((await sample()).cpuPercent,null);time=1000;usage=400000;assert.deepEqual({...await sample(),sampledAt:0},{memoryBytes:1024,memoryLimitBytes:2048,cpuPercent:40,cpus:1,scope:'workspace',sampledAt:0,workingSetBytes:1024,availableBytes:1024,reclaimableBytes:null,memoryBreakdown:null,cpusUsed:0.4,cpusAvailable:0.6});});

const GIB=1024**3,g=x=>Math.round(x*GIB);
// A real shared workspace: memory.current read 21 GB of a 28.8 GB limit, most
// of it page cache the kernel drops on demand.
const REAL_STAT=[`anon ${g(3.1)}`,`file ${g(17)}`,`kernel ${g(0.9)}`,`kernel_stack 4800512`,`shmem ${g(2.8)}`,`active_file ${g(1.7)}`,`inactive_file ${g(13)}`,`slab ${g(0.8)}`].join('\n');
const fixture=({current=g(21),max=String(g(28.8)),stat=REAL_STAT,quota='800000 100000',usage=()=>0}={})=>async file=>{
 if(file.endsWith('memory.current'))return String(current);if(file.endsWith('memory.max'))return max;if(file.endsWith('cpu.max'))return quota;
 if(file.endsWith('memory.stat')){if(stat==null)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});return stat;}
 return `usage_usec ${usage()}\nuser_usec 0\n`;
};
test('the working set leaves out cache the kernel can drop, and what is free is the limit less it',async()=>{
 let time=0,usage=0;const sample=metricsReader(fixture({usage:()=>usage}),()=>time);
 const first=await sample();assert.equal(first.cpusUsed,null);assert.equal(first.cpusAvailable,null);
 time=1000;usage=2_000_000;const s=await sample();
 assert.equal(s.memoryBytes,g(21),'older desktops keep reading memory.current');
 assert.equal(s.workingSetBytes,g(8));assert.equal(s.reclaimableBytes,g(13));assert.equal(s.availableBytes,g(28.8)-g(8));
 assert.deepEqual(s.memoryBreakdown,{anonBytes:g(3.1),fileBytes:g(17)-g(2.8),shmemBytes:g(2.8),kernelBytes:g(0.9),activeFileBytes:g(1.7),inactiveFileBytes:g(13)});
 assert.equal(s.cpus,8);assert.equal(s.cpusUsed,2);assert.equal(s.cpusAvailable,6);assert.equal(s.cpuPercent,25);
});
test('no memory limit and no CPU quota: nothing is "free" of a limit, cores used still count',async()=>{
 let time=0,usage=0;const sample=metricsReader(fixture({max:'max',quota:'max 100000',usage:()=>usage}),()=>time);await sample();time=500;usage=750_000;
 const s=await sample();assert.equal(s.memoryLimitBytes,null);assert.equal(s.availableBytes,null);assert.equal(s.workingSetBytes,g(8));assert.equal(s.cpus,null);assert.equal(s.cpuPercent,null);assert.equal(s.cpusUsed,1.5);assert.equal(s.cpusAvailable,null);
});
test('without memory.stat the working set is memory.current and nothing is called reclaimable',async()=>{
 const s=await metricsReader(fixture({stat:null}),()=>0)();assert.equal(s.workingSetBytes,g(21));assert.equal(s.reclaimableBytes,null);assert.equal(s.memoryBreakdown,null);assert.equal(s.availableBytes,g(28.8)-g(21));
 assert.equal(parseMemoryStat(''),null);
});
test('older kernels: kernel memory is summed from its parts; cache never exceeds the total',()=>{
 const f=memoryFigures(GIB,null,{anon:GIB/2,file:GIB/2,inactive_file:g(2),slab:100,kernel_stack:20,pagetables:3,percpu:1});
 assert.equal(f.workingSetBytes,0);assert.equal(f.reclaimableBytes,GIB);assert.equal(f.memoryBreakdown.kernelBytes,124);assert.equal(f.memoryBreakdown.shmemBytes,0);
});
test('terminal usage carries who started each terminal, and a stale pass is no answer',()=>{
 const pass={at:1000,sessions:[{id:1,bytes:g(5),workingSet:g(2),cpu:150,kind:'terminal',meta:{owner:{id:'u1',name:'Ada'}}},{id:2,bytes:GIB,cpu:0,kind:'build',meta:{}},{id:3,bytes:GIB,meta:{owner:{id:'x\n',name:'Bad'}}}]};
 assert.deepEqual(sessionUsage(pass,2000),[{id:1,memoryBytes:g(2),cpusUsed:1.5,kind:'terminal',owner:{id:'u1',name:'Ada'}},{id:2,memoryBytes:GIB,cpusUsed:0,kind:'build',owner:null},{id:3,memoryBytes:GIB,cpusUsed:0,kind:'terminal',owner:null}]);
 assert.equal(sessionUsage(pass,20_000),null);assert.equal(sessionUsage(null),null);
 assert.deepEqual(sessionOwner({owner:{id:'u2'}}),{id:'u2',name:'Teammate'});
});

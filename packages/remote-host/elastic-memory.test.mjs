import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryDecision, growthCapacity, ElasticMemory} from './elastic-memory.mjs';
const workspace = {id:'alice',memoryMiB:3072,memoryMaxMiB:16384};
const sample = (overrides={}) => ({id:'alice',minMiB:3072,memoryMiB:3072,running:true,usedMiB:2600,workingMiB:2600,events:0,activeSessions:1,...overrides});

test('growth waits for sustained pressure; urgency grows immediately and limits stay bounded',()=>{
 const first=memoryDecision(workspace,sample(),{},0,32768);assert.equal(first.target,null);
 assert.equal(memoryDecision(workspace,sample(),first.state,10000,32768).target,4608);
 assert.equal(memoryDecision(workspace,sample({workingMiB:2900}),{},0,32768).target,4608);
 assert.equal(memoryDecision(workspace,sample({memoryMiB:15360,workingMiB:14500,usedMiB:14500}),{},0,32768).target,16384);
 assert.equal(memoryDecision(workspace,sample({memoryMiB:16384,workingMiB:15500,usedMiB:15500}),{},0,32768).status,'maximum');
});
test('cooldowns protect live sessions and shrinking retains measured headroom',()=>{
 const low=sample({memoryMiB:6144,usedMiB:700,workingMiB:500,activeSessions:0});
 const first=memoryDecision(workspace,low,{},0,32768);assert.equal(first.target,null);
 assert.equal(memoryDecision(workspace,low,first.state,599999,32768).target,null);
 assert.equal(memoryDecision(workspace,low,first.state,600000,32768).target,5632);
 for(const activeSessions of [1,null])assert.equal(memoryDecision(workspace,{...low,activeSessions},first.state,600000,32768).target,null);
 assert.equal(memoryDecision(workspace,{...low,usedMiB:6000},first.state,600000,32768).target,null);
 assert.equal(memoryDecision(workspace,sample({workingMiB:2900}),{lastResize:0},5000,32768).target,null);
});
test('growth obeys both host reserve/other workspace ceilings and physical headroom',()=>{
 const snapshots=[sample(),{id:'bob',minMiB:2048,memoryMiB:4096,running:true}];
 assert.equal(growthCapacity(workspace,snapshots,{totalMiB:8192,availableMiB:6000}),2048);
 assert.equal(growthCapacity(workspace,snapshots,{totalMiB:32768,availableMiB:2304}),3328);
 const decision=memoryDecision(workspace,sample({workingMiB:2900}),{},0,3072);
 assert.equal(decision.target,null);assert.equal(decision.status,'host_capacity');
});
test('the pool cannot allocate the same headroom to two growing workspaces',async()=>{
 const snapshots=[sample({workingMiB:2900}),sample({id:'bob',workingMiB:2900})],updates=[];
 const docker={withResourceLock:fn=>fn(),resourceSnapshot:async()=>structuredClone(snapshots),updateMemory:async(w,size)=>updates.push([w.id,size])};
 const controller=new ElasticMemory({registry:[workspace,{...workspace,id:'bob'}],docker,readHost:async()=>({totalMiB:10240,availableMiB:9000}),now:()=>0});
 await controller.tick();assert.deepEqual(updates,[['alice',4608],['bob',3584]]);
 assert.equal(controller.status('alice').currentMiB,4608);assert.equal(controller.status('bob').currentMiB,3584);
});
test('an unconfirmed update stops grants until the whole pool is resampled',async()=>{
 const updates=[];const docker={withResourceLock:fn=>fn(),resourceSnapshot:async()=>[sample({workingMiB:2900}),sample({id:'bob',workingMiB:2900})],updateMemory:async(w,size)=>{updates.push([w.id,size]);throw Error('failure');}};
 const controller=new ElasticMemory({registry:[workspace,{...workspace,id:'bob'}],docker,readHost:async()=>({totalMiB:32768,availableMiB:30000}),now:()=>0});
 await controller.tick();assert.deepEqual(updates,[['alice',4608]]);assert.equal(controller.status('alice').status,'update_failed');assert.equal(controller.status('alice').currentMiB,null);
});
test('fixed workspaces and unavailable measurements never trigger an update',async()=>{
 const updates=[];const docker={withResourceLock:fn=>fn(),resourceSnapshot:async()=>[sample({workingMiB:NaN})],updateMemory:async()=>updates.push(true)};
 const controller=new ElasticMemory({registry:[workspace],docker,readHost:async()=>({totalMiB:32768,availableMiB:30000})});
 await assert.rejects(controller.tick(),/Invalid workspace memory sample/);assert.equal(updates.length,0);
 const fixed=new ElasticMemory({registry:[{id:'alice',memoryMiB:3072}],docker,readHost:async()=>({totalMiB:32768,availableMiB:30000})});
 await fixed.tick();assert.equal(updates.length,0);
});
test('stopped workspaces release capacity and a later start must check live allocations',()=>{
 const stopped={id:'bob',minMiB:2048,memoryMiB:2048,running:false};
 const snapshots=[sample({memoryMiB:11520}),stopped];
 assert.equal(growthCapacity(workspace,snapshots,{totalMiB:15759,availableMiB:6000}),13568);
 assert.ok(growthCapacity({id:'bob',memoryMiB:2048},[sample({memoryMiB:13568}),stopped],{totalMiB:15759,availableMiB:4000})<2048);
});

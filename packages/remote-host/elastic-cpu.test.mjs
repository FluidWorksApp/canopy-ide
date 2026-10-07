import test from 'node:test';
import assert from 'node:assert/strict';
import {cpuDecision, ElasticCpu} from './elastic-cpu.mjs';
const workspace={id:'alice',cpus:1,cpusMax:4};
const sample=(overrides={})=>({id:'alice',running:true,cpus:1,cpuUsageUsec:0,cpuPeriods:0,cpuThrottledPeriods:0,activeSessions:1,...overrides});
const high=(seconds,overrides={})=>sample({cpuUsageUsec:seconds*900000,cpuPeriods:seconds*10,cpuThrottledPeriods:seconds*3,...overrides});

test('CPU growth needs measured sustained pressure, obeys host and configured ceilings',()=>{
 const prime=cpuDecision(workspace,sample(),{},0,8);assert.equal(prime.target,null);
 const first=cpuDecision(workspace,high(10),prime.state,10000,8);assert.equal(first.target,null);
 const grow=cpuDecision(workspace,high(20),first.state,20000,8);assert.equal(grow.target,2);
 const capped=cpuDecision(workspace,high(20),first.state,20000,1);assert.equal(capped.target,null);assert.equal(capped.status,'host_capacity');
 const maximum=cpuDecision(workspace,high(20,{cpus:4,cpuUsageUsec:72000000}),{...first.state,cpus:4,usage:0,sampledAt:10000},20000,8);
 assert.equal(maximum.target,null);assert.equal(maximum.status,'maximum');
 const small=cpuDecision({...workspace,cpusMax:1.5},high(20),first.state,20000,8);assert.equal(small.target,1.5);
});
test('throttling can trigger growth but low activity and isolated spikes cannot',()=>{
 const primed=cpuDecision(workspace,sample(),{},0,4);
 const throttled=high(10,{cpuUsageUsec:6000000});
 const first=cpuDecision(workspace,throttled,primed.state,10000,4);
 assert.equal(cpuDecision(workspace,high(20,{cpuUsageUsec:12000000}),first.state,20000,4).target,2);
 const low=cpuDecision(workspace,high(20,{cpuUsageUsec:10000000}),first.state,20000,4);assert.equal(low.target,null);assert.equal(low.state.highSince,null);
 assert.equal(cpuDecision(workspace,high(20),{...first.state,lastResize:0},20000,4).target,null);
});
test('shrinking waits ten idle minutes and resets safely on counters or quota changes',()=>{
 const w={...workspace}, low=sample({cpus:3,cpuUsageUsec:1000000,activeSessions:0});
 const prior={sampledAt:0,usage:0,periods:0,throttled:0,cpus:3,lowSince:0};
 assert.equal(cpuDecision(w,low,prior,599999,4).target,null);
 assert.equal(cpuDecision(w,low,prior,600000,4).target,2);
 for(const activeSessions of [1,null])assert.equal(cpuDecision(w,{...low,activeSessions},prior,600000,4).target,null);
 assert.equal(cpuDecision(w,low,{...prior,lastResize:500000},600000,4).target,null);
 for(const change of [{usage:2000000},{cpus:2},{sampledAt:600000}])assert.equal(cpuDecision(w,low,{...prior,...change},600000,4).target,null);
 assert.throws(()=>cpuDecision(w,{...low,cpuUsageUsec:NaN},prior,600000,4),/Invalid workspace CPU sample/);
});
test('controller confirms allocation and does not change fixed workspaces',async()=>{
 let now=0,seconds=0,cpus=1;const updates=[];
 const docker={withResourceLock:fn=>fn(),resourceSnapshot:async()=>[high(seconds,{cpus})],updateCpus:async(w,size)=>{updates.push([w.id,size]);cpus=size;}};
 const controller=new ElasticCpu({registry:[workspace,{id:'bob',cpus:1}],docker,readHost:()=>2,now:()=>now});
 for(const t of [0,10000,20000]){now=t;seconds=t/1000;await controller.tick();}
 assert.deepEqual(updates,[['alice',2]]);assert.equal(controller.status('alice').currentCpus,2);
 assert.equal(controller.status('alice').availableMaxCpus,2);assert.equal(controller.status('bob'),null);
});
test('failed updates and missing measurements stop CPU grants',async()=>{
 let now=0,seconds=0;const updates=[];
 const docker={withResourceLock:fn=>fn(),resourceSnapshot:async()=>[high(seconds),high(seconds,{id:'bob'})],updateCpus:async(w)=>{updates.push(w.id);throw Error('unconfirmed');}};
 const controller=new ElasticCpu({registry:[workspace,{...workspace,id:'bob'}],docker,readHost:()=>4,now:()=>now});
 for(const t of [0,10000,20000]){now=t;seconds=t/1000;await controller.tick();}
 assert.deepEqual(updates,['alice']);assert.equal(controller.status('alice').currentCpus,null);assert.equal(controller.status('alice').status,'update_failed');
 docker.resourceSnapshot=async()=>[sample({cpuUsageUsec:null})];await assert.rejects(controller.tick(),/Invalid workspace CPU sample/);
 assert.deepEqual(updates,['alice']);
});

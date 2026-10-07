import test from 'node:test';import assert from 'node:assert/strict';
import {memorySwapMiB,workspaceSwapMiB,aggregateSwapBytes,WORKSPACE_SWAP_MIB} from './workspace-swap.mjs';
import {DockerWorkspaces} from './docker.mjs';
import {capacityUnit} from './provision-capacity.mjs';
import {verifyCapacityGroup} from './capacity-group.mjs';
import {validateConfig} from './policy.mjs';
const MiB=1048576;
test('a fixed swap allowance adds 3 GiB to any memory size; legacy ratio configurations are unchanged',()=>{
 assert.equal(WORKSPACE_SWAP_MIB,3072);
 for(const memory of [1536,5632,13824,30208])assert.equal(memorySwapMiB({swapMiB:3072,swapRatio:0.75},memory),memory+3072);
 assert.equal(memorySwapMiB({},2048),3584);assert.equal(memorySwapMiB({swapRatio:0.5},2048),3072);assert.equal(workspaceSwapMiB({swapMiB:0},4096),0);
 assert.equal(aggregateSwapBytes({memoryMiB:8192,swapMiB:3072}),3072*MiB);assert.equal(aggregateSwapBytes({memoryMiB:8192,swapRatio:0.75}),6144*MiB);
});
test('configuration validates swapMiB and the capacity slice uses it',async()=>{
 const config=swap=>({workspaces:[{id:'ws-one',memoryMiB:8192,cpus:2,accounts:[],...swap}],principals:[]});
 validateConfig(config({swapMiB:3072,swapRatio:0.75}));
 for(const bad of [-1,1.5,'3072',20000])assert.throws(()=>validateConfig(config({swapMiB:bad})),/swap size/);
 assert.match(capacityUnit({id:'ws-one',memoryMiB:8192,cpus:2,swapRatio:0.75,swapMiB:3072}).content,new RegExp(`MemorySwapMax=${3072*MiB}\\n`));
 assert.throws(()=>capacityUnit({id:'ws-one',memoryMiB:8192,cpus:2,swapMiB:-5}),/Invalid workspace capacity/);
 const read=swap=>async path=>({'memory.max':String(8192*MiB),'cpu.max':'200000 100000','memory.swap.max':String(swap)})[path.split('/').at(-1)];
 const w={cgroupParent:'canopy-shared.slice',memoryMiB:8192,cpus:2,swapMiB:3072};
 await verifyCapacityGroup(w,read(3072*MiB));await assert.rejects(verifyCapacityGroup(w,read(3073*MiB)),/not enforced/);
});
test('existing containers with the legacy swap limit are normalized, not rejected',async()=>{
 const calls=[];let current;
 const host=new DockerWorkspaces({secret:'test',docker:async args=>{calls.push(args);if(args[0]==='update'){current.HostConfig.Memory=parseInt(args[2])*MiB;current.HostConfig.MemorySwap=parseInt(args[4])*MiB;}return {stdout:JSON.stringify([current])};}});
 const workspace={id:'alice',memoryMiB:2048,cpus:2,accounts:[],swapRatio:0.75,swapMiB:3072};
 current={Config:{Labels:{'canopy.workspace':'alice'},Image:'canopy-workspace:0.1.0',User:'1000:1000',Env:[`CANOPY_RUNNER_TOKEN=${host.token('alice')}`,'CANOPY_ACCOUNTS=']},
  HostConfig:{Memory:2048*MiB,MemorySwap:3584*MiB,NanoCpus:2e9,RestartPolicy:{Name:'on-failure',MaximumRetryCount:3},PidsLimit:1024,CapDrop:['ALL'],CapAdd:[],NetworkMode:'canopy-net-alice',SecurityOpt:['no-new-privileges:true']},
  Mounts:[{Type:'volume',Destination:'/workspace',Name:'canopy-project-alice',RW:true},{Type:'volume',Destination:'/home/agent',Name:'canopy-home-alice',RW:true}],
  State:{Running:true},NetworkSettings:{Networks:{'canopy-net-alice':{IPAddress:'172.18.0.2'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'45000'}]}}};
 assert.ok((await host.ensure(workspace)).url);
 assert.deepEqual(calls.find(args=>args[0]==='update'),['update','--memory','2048m','--memory-swap','5120m','canopy-ws-alice']);
 calls.length=0;assert.ok((await host.ensure(workspace)).url);assert.ok(!calls.some(args=>args[0]==='update'));
 current.HostConfig.MemorySwap=9999*MiB;await assert.rejects(host.ensure(workspace),/configuration differs/);
});

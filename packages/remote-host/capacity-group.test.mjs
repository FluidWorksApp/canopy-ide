import test from 'node:test';import assert from 'node:assert/strict';import {verifyCapacityGroup} from './capacity-group.mjs';
const w={cgroupParent:'canopy-shared.slice',memoryMiB:2048,cpus:2};
test('requires actual host aggregate memory, CPU and swap limits',async()=>{
 const good={'memory.max':String(2048*1048576),'cpu.max':'200000 100000','memory.swap.max':String(1536*1048576)};
 const reader=values=>async path=>values[path.split('/').at(-1)];await verifyCapacityGroup(w,reader(good));
 for(const bad of [{'memory.max':'max'},{'cpu.max':'max 100000'},{'cpu.max':'300000 100000'},{'memory.swap.max':'max'},{'memory.max':String(4096*1048576)}])await assert.rejects(verifyCapacityGroup(w,reader({...good,...bad})),/not enforced/);
 await assert.rejects(verifyCapacityGroup(w,async()=>{throw Error('ENOENT');}));
});

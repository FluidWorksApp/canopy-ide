import test from 'node:test';import assert from 'node:assert/strict';import {hostResources} from './host-resources.mjs';
const id='a'.repeat(64),observation={Id:id,State:{Pid:42}};
const group=`0::/canopy.slice/canopy-test.slice/docker-${id}.scope\n`;
const values={'cgroup':group,'memory.current':'1048576\n','memory.stat':'inactive_file 262144\n','memory.events':'max 2\n','cpu.stat':'usage_usec 500\nnr_periods 10\nnr_throttled 3\n'};
const read=async file=>values[file.split('/').at(-1)];
test('host reads bound kernel counters without trusting container session reports',async()=>{const result=await hostResources(observation,read);assert.equal(result.usedMiB,1);assert.equal(result.workingMiB,.75);assert.equal(result.cpuUsageUsec,500);assert.equal(result.activeSessions,null);});
test('rejects cross-container identity, traversal and PID reuse',async()=>{
 for(const fake of [`0::/docker-${'b'.repeat(64)}.scope\n`,`0::/../docker-${id}.scope\n`])await assert.rejects(hostResources(observation,async f=>f.endsWith('/cgroup')?fake:read(f)),/identity/);
 let n=0;await assert.rejects(hostResources(observation,async f=>f.endsWith('/cgroup')?(++n===1?group:'0::/other'):read(f)),/changed/);
});
test('rejects missing or malformed counters instead of granting resources',async()=>{await assert.rejects(hostResources(observation,async f=>f.endsWith('cpu.stat')?'usage_usec NaN':read(f)),/counter/);});

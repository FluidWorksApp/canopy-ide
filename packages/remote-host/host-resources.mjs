import {readFile} from 'node:fs/promises';
// Read kernel counters from the host, never by executing code in the container.
export async function hostResources(inspected, read = readFile) {
 const pid=inspected?.State?.Pid,id=inspected?.Id;
 if(!Number.isSafeInteger(pid)||pid<1||!/^[a-f0-9]{64}$/.test(id??''))throw Error('Invalid container observation');
 const membership=()=>read(`/proc/${pid}/cgroup`,'utf8');
 const before=await membership();
 const group=before.split('\n').find(line=>line.startsWith('0::'))?.slice(3);
 if(!group||!group.startsWith('/')||group.split('/').includes('..')||!group.split('/').some(part=>part===id||part===`docker-${id}.scope`))throw Error('Container cgroup identity differs');
 const root=`/sys/fs/cgroup${group}`;
 const [memory,stat,events,cpu]=await Promise.all(['memory.current','memory.stat','memory.events','cpu.stat'].map(file=>read(`${root}/${file}`,'utf8')));
 if(await membership()!==before)throw Error('Container changed during resource observation');
 const count=(text,name)=>{const raw=text.split('\n').find(line=>line.startsWith(name+' '))?.split(/\s+/)[1];if(!/^\d+$/.test(raw??''))throw Error('Invalid kernel resource counter');const n=Number(raw);if(!Number.isSafeInteger(n))throw Error('Invalid kernel resource counter');return n;};
 if(!/^\d+\s*$/.test(memory)||!Number.isSafeInteger(Number(memory)))throw Error('Invalid kernel memory counter');
 const bytes=Number(memory),inactive=count(stat,'inactive_file');
 return {usedMiB:bytes/1048576,workingMiB:Math.max(0,bytes-inactive)/1048576,events:count(events,'max'),cpuUsageUsec:count(cpu,'usage_usec'),cpuPeriods:count(cpu,'nr_periods'),cpuThrottledPeriods:count(cpu,'nr_throttled'),activeSessions:null};
}

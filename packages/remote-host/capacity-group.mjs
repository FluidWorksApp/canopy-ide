import {readFile} from 'node:fs/promises';
import {aggregateSwapBytes} from './workspace-swap.mjs';
export async function verifyCapacityGroup(workspace,read=readFile){
 const name=workspace.cgroupParent;if(!/^canopy-[a-z0-9]+\.slice$/.test(name??''))throw Error('Invalid capacity group');
 const root=`/sys/fs/cgroup/canopy.slice/${name}`;
 const [memory,cpu,swap]=await Promise.all(['memory.max','cpu.max','memory.swap.max'].map(file=>read(`${root}/${file}`,'utf8')));
 const [quota,period]=cpu.trim().split(/\s+/).map(Number);
 if(!/^\d+$/.test(memory.trim())||Number(memory)<=0||Number(memory)>workspace.memoryMiB*1048576||!Number.isFinite(quota)||quota<=0||!Number.isFinite(period)||period<=0||quota/period>workspace.cpus||!/^\d+$/.test(swap.trim())||Number(swap)>aggregateSwapBytes(workspace))throw Error('Workspace aggregate capacity is not enforced');
}

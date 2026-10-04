import {readFile} from 'node:fs/promises';
export function cpuPercent(previous,current,cpus){
 if(!previous||current.time<=previous.time||current.usage<previous.usage)return null;
 return Math.max(0,Math.min(100,(current.usage-previous.usage)/((current.time-previous.time)*1000*cpus)*100));
}
export function metricsReader(read=readFile,now=()=>performance.now()){
 let previous;
 return async()=>{
  const [memory,limit,cpu,quota]=await Promise.all(['memory.current','memory.max','cpu.stat','cpu.max'].map(file=>read('/sys/fs/cgroup/'+file,'utf8')));
  const parts=quota.trim().split(/\s+/),cpus=parts[0]==='max'?null:Number(parts[0])/Number(parts[1]);
  const usage=Number(cpu.match(/^usage_usec\s+(\d+)/m)?.[1]);
  if(!Number.isFinite(usage)||!Number.isFinite(Number(memory)))throw Error('Workspace metrics unavailable');
  const current={time:now(),usage};const percent=cpus?cpuPercent(previous,current,cpus):null;previous=current;
  return {memoryBytes:Number(memory),memoryLimitBytes:limit.trim()==='max'?null:Number(limit),cpuPercent:percent,cpus,scope:'workspace',sampledAt:Date.now()};
 };
}

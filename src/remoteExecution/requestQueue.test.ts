import {it,expect} from 'vitest';import {RequestQueue} from './requestQueue';
it('bounds concurrent requests and admits a desktop action ahead of queued polls',async()=>{
 const queue=new RequestQueue(),releases:Array<()=>void>=[],order:string[]=[];
 const hold=()=>new Promise<void>(resolve=>releases.push(resolve));
 const running=Array.from({length:4},()=>queue.run(1,hold));await Promise.resolve();expect(releases).toHaveLength(4);
 const poll=queue.run(0,async()=>{order.push('poll');});const desktop=queue.run(1,async()=>{order.push('desktop');});
 releases.shift()!();await Promise.resolve();await Promise.resolve();await desktop;expect(order[0]).toBe('desktop');
 releases.forEach(release=>release());await Promise.all([...running,poll]);
});
it('admits typing while all ordinary requests remain stalled and bounds the input lane',async()=>{
 const queue=new RequestQueue(),ordinary:Array<()=>void>=[],inputs:Array<()=>void>=[];
 const stalled=Array.from({length:4},()=>queue.run(1,()=>new Promise<void>(r=>ordinary.push(r))));
 await Promise.resolve();
 const typing=Array.from({length:5},()=>queue.run(2,()=>new Promise<void>(r=>inputs.push(r))));
 await Promise.resolve();expect(inputs).toHaveLength(4);expect(ordinary).toHaveLength(4);
 inputs.shift()!();await Promise.resolve();await Promise.resolve();expect(inputs).toHaveLength(4);
 inputs.forEach(r=>r());ordinary.forEach(r=>r());await Promise.all([...stalled,...typing]);
});

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
it('drops a poll backlog instead of turning away a terminal reconnect',async()=>{
 const queue=new RequestQueue(),releases:Array<()=>void>=[];
 const stalled=Array.from({length:4},()=>queue.run(1,()=>new Promise<void>(r=>releases.push(r))));
 await Promise.resolve();
 // Polls beyond the background cap are rejected at once; they retry on their next tick.
 const polls=Array.from({length:24},()=>queue.run(0,async()=>'poll'));
 await expect(queue.run(0,async()=>'late poll')).rejects.toThrow('Workspace is busy');
 // Fill the rest with ordinary work, then a reconnect still gets in by displacing the oldest poll.
 const work=Array.from({length:72},()=>queue.run(1,async()=>'work'));
 const reconnect=queue.run(1,async()=>'reconnect');
 await expect(polls[0]).rejects.toThrow('Workspace is busy');
 // With no poll left to displace, a full queue still refuses.
 const settled=Promise.allSettled([...polls.slice(1),...work,reconnect]);
 releases.forEach(r=>r());
 await Promise.all(stalled);
 expect(await reconnect).toBe('reconnect');
 await settled;
});
it('refuses an interactive request when the queue is full of interactive work',async()=>{
 const queue=new RequestQueue(),releases:Array<()=>void>=[];
 const stalled=Array.from({length:4},()=>queue.run(1,()=>new Promise<void>(r=>releases.push(r))));
 await Promise.resolve();
 const work=Array.from({length:96},()=>queue.run(1,async()=>'work'));
 await expect(queue.run(1,async()=>'more')).rejects.toThrow('Workspace is busy');
 releases.forEach(r=>r());await Promise.all([...stalled,...work]);
});

import {expect,it} from 'vitest';
import {takeOutputBatch,type OutputFrame} from './outputBatch';
const frame=(start:number,text:string,extra:Partial<OutputFrame>={}):OutputFrame=>({start,end:start+text.length,bytes:new TextEncoder().encode(text),gap:false,reset:false,cols:80,rows:24,...extra});
it('combines a backlog without losing control sequences or stream positions',()=>{
 const frames=[frame(0,'\r-'),frame(2,'\r|'),frame(4,'\rDone')];
 const batch=takeOutputBatch(frames)!;
 expect(new TextDecoder().decode(batch.bytes)).toBe('\r-\r|\rDone');expect(batch.end).toBe(9);expect(frames).toHaveLength(0);
});
it.each([{reset:true},{gap:true},{cols:120},{rows:40},{start:99}])('preserves the next semantic boundary %j',boundary=>{
 const frames=[frame(0,'a'),frame(1,'b',boundary)];
 expect(takeOutputBatch(frames)!.bytes).toEqual(new TextEncoder().encode('a'));expect(frames).toHaveLength(1);
});
it('bounds parser batches while preserving the remaining output',()=>{
 const frames=[frame(0,'a'.repeat(40000)),frame(40000,'b'.repeat(40000))];
 expect(takeOutputBatch(frames)!.bytes.length).toBe(40000);expect(frames).toHaveLength(1);
});

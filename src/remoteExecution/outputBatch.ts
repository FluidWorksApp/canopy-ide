export type OutputFrame = {bytes:Uint8Array;start:number;end:number;gap:boolean;reset:boolean;cols:number;rows:number};
/** Parse accumulated output together, preserving every byte and terminal boundary.
 * Replaying each old network packet separately animates stale spinner frames. */
export function takeOutputBatch(frames:OutputFrame[]):OutputFrame|undefined {
 const first=frames.shift();if(!first)return;
 const parts=[first.bytes];let size=first.bytes.length,end=first.end;
 while(frames.length){
  const next=frames[0];
  if(next.reset||next.gap||next.start!==end||next.cols!==first.cols||next.rows!==first.rows||size+next.bytes.length>64*1024)break;
  frames.shift();parts.push(next.bytes);size+=next.bytes.length;end=next.end;
 }
 if(parts.length===1)return first;
 const bytes=new Uint8Array(size);let offset=0;
 for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 return {...first,bytes,end};
}

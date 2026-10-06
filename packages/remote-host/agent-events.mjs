import {open,constants} from 'node:fs/promises';
// Per-reader cursor: two IDEs never consume each other's events. This is
// workspace telemetry only, never authoritative billing or permission evidence.
export async function readAgentEvents(file,cursor){
 let handle;try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return {cursor:'missing:0',lines:[]};throw e;}
 try{
  const info=await handle.stat();if(!info.isFile())throw Error('Invalid event stream');
  const identity=String(info.ino),parts=typeof cursor==='string'?cursor.split(':'):[];
  let offset=parts[0]===identity&&/^\d+$/.test(parts[1]??'')?Number(parts[1]):cursor==null?info.size:0;
  if(!Number.isSafeInteger(offset)||offset>info.size)offset=0;
  const buffer=Buffer.alloc(Math.min(256*1024,info.size-offset));
  const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
  const end=buffer.subarray(0,bytesRead).lastIndexOf(10)+1;
  const lines=[];
  if(end){for(const line of buffer.subarray(0,end).toString('utf8').split('\n')){try{const value=JSON.parse(line);if(value&&typeof value==='object'&&!Array.isArray(value))lines.push(line);}catch{}}offset+=end;}
  // Skip oversized malformed lines rather than pinning every future poll.
  else if(bytesRead===256*1024)offset+=bytesRead;
  return {cursor:`${identity}:${offset}`,lines};
 }finally{await handle.close();}
}

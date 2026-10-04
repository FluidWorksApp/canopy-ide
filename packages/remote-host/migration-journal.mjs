import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';

// The directory is host-owned, outside every developer mount. Exclusive create
// prevents a second migration from overwriting recovery evidence. Completed
// journals are retained; an operator archives them after checking actual state.
export async function createMigrationJournal(directory, workspaceId) {
 if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspaceId))throw Error('Invalid workspace id');
 const path=join(directory,`${workspaceId}.migration.jsonl`);
 const file=await open(path,'wx',0o600);
 let closed=false;
 let sequence=0;
 let queue=Promise.resolve();
 const append=event=>{
  if(closed)return Promise.reject(Error('Migration journal closed'));
  const record=JSON.stringify({...event,workspaceId,sequence:++sequence})+'\n';
  queue=queue.then(async()=>{await file.writeFile(record);await file.sync();});
  return queue;
 };
 try {
  await append({phase:'created'});
  const parent=await open(directory,'r');
  try{await parent.sync();}finally{await parent.close();}
 }catch(error){await file.close();throw error;}
 return {path,append,async close(){closed=true;try{await queue;}finally{await file.close();}}};
}

// A torn final append is not a durable transition. Earlier complete records
// remain usable; corruption of any complete record is a hard recovery error.
export async function readMigrationJournal(path) {
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const info=await file.stat();
  if(!info.isFile()||info.size>8*1024*1024)throw Error('Invalid migration journal file');
  const buffer=Buffer.alloc(info.size);
  let offset=0;
  while(offset<buffer.length){const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)throw Error('Migration journal changed while reading');offset+=bytesRead;}
  const after=await file.stat();
  if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw Error('Migration journal changed while reading');
  const text=buffer.toString('utf8');
  const end=text.lastIndexOf('\n');
  if(end<0)throw Error('No durable migration journal records');
  const records=text.slice(0,end).split('\n').map(line=>JSON.parse(line));
  records.forEach((r,i)=>{if(r.sequence!==i+1||r.workspaceId!==records[0].workspaceId)throw Error('Invalid migration journal sequence');});
  return {records,incompleteTail:end!==text.length-1};
 }finally{await file.close();}
}

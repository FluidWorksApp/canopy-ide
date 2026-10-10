import type {Attachment} from './client';
import {MAX_ATTACHMENT_BYTES,hasControl,validAttachment,validFileName} from './messageSchema';
/** Attachment bytes live only on the devices at either end of a chat. Nothing
 * here is uploaded: the sender keeps its copy to serve pull requests over a
 * direct WebRTC channel, and a recipient keeps what it pulled. */
export type FileRecord={id:string;meta:Attachment;messageId:string;
 /** 'sent' copies are the only ones this device will serve to a peer. */
 origin:'sent'|'received';
 /** Accounts allowed to pull a sent copy: the message's recipients. */
 allowedUsers:string[];
 /** Received only: the device that signed the message, which holds the bytes. */
 device?:string;
 /** Absent until a received file has been pulled and verified. */
 blob?:Blob;created:number};
export type FileStore={get:(id:string)=>Promise<FileRecord|undefined>;put:(row:FileRecord)=>Promise<void>;
 /** Inserts only when absent: a later message cannot repoint an existing record. */
 add:(row:FileRecord)=>Promise<void>;prune:(now?:number)=>Promise<void>};
/** Sender copies serve pulls for a week; pulled copies stay for a month. */
export const SENT_FILE_MS=7*86_400_000,RECEIVED_FILE_MS=30*86_400_000;
const stale=(row:FileRecord,now:number)=>now-row.created>(row.origin==='sent'?SENT_FILE_MS:RECEIVED_FILE_MS);
let database:Promise<IDBDatabase>|undefined;
function open(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('canopy-chat-files',1);r.onupgradeneeded=()=>{r.result.createObjectStore('files',{keyPath:'key'}).createIndex('scope','scope');};r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();database=undefined;};resolve(r.result);};r.onerror=()=>{database=undefined;reject(r.error);};r.onblocked=()=>{database=undefined;reject(Error('Close other Canopy windows to update chat file storage'));};});}
/** Records are scoped to one account and team, like history and the outbox. */
export function chatFileStore(account:string,team:string):FileStore {
 const scope=JSON.stringify([account,team]),key=(id:string)=>JSON.stringify([account,team,id]);
 const write=async(row:FileRecord,onlyNew:boolean)=>{const db=await open();await new Promise<void>((resolve,reject)=>{
  const tx=db.transaction('files','readwrite',{durability:'strict'}),store=tx.objectStore('files'),value={...row,key:key(row.id),scope};
  if(onlyNew){const r=store.add(value);r.onerror=e=>{if(r.error?.name==='ConstraintError'){e.preventDefault();e.stopPropagation();}};}else store.put(value);
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Attachment could not be saved on this device'));
 });};
 return {
  async get(id){const db=await open();return new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').get(key(id));r.onsuccess=()=>{const row=r.result as (FileRecord&{key:string;scope:string})|undefined;if(!row)return resolve(undefined);const {key:_k,scope:_s,...rest}=row;resolve(rest);};r.onerror=()=>reject(r.error);});},
  put:row=>write(row,false),add:row=>write(row,true),
  async prune(now=Date.now()){const db=await open();await new Promise<void>((resolve,reject)=>{
   const tx=db.transaction('files','readwrite'),cursor=tx.objectStore('files').index('scope').openCursor(scope);
   cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;if(stale(c.value as FileRecord,now))c.delete();c.continue();};
   tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
  });},
 };
}
/** Same contract in memory, for tests and when IndexedDB is unavailable. */
export function memoryFileStore(rows=new Map<string,FileRecord>()):FileStore&{rows:Map<string,FileRecord>} {
 return {rows,async get(id){return rows.get(id);},async put(row){rows.set(row.id,row);},async add(row){if(!rows.has(row.id))rows.set(row.id,row);},async prune(now=Date.now()){for(const [id,row]of rows)if(stale(row,now))rows.delete(id);}};
}
export const bytesOf=(blob:Blob):Promise<ArrayBuffer>=>typeof blob.arrayBuffer==='function'?blob.arrayBuffer():new Response(blob).arrayBuffer();
export async function sha256(data:ArrayBuffer|Blob){const bytes=data instanceof ArrayBuffer?data:await bytesOf(data);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export type PreparedFile={meta:Attachment;blob:Blob};
/** A pasted image has no useful name; give it one the recipient can save. */
const nameOf=(file:Blob&{name?:string})=>{const raw=(file.name??'').split(/[/\\]/).pop()!.split('').filter(c=>!hasControl(c)).join('').slice(-255);return validFileName(raw)?raw:`attachment${file.type.startsWith('image/')?'.'+(file.type.split('/')[1]||'png').replace(/[^a-z0-9]/gi,'').slice(0,8):''}`;};
/** Hashes a picked, dropped or pasted file and gives it attachment metadata. */
export async function prepareFile(file:Blob&{name?:string}):Promise<PreparedFile>{
 if(!file.size)throw Error(`${nameOf(file)} is empty`);
 if(file.size>MAX_ATTACHMENT_BYTES)throw Error(`${nameOf(file)} is larger than 100 MB`);
 const meta:Attachment={id:crypto.randomUUID(),name:nameOf(file),size:file.size,type:(file.type||'application/octet-stream').slice(0,255),sha256:await sha256(file)};
 if(!validAttachment(meta))throw Error(`${meta.name} cannot be attached`);
 return {meta,blob:file};
}
export function formatBytes(n:number){if(n<1024)return `${n} B`;const units=['KB','MB','GB'];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++;}return `${v<10?v.toFixed(1):Math.round(v)} ${units[i]}`;}

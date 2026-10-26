import type {ChatMessage} from './client';
import {validChatMessage as valid,sameChatMessage,hasControl} from './messageSchema';
import {eventOf} from './chatEvents';
let database:Promise<IDBDatabase>|undefined;
const scope=(account:string,team:string)=>{if([account,team].some(value=>typeof value!=='string'||!value||value.length>256||hasControl(value,false)))throw Error('Invalid chat history scope');return JSON.stringify([account,team]);};
function open(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('canopy-chat-history',2);r.onupgradeneeded=event=>{
 // v1: keys and messages. v2 (chat protocol v2): events, changes to earlier
 // messages (reactions now; edits and deletes later), kept apart from the
 // 500-message cap so a busy conversation never loses its reactions first.
 const db=r.result;
 if(event.oldVersion<1){db.createObjectStore('keys');db.createObjectStore('messages',{keyPath:'id'}).createIndex('scope','scope');}
 if(event.oldVersion<2)db.createObjectStore('events',{keyPath:'id'}).createIndex('scope','scope');
};r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();database=undefined;};resolve(r.result);};r.onerror=()=>{database=undefined;reject(r.error);};r.onblocked=()=>{database=undefined;reject(Error('Close other Canopy windows to update chat history'));};});}
async function key(account:string){
 const db=await open();const existing=await new Promise<CryptoKey|undefined>((resolve,reject)=>{const r=db.transaction('keys').objectStore('keys').get(account);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});if(existing)return existing;
 const candidate=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 return new Promise<CryptoKey>((resolve,reject)=>{const tx=db.transaction('keys','readwrite',{durability:'strict'}),store=tx.objectStore('keys');let chosen:CryptoKey;const r=store.get(account);r.onsuccess=()=>{chosen=r.result??candidate;if(!r.result)store.add(candidate,account);};tx.oncomplete=()=>resolve(chosen);tx.onabort=()=>reject(tx.error);});
}
type Row={id:string;scope:string;created:number;iv:Uint8Array;ciphertext:ArrayBuffer};
const aad=(id:string)=>new TextEncoder().encode(id);
export async function saveChatMessage(account:string,team:string,message:ChatMessage){
 scope(account,team);
 if(!valid(message)||(message.sender!==account&&message.recipient!==null&&message.recipient!==account))throw Error('Invalid chat history message');
 const id=JSON.stringify([account,team,message.id]),iv=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id)},await key(account),new TextEncoder().encode(JSON.stringify(message)));
 const db=await open();
 const existing=await new Promise<Row|undefined>((resolve,reject)=>{
  const tx=db.transaction('messages','readwrite',{durability:'strict'}),store=tx.objectStore('messages');let duplicate:Row|undefined;
  // Atomic unique insert: neither another window nor a signed peer can replace
  // the original message by choosing its logical UUID in a fresh envelope.
  const insert=store.add({id,scope:scope(account,team),created:message.created,iv,ciphertext});
  insert.onerror=event=>{
   if(insert.error?.name!=='ConstraintError')return;
   event.preventDefault();event.stopPropagation();
   const prior=store.get(id);prior.onsuccess=()=>{duplicate=prior.result;if(!duplicate)tx.abort();};
  };
  insert.onsuccess=()=>{const r=store.index('scope').getAll(scope(account,team));r.onsuccess=()=>{const rows=r.result as Row[];rows.sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id));for(const row of rows.slice(500))store.delete(row.id);};};
  tx.oncomplete=()=>resolve(duplicate);tx.onabort=()=>reject(tx.error??Error('Message history could not be saved'));
 });
 if(existing){
  const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(existing.iv),additionalData:aad(id)},await key(account),existing.ciphertext);
  const original=JSON.parse(new TextDecoder().decode(decoded)) as ChatMessage;
  if(existing.id!==id||existing.scope!==scope(account,team)||existing.created!==original.created||!valid(original)||!sameChatMessage(original,message))throw Error('Message identity conflicts with saved history');
 }

}
/** Events kept per account and team; the oldest go first. */
export const MAX_CHAT_EVENTS=2000;
/** Saves a chat event message (one carrying a known `event`) encrypted like a
 * message, in the events store. Saving the same event twice is a no-op; a
 * different event under the same id is refused, as for messages. */
export async function saveChatEvent(account:string,team:string,message:ChatMessage){
 scope(account,team);
 if(!valid(message)||!eventOf(message)||(message.sender!==account&&message.recipient!==null&&message.recipient!==account))throw Error('Invalid chat event');
 const id=JSON.stringify([account,team,message.id]),iv=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id)},await key(account),new TextEncoder().encode(JSON.stringify(message)));
 const db=await open();
 const existing=await new Promise<Row|undefined>((resolve,reject)=>{
  const tx=db.transaction('events','readwrite',{durability:'strict'}),store=tx.objectStore('events');let duplicate:Row|undefined;
  const insert=store.add({id,scope:scope(account,team),created:message.created,iv,ciphertext});
  insert.onerror=e=>{if(insert.error?.name!=='ConstraintError')return;e.preventDefault();e.stopPropagation();const prior=store.get(id);prior.onsuccess=()=>{duplicate=prior.result;if(!duplicate)tx.abort();};};
  insert.onsuccess=()=>{const r=store.index('scope').getAll(scope(account,team));r.onsuccess=()=>{const rows=r.result as Row[];rows.sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id));for(const row of rows.slice(MAX_CHAT_EVENTS))store.delete(row.id);};};
  tx.oncomplete=()=>resolve(duplicate);tx.onabort=()=>reject(tx.error??Error('Event could not be saved'));
 });
 if(existing){
  const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(existing.iv),additionalData:aad(id)},await key(account),existing.ciphertext);
  if(!sameChatMessage(JSON.parse(new TextDecoder().decode(decoded)) as ChatMessage,message))throw Error('Event identity conflicts with saved history');
 }
}
/** This account's saved events for a team, oldest first. A row that no longer
 * parses is skipped rather than failing the whole conversation. */
export async function loadChatEvents(account:string,team:string):Promise<ChatMessage[]>{
 const db=await open(),localKey=await key(account);
 const rows=await new Promise<Row[]>((resolve,reject)=>{const r=db.transaction('events').objectStore('events').index('scope').getAll(scope(account,team));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const events=await Promise.all(rows.map(async row=>{
  try{const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(row.iv),additionalData:aad(row.id)},localKey,row.ciphertext);const m=JSON.parse(new TextDecoder().decode(decoded)) as ChatMessage;
   return valid(m)&&eventOf(m)&&row.id===JSON.stringify([account,team,m.id])&&row.created===m.created?m:undefined;}catch{return undefined;}
 }));
 return events.filter((m):m is ChatMessage=>!!m).sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
}
/** Removes one saved event (an edit of a message that was then deleted). Missing rows are ignored. */
export async function forgetChatEvent(account:string,team:string,eventId:string){
 scope(account,team);const db=await open();
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('events','readwrite',{durability:'strict'});tx.objectStore('events').delete(JSON.stringify([account,team,eventId]));tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Event could not be removed'));});
}
/** Local bookkeeping kept beside the events, each kind under its own scope so
 * neither `loadChatEvents` nor the events cap ever sees it:
 * - ledger: deliveries that expired unconfirmed, to backfill when the device returns
 * - tombstone: ids of deleted messages, so a late copy cannot bring one back */
export type ChatRecordKind='ledger'|'tombstone';
/** Records kept per kind, account and team; the oldest go first. */
export const MAX_CHAT_RECORDS=2000;
const recordScope=(account:string,team:string,kind:ChatRecordKind)=>{scope(account,team);if(kind!=='ledger'&&kind!=='tombstone')throw Error('Invalid chat record kind');return JSON.stringify([account,team,kind]);};
const recordId=(account:string,team:string,kind:ChatRecordKind,key:string)=>{if(typeof key!=='string'||!key||key.length>1024)throw Error('Invalid chat record key');return JSON.stringify([account,team,kind,key]);};
/** Saves (or replaces) one record, encrypted like a message. `created` orders the cap. */
export async function saveChatRecord(account:string,team:string,kind:ChatRecordKind,recordKey:string,value:unknown,created=Date.now()){
 const recordScopeId=recordScope(account,team,kind),id=recordId(account,team,kind,recordKey),iv=crypto.getRandomValues(new Uint8Array(12));
 const plain=JSON.stringify({key:recordKey,value});if(plain.length>64_000)throw Error('Chat record is too large');
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id)},await key(account),new TextEncoder().encode(plain));
 const db=await open();
 await new Promise<void>((resolve,reject)=>{
  const tx=db.transaction('events','readwrite',{durability:'strict'}),store=tx.objectStore('events');
  store.put({id,scope:recordScopeId,created,iv,ciphertext});
  const r=store.index('scope').getAll(recordScopeId);r.onsuccess=()=>{const rows=r.result as Row[];rows.sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id));for(const row of rows.slice(MAX_CHAT_RECORDS))store.delete(row.id);};
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Chat record could not be saved'));
 });
}
/** Every record of a kind, by key. A row that no longer decrypts or parses is skipped. */
export async function loadChatRecords(account:string,team:string,kind:ChatRecordKind):Promise<Record<string,unknown>>{
 const recordScopeId=recordScope(account,team,kind),db=await open(),localKey=await key(account);
 const rows=await new Promise<Row[]>((resolve,reject)=>{const r=db.transaction('events').objectStore('events').index('scope').getAll(recordScopeId);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const out:Record<string,unknown>={};
 for(const row of rows){
  try{
   const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(row.iv),additionalData:aad(row.id)},localKey,row.ciphertext);
   const parsed=JSON.parse(new TextDecoder().decode(decoded)) as {key?:unknown;value?:unknown};
   if(typeof parsed?.key==='string'&&row.id===recordId(account,team,kind,parsed.key))out[parsed.key]=parsed.value;
  }catch{/* skipped */}
 }
 return out;
}
export async function forgetChatRecords(account:string,team:string,kind:ChatRecordKind,keys:string[]){
 recordScope(account,team,kind);if(!keys.length)return;const db=await open();
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('events','readwrite',{durability:'strict'}),store=tx.objectStore('events');for(const k of keys)store.delete(recordId(account,team,kind,k));tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Chat record could not be removed'));});
}
/** Removes one of the account's own messages, used when the sender discards or
 * resends a message that was never delivered. Missing rows are ignored. */
export async function forgetChatMessage(account:string,team:string,messageId:string){
 scope(account,team);const db=await open();
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('messages','readwrite',{durability:'strict'});tx.objectStore('messages').delete(JSON.stringify([account,team,messageId]));tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Message could not be removed'));});
}
export async function loadChatHistory(account:string,team:string):Promise<ChatMessage[]>{
 const db=await open(),localKey=await key(account);
 const rows=await new Promise<Row[]>((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').index('scope').getAll(scope(account,team));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const messages=await Promise.all(rows.map(async row=>{const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(row.iv),additionalData:aad(row.id)},localKey,row.ciphertext);const message=JSON.parse(new TextDecoder().decode(decoded));if(!valid(message)||row.id!==JSON.stringify([account,team,message.id])||row.scope!==scope(account,team)||row.created!==message.created)throw Error('Chat history could not be verified');return message as ChatMessage;}));
 return messages.sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
}

/** `reads` (v3): read watermarks, the newest message of this account's that a
 * teammate has read in a conversation, keyed JSON [reader, conversation].
 * `readSent`: the watermarks this account last sent, keyed JSON [author,
 * conversation], re-sent when that author's device comes online. Both optional,
 * so state saved by 0.4.10 still loads. */
export type ChatReadState={unreadIds:string[];receipts:Record<string,string[]>;reads?:Record<string,string>;readSent?:Record<string,string>};
const stateWrites=new Map<string,Promise<void>>();
/** Entries kept in each watermark map. */
export const MAX_WATERMARKS=1000;
const validWatermarks=(value:unknown)=>value===undefined||(!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=MAX_WATERMARKS&&Object.entries(value).every(([k,id])=>k.length<=600&&typeof id==='string'&&id.length<=64));
function validState(value:ChatReadState){return value&&Array.isArray(value.unreadIds)&&value.unreadIds.length<=500&&value.unreadIds.every(id=>typeof id==='string')&&value.receipts&&typeof value.receipts==='object'&&!Array.isArray(value.receipts)&&Object.keys(value.receipts).length<=500&&Object.values(value.receipts).every(users=>Array.isArray(users)&&users.length<=512&&users.every(user=>typeof user==='string'))&&validWatermarks(value.reads)&&validWatermarks(value.readSent);}
export function saveChatReadState(account:string,team:string,state:ChatReadState):Promise<void>{
 if(!validState(state))return Promise.reject(Error('Invalid chat read state'));
 const id='state:'+scope(account,team),serialized=JSON.stringify(state);
 const write=(stateWrites.get(id)??Promise.resolve()).catch(()=>{}).then(async()=>{
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id)},await key(account),new TextEncoder().encode(serialized));
  const db=await open();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('messages','readwrite',{durability:'strict'});tx.objectStore('messages').put({id,scope:id,created:Date.now(),iv,ciphertext});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
 });
 stateWrites.set(id,write);
 void write.finally(()=>{if(stateWrites.get(id)===write)stateWrites.delete(id);}).catch(()=>{});
 return write;
}
export async function loadChatReadState(account:string,team:string):Promise<ChatReadState>{
 const id='state:'+scope(account,team);await stateWrites.get(id);
 const db=await open();const row=await new Promise<Row|undefined>((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 if(!row)return {unreadIds:[],receipts:{}};
 const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(row.iv),additionalData:aad(id)},await key(account),row.ciphertext);
 const state=JSON.parse(new TextDecoder().decode(decoded));if(!validState(state))throw Error('Chat read state could not be verified');return state;
}

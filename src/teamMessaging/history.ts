import type {ChatMessage} from './client';
import {validChatMessage as valid,sameChatMessage} from './messageSchema';
let database:Promise<IDBDatabase>|undefined;
const scope=(account:string,team:string)=>{if([account,team].some(value=>typeof value!=='string'||!value||value.length>256||/[\x00-\x1f]/.test(value)))throw Error('Invalid chat history scope');return JSON.stringify([account,team]);};
function open(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('canopy-chat-history',1);r.onupgradeneeded=()=>{r.result.createObjectStore('keys');r.result.createObjectStore('messages',{keyPath:'id'}).createIndex('scope','scope');};r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();database=undefined;};resolve(r.result);};r.onerror=()=>{database=undefined;reject(r.error);};r.onblocked=()=>{database=undefined;reject(Error('Close other Canopy windows to update chat history'));};});}
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
export async function loadChatHistory(account:string,team:string):Promise<ChatMessage[]>{
 const db=await open(),localKey=await key(account);
 const rows=await new Promise<Row[]>((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').index('scope').getAll(scope(account,team));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const messages=await Promise.all(rows.map(async row=>{const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(row.iv),additionalData:aad(row.id)},localKey,row.ciphertext);const message=JSON.parse(new TextDecoder().decode(decoded));if(!valid(message)||row.id!==JSON.stringify([account,team,message.id])||row.scope!==scope(account,team)||row.created!==message.created)throw Error('Chat history could not be verified');return message as ChatMessage;}));
 return messages.sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
}

export type ChatReadState={unreadIds:string[];receipts:Record<string,string[]>};
const stateWrites=new Map<string,Promise<void>>();
function validState(value:ChatReadState){return value&&Array.isArray(value.unreadIds)&&value.unreadIds.length<=500&&value.unreadIds.every(id=>typeof id==='string')&&value.receipts&&typeof value.receipts==='object'&&!Array.isArray(value.receipts)&&Object.keys(value.receipts).length<=500&&Object.values(value.receipts).every(users=>Array.isArray(users)&&users.length<=512&&users.every(user=>typeof user==='string'));}
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

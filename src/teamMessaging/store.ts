import {createIdentity,type Identity,type Envelope} from './crypto';
let database: Promise<IDBDatabase> | undefined;
function db() {
 return database ??= new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('canopy-peer-identities',2);
  request.onupgradeneeded=()=>{const value=request.result;if(!value.objectStoreNames.contains('identities'))value.createObjectStore('identities');if(!value.objectStoreNames.contains('replay'))value.createObjectStore('replay',{keyPath:'id'}).createIndex('expires','expires');if(!value.objectStoreNames.contains('outbox'))value.createObjectStore('outbox',{keyPath:'id'}).createIndex('scope','scope');};
  request.onsuccess=()=>{const value=request.result;value.onversionchange=()=>{value.close();database=undefined;};resolve(value);};
  request.onerror=()=>{database=undefined;reject(request.error);};
  request.onblocked=()=>{database=undefined;reject(Error('Close other Canopy windows to update secure messaging storage'));};
 });
}
export type DeviceIdentity = {id:string;keys:Identity};
/** Non-exportable private CryptoKeys are structured-cloned into the local
 * browser profile. No private key or plaintext is sent to account APIs. */
export async function deviceIdentity(accountId:string): Promise<DeviceIdentity> {
 if(!accountId||accountId.length>256)throw Error('Invalid account');
 const database=await db();
 const existing=await new Promise<DeviceIdentity|undefined>((resolve,reject)=>{const request=database.transaction('identities').objectStore('identities').get(accountId);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 if(existing)return existing;
 const candidate={id:crypto.randomUUID(),keys:await createIdentity()};
 // Recheck within the write transaction: two IDE windows must adopt one device
 // identity instead of overwriting a key already registered by the other.
 return new Promise((resolve,reject)=>{
  const transaction=database.transaction('identities','readwrite',{durability:'strict'}),store=transaction.objectStore('identities');let result:DeviceIdentity;
  const request=store.get(accountId);request.onsuccess=()=>{result=request.result??candidate;if(!request.result)store.add(candidate,accountId);};
  transaction.oncomplete=()=>resolve(result);transaction.onabort=()=>reject(transaction.error??Error('Identity persistence failed'));
 });
}
/** Unique insert is the replay gate across windows and restarts. Storage errors
 * fail closed: callers must not render a message until this resolves true. */
export async function rememberMessage(id:string,expires:number): Promise<boolean> {
 const database=await db();return new Promise((resolve,reject)=>{
  const transaction=database.transaction('replay','readwrite',{durability:'strict'});let duplicate=false;
  const store=transaction.objectStore('replay');
  const stale=store.index('expires').openCursor(IDBKeyRange.upperBound(Date.now()));stale.onsuccess=()=>{if(stale.result){stale.result.delete();stale.result.continue();}};
  const request=store.add({id,expires});
  request.onerror=event=>{if(request.error?.name==='ConstraintError'){duplicate=true;event.preventDefault();event.stopPropagation();}};
  transaction.oncomplete=()=>resolve(!duplicate);transaction.onabort=()=>reject(transaction.error??Error('Replay protection storage failed'));
 });
}
export async function pruneExpiredMessages(now=Date.now()):Promise<void>{
 const database=await db();await new Promise<void>((resolve,reject)=>{
  const tx=database.transaction('replay','readwrite',{durability:'strict'});const cursor=tx.objectStore('replay').index('expires').openCursor(IDBKeyRange.upperBound(now));
  cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}};
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
 });
}


export type PendingEnvelope={envelope:Envelope;messageId:string};
export type MessageOutbox={load:()=>Promise<PendingEnvelope[]>;put:(row:PendingEnvelope)=>Promise<void>;remove:(ids:string[])=>Promise<void>};
/** Only signed ciphertext is retained. Scope binds pending deliveries to the
 * exact account/team; membership is rechecked before every retry. */
export function messageOutbox(account:string,team:string):MessageOutbox {
 const scope=JSON.stringify([account,team]),key=(id:string)=>JSON.stringify([account,team,id]);
 return {
  async load(){const database=await db();return new Promise((resolve,reject)=>{
   const tx=database.transaction('outbox','readwrite',{durability:'strict'}),store=tx.objectStore('outbox');let rows:PendingEnvelope[]=[];
   const request=store.index('scope').getAll(scope);request.onsuccess=()=>{for(const row of request.result){if(row.envelope.expires<=Date.now())store.delete(row.id);else rows.push({envelope:row.envelope,messageId:row.messageId});}};
   tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error??Error('Pending delivery could not be restored'));
  });},
  async put(row){if(row.envelope.from.user!==account||row.envelope.from.team!==team||typeof row.messageId!=='string')throw Error('Invalid pending delivery scope');
   const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction('outbox','readwrite',{durability:'strict'}),store=tx.objectStore('outbox');let capacity=false;
    const request=store.index('scope').count(scope);request.onsuccess=()=>{if(request.result>=500){capacity=true;tx.abort();}else store.put({...row,id:key(row.envelope.id),scope});};
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(capacity?Error('Wait for pending messages to finish sending'):tx.error??Error('Pending delivery could not be saved'));
   });},
  async remove(ids){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('outbox','readwrite',{durability:'strict'}),store=tx.objectStore('outbox');for(const id of ids)store.delete(key(id));tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}
 };
}

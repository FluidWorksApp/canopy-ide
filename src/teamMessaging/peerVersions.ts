import type {PublicIdentity} from './crypto';

/** What this device last learned about another device's chat protocol version,
 * bound to that device's public keys: a device that re-registers with new keys
 * (a reinstall, possibly an older build) starts again as unknown. */
export type VersionEntry={chat:number;keyFp:string;at:number};
export type VersionStore={load:()=>Record<string,VersionEntry>;save:(entries:Record<string,VersionEntry>)=>void};
/** Devices remembered per account and team; the least recently confirmed go first. */
export const MAX_VERSION_ENTRIES=500;

/** FNV-1a (64-bit) of the device's public keys. Only detects a change of keys,
 * so it need not be cryptographic: the keys themselves are verified elsewhere. */
export function keyFingerprint(keys:PublicIdentity):string{
 const text=JSON.stringify([keys?.agreement?.x,keys?.agreement?.y,keys?.signing?.x,keys?.signing?.y]);
 let hash=0xcbf29ce484222325n;
 for(const byte of new TextEncoder().encode(text)){hash^=BigInt(byte);hash=(hash*0x100000001b3n)&0xffffffffffffffffn;}
 return hash.toString(16).padStart(16,'0');
}
const validEntry=(e:VersionEntry)=>!!e&&typeof e==='object'&&Number.isSafeInteger(e.chat)&&e.chat>=1&&typeof e.keyFp==='string'&&/^[a-f0-9]{16}$/.test(e.keyFp)&&Number.isSafeInteger(e.at);
/** localStorage, scoped per account and team. Every access may throw (storage
 * disabled, quota, a private window); a failure means "nothing remembered". */
export function localVersionStore(account:string,team:string,storage:()=>Storage|undefined=()=>globalThis.localStorage):VersionStore{
 const key='canopy-chat-versions:'+JSON.stringify([account,team]);
 return {
  load(){
   try{
    const parsed=JSON.parse(storage()?.getItem(key)??'{}') as Record<string,VersionEntry>;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id,e])=>typeof id==='string'&&id.length<=256&&validEntry(e)).slice(-MAX_VERSION_ENTRIES));
   }catch{return {};}
  },
  save(entries){try{storage()?.setItem(key,JSON.stringify(entries));}catch{/* still known for this session */}},
 };
}
/** Per-device chat versions: learned from signals and messages, remembered
 * across restarts, forgotten when a device's keys change. */
export class PeerVersions{
 private entries:Record<string,VersionEntry>;
 private store:VersionStore;private now:()=>number;
 constructor(store:VersionStore,now:()=>number=Date.now){this.store=store;this.now=now;this.entries=store.load();}
 /** The chat version of a device with these keys; 1 (v1) when unknown. */
 get(deviceId:string,keys:PublicIdentity):number{
  const entry=this.entries[deviceId];if(!entry)return 1;
  if(entry.keyFp!==keyFingerprint(keys)){delete this.entries[deviceId];this.store.save(this.entries);return 1;}
  return entry.chat;
 }
 learn(deviceId:string,keys:PublicIdentity,version:unknown){
  if(!Number.isSafeInteger(version)||(version as number)<1)return;
  const keyFp=keyFingerprint(keys),prior=this.entries[deviceId],at=this.now();
  // Same keys: only an upgrade is news (and refreshes recency at most once a minute).
  if(prior&&prior.keyFp===keyFp&&prior.chat>=(version as number)&&at-prior.at<60_000)return;
  const chat=prior&&prior.keyFp===keyFp?Math.max(prior.chat,version as number):version as number;
  const {[deviceId]:_old,...rest}=this.entries;
  const kept=Object.entries(rest).sort(([,a],[,b])=>a.at-b.at).slice(-(MAX_VERSION_ENTRIES-1));
  this.entries={...Object.fromEntries(kept),[deviceId]:{chat,keyFp,at}};
  this.store.save(this.entries);
 }
}

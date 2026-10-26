import {expect,it} from 'vitest';
import {PeerVersions,keyFingerprint,localVersionStore,MAX_VERSION_ENTRIES} from './peerVersions';
import type {PublicIdentity} from './crypto';

const keys=(seed:string):PublicIdentity=>({agreement:{kty:'EC',crv:'P-256',x:`ax-${seed}`,y:`ay-${seed}`},signing:{kty:'EC',crv:'P-256',x:`sx-${seed}`,y:`sy-${seed}`}});
/** A Storage stand-in; `broken` makes every access throw like a disabled or full localStorage. */
function memoryStorage(broken=false){
 const data=new Map<string,string>();
 const fail=()=>{if(broken)throw new DOMException('denied','SecurityError');};
 return {data,storage:{getItem:(k:string)=>{fail();return data.get(k)??null;},setItem:(k:string,v:string)=>{fail();data.set(k,v);},removeItem:(k:string)=>{data.delete(k);},clear:()=>data.clear(),key:()=>null,length:0} as Storage};
}

it('remembers a learned version across restarts, per account and team',()=>{
 const {storage,data}=memoryStorage();
 const first=new PeerVersions(localVersionStore('me','core',()=>storage));
 expect(first.get('dev-1',keys('a'))).toBe(1);
 first.learn('dev-1',keys('a'),2);
 expect(first.get('dev-1',keys('a'))).toBe(2);
 // A new client (an IDE restart) reads it back before any traffic.
 expect(new PeerVersions(localVersionStore('me','core',()=>storage)).get('dev-1',keys('a'))).toBe(2);
 // Another team or account does not see it.
 expect(new PeerVersions(localVersionStore('me','other',()=>storage)).get('dev-1',keys('a'))).toBe(1);
 expect(new PeerVersions(localVersionStore('you','core',()=>storage)).get('dev-1',keys('a'))).toBe(1);
 // Only a fingerprint of the keys is stored.
 expect([...data.values()].join('')).not.toContain('ax-a');
});

it('forgets a device whose keys changed, and never downgrades with the same keys',()=>{
 const {storage}=memoryStorage();
 const versions=new PeerVersions(localVersionStore('me','core',()=>storage));
 versions.learn('dev-1',keys('a'),2);
 expect(versions.get('dev-1',keys('b'))).toBe(1);
 // The reset is saved, so a restart does not bring the old version back.
 expect(new PeerVersions(localVersionStore('me','core',()=>storage)).get('dev-1',keys('a'))).toBe(1);
 versions.learn('dev-1',keys('b'),3);versions.learn('dev-1',keys('b'),2);
 expect(versions.get('dev-1',keys('b'))).toBe(3);
 versions.learn('dev-1',keys('b'),'2');versions.learn('dev-1',keys('b'),undefined);
 expect(versions.get('dev-1',keys('b'))).toBe(3);
 expect(keyFingerprint(keys('a'))).toMatch(/^[a-f0-9]{16}$/);expect(keyFingerprint(keys('a'))).not.toBe(keyFingerprint(keys('b')));
});

it('keeps at most MAX_VERSION_ENTRIES devices, dropping the least recently confirmed',()=>{
 const {storage}=memoryStorage();let now=0;
 const versions=new PeerVersions(localVersionStore('me','core',()=>storage),()=>++now);
 for(let i=0;i<MAX_VERSION_ENTRIES+3;i++)versions.learn(`dev-${i}`,keys(String(i)),2);
 const restored=new PeerVersions(localVersionStore('me','core',()=>storage));
 expect(restored.get('dev-0',keys('0'))).toBe(1);expect(restored.get('dev-2',keys('2'))).toBe(1);
 expect(restored.get('dev-3',keys('3'))).toBe(2);expect(restored.get(`dev-${MAX_VERSION_ENTRIES+2}`,keys(String(MAX_VERSION_ENTRIES+2)))).toBe(2);
});

it('works without storage: unavailable, throwing or holding garbage',()=>{
 const {storage}=memoryStorage(true);
 const broken=new PeerVersions(localVersionStore('me','core',()=>storage));
 expect(()=>broken.learn('dev-1',keys('a'),2)).not.toThrow();
 expect(broken.get('dev-1',keys('a'))).toBe(2);
 expect(new PeerVersions(localVersionStore('me','core',()=>undefined)).get('dev-1',keys('a'))).toBe(1);
 const junk=memoryStorage();
 junk.data.set('canopy-chat-versions:'+JSON.stringify(['me','core']),'{not json');
 expect(new PeerVersions(localVersionStore('me','core',()=>junk.storage)).get('dev-1',keys('a'))).toBe(1);
 junk.data.set('canopy-chat-versions:'+JSON.stringify(['me','core']),JSON.stringify({'dev-1':{chat:'2',keyFp:'x',at:1}}));
 expect(new PeerVersions(localVersionStore('me','core',()=>junk.storage)).get('dev-1',keys('a'))).toBe(1);
});

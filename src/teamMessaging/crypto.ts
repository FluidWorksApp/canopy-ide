/** Endpoint encryption. The directory/control plane supplies authenticated public
 * keys; a relay is only allowed to carry these opaque envelopes. */
export type Identity = { agreement: CryptoKeyPair; signing: CryptoKeyPair };
export type PublicIdentity = { agreement: JsonWebKey; signing: JsonWebKey };
export type Address = { team: string; user: string; device: string };
export type EnvelopeKind = 'chat'|'mesh'|'job'|'job-status';
export type WorkspaceAddress = Address & { workspace?: string };
type Sealed = { id: string; from: Address; created: number; expires: number; ephemeral: JsonWebKey; iv: string; ciphertext: string; signature: string };
export type EnvelopeV1 = Sealed & { version: 1; to: Address };
/** Relay v2 (protocol §6.1): kind and workspace are bound into the signed header. */
export type EnvelopeV2 = Sealed & { version: 2; kind: EnvelopeKind; to: WorkspaceAddress };
export type Envelope = EnvelopeV1 | EnvelopeV2;
export const ENVELOPE_KINDS: readonly EnvelopeKind[] = ['chat','mesh','job','job-status'];
export const PERSON_TTL_MS = 300000;
export const WORKSPACE_TTL_MS = 604800000;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Validity of the v2 routing fields and lifetime, shared by seal and open. */
export function validV2(e: Pick<EnvelopeV2,'kind'|'to'|'created'|'expires'>) {
 if(!ENVELOPE_KINDS.includes(e.kind)) return false;
 const workspace=e.to?.workspace;
 if(workspace===undefined) return e.kind==='chat' && e.expires-e.created===PERSON_TTL_MS;
 if(typeof workspace!=='string' || !WORKSPACE_ID.test(workspace)) return false;
 const life=e.expires-e.created;return life>0 && life<=WORKSPACE_TTL_MS;
}
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const encode = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value instanceof Uint8Array ? value : value)));
function decode(value: string, maximum: number) {
 if(typeof value !== 'string' || value.length > maximum * 2) throw Error('Invalid message encoding');
 let result: Uint8Array<ArrayBuffer>; try { result = Uint8Array.from(atob(value), char => char.charCodeAt(0)); } catch { throw Error('Invalid message encoding'); }
 if(result.length > maximum || encode(result) !== value) throw Error('Invalid message encoding');
 return result;
}
function publicKey(jwk: JsonWebKey): JsonWebKey {
 if(!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || jwk.x.length !== 43 || jwk.y.length !== 43 || jwk.d) throw Error('Invalid public identity');
 return { kty:'EC', crv:'P-256', x:jwk.x, y:jwk.y };
}
const address = (a: Address) => {
 if(!a || [a.team,a.user,a.device].some(v => typeof v !== 'string' || !v || v.length > 256)) throw Error('Invalid peer address');
 return [a.team,a.user,a.device];
};
const same = (a: Address,b: Address) => JSON.stringify(address(a)) === JSON.stringify(address(b));
function header(e: Envelope) {
 const key=publicKey(e.ephemeral);
 if(e.version===2) return bytes(JSON.stringify([2,e.id,address(e.from),[...address(e.to),e.to.workspace ?? null],e.kind,e.created,e.expires,key.x,key.y,e.iv]));
 return bytes(JSON.stringify([e.version,e.id,address(e.from),address(e.to),e.created,e.expires,key.x,key.y,e.iv]));
}
const signed = (e: Envelope) => bytes(JSON.stringify([new TextDecoder().decode(header(e)),e.ciphertext]));
async function encryptionKey(privateKey: CryptoKey, other: JsonWebKey, context: Uint8Array<ArrayBuffer>) {
 const peer=await crypto.subtle.importKey('jwk',publicKey(other),{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},privateKey,256);
 const material=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:bytes('canopy-im-v1'),info:context},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function createIdentity(): Promise<Identity> {
 return {agreement:await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']),signing:await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify'])};
}
export async function publicIdentity(identity: Identity): Promise<PublicIdentity> {
 return {agreement:publicKey(await crypto.subtle.exportKey('jwk',identity.agreement.publicKey)),signing:publicKey(await crypto.subtle.exportKey('jwk',identity.signing.publicKey))};
}
export type SealOptions = { version: 2; kind: EnvelopeKind; workspace?: string; ttl?: number };
export async function seal(identity: Identity, recipient: PublicIdentity, from: Address, to: Address, text: string, now=Date.now(), v2?: SealOptions): Promise<Envelope> {
 address(from);address(to);if(from.team !== to.team || typeof text !== 'string' || !text.trim() || bytes(text).length > 32000) throw Error('Invalid message');
 const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
 const id=crypto.randomUUID(),key0=publicKey(await crypto.subtle.exportKey('jwk',ephemeral.publicKey)),iv=encode(crypto.getRandomValues(new Uint8Array(12)));
 let envelope: Envelope;
 if(v2){
  const target: WorkspaceAddress={team:to.team,user:to.user,device:to.device,...(v2.workspace!==undefined?{workspace:v2.workspace}:{})};
  envelope={version:2,id,kind:v2.kind,from:{team:from.team,user:from.user,device:from.device},to:target,created:now,expires:now+(v2.ttl ?? (v2.workspace!==undefined?WORKSPACE_TTL_MS:PERSON_TTL_MS)),ephemeral:key0,iv,ciphertext:'',signature:''};
  if(!validV2(envelope)) throw Error('Invalid workspace envelope');
 } else envelope={version:1,id,from:{...from},to:{...to},created:now,expires:now+PERSON_TTL_MS,ephemeral:key0,iv,ciphertext:'',signature:''};
 const context=header(envelope),key=await encryptionKey(ephemeral.privateKey,recipient.agreement,context);
 envelope.ciphertext=encode(await crypto.subtle.encrypt({name:'AES-GCM',iv:decode(envelope.iv,12),additionalData:context},key,bytes(text)));
 envelope.signature=encode(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},identity.signing.privateKey,signed(envelope)));
 return envelope;
}
/** remember must atomically persist the replay ID, returning false if already
 * present. Resolve this before delivering plaintext, including after restart. */
export class MessageReplayError extends Error { readonly plaintext:string;constructor(plaintext:string){super('Message replay refused');this.plaintext=plaintext;} }
export async function open(identity: Identity, sender: PublicIdentity, expectedFrom: Address, expectedTo: Address, envelope: Envelope, remember: (id: string, expires: number) => Promise<boolean>, now=Date.now(),admit?: (text:string)=>Promise<void>): Promise<string> {
 if((envelope?.version!==1 && envelope?.version!==2) || !/^[a-f0-9-]{36}$/.test(envelope.id) || !same(envelope.from,expectedFrom) || !same(envelope.to,expectedTo) || expectedFrom.team!==expectedTo.team || !Number.isSafeInteger(envelope.created) || !Number.isSafeInteger(envelope.expires) || envelope.created>now+30000 || envelope.expires<=now || (envelope.version===1 ? envelope.expires-envelope.created!==PERSON_TTL_MS : !validV2(envelope))) throw Error('Invalid or expired message');
 const context=header(envelope),ciphertext=decode(envelope.ciphertext,32016),iv=decode(envelope.iv,12);
 if(iv.length!==12)throw Error('Invalid message nonce');
 const verification=await crypto.subtle.importKey('jwk',publicKey(sender.signing),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},verification,decode(envelope.signature,64),signed(envelope)))throw Error('Message authentication failed');
 const key=await encryptionKey(identity.agreement.privateKey,envelope.ephemeral,context);
 const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:context},key,ciphertext);
 const text=new TextDecoder('utf-8',{fatal:true}).decode(plaintext);
 const replayId=JSON.stringify([address(expectedFrom),address(expectedTo),envelope.id]);
 if(admit)await admit(text);
 if(!await remember(replayId,envelope.expires))throw new MessageReplayError(text);
 return text;
}
/** Proves possession when binding this device to the authenticated account. */
export async function registration(identity: Identity, userId: string, deviceId: string, created=Date.now()) {
 const keys=await publicIdentity(identity);
 const payload=JSON.stringify(['canopy-device-v1',userId,deviceId,created,keys.agreement.x,keys.agreement.y,keys.signing.x,keys.signing.y]);
 const proof=encode(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},identity.signing.privateKey,bytes(payload)));
 return {action:'register',deviceId,created,keys,proof};
}

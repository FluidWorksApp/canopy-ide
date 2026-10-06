/** Endpoint encryption. The directory/control plane supplies authenticated public
 * keys; a relay is only allowed to carry these opaque envelopes. */
export type Identity = { agreement: CryptoKeyPair; signing: CryptoKeyPair };
export type PublicIdentity = { agreement: JsonWebKey; signing: JsonWebKey };
export type Address = { team: string; user: string; device: string };
export type Envelope = { version: 1; id: string; from: Address; to: Address; created: number; expires: number; ephemeral: JsonWebKey; iv: string; ciphertext: string; signature: string };
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
export async function seal(identity: Identity, recipient: PublicIdentity, from: Address, to: Address, text: string, now=Date.now()): Promise<Envelope> {
 address(from);address(to);if(from.team !== to.team || typeof text !== 'string' || !text.trim() || bytes(text).length > 32000) throw Error('Invalid message');
 const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
 const envelope: Envelope={version:1,id:crypto.randomUUID(),from:{...from},to:{...to},created:now,expires:now+300000,ephemeral:publicKey(await crypto.subtle.exportKey('jwk',ephemeral.publicKey)),iv:encode(crypto.getRandomValues(new Uint8Array(12))),ciphertext:'',signature:''};
 const context=header(envelope),key=await encryptionKey(ephemeral.privateKey,recipient.agreement,context);
 envelope.ciphertext=encode(await crypto.subtle.encrypt({name:'AES-GCM',iv:decode(envelope.iv,12),additionalData:context},key,bytes(text)));
 envelope.signature=encode(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},identity.signing.privateKey,signed(envelope)));
 return envelope;
}
/** remember must atomically persist the replay ID, returning false if already
 * present. Resolve this before delivering plaintext, including after restart. */
export class MessageReplayError extends Error { readonly plaintext:string;constructor(plaintext:string){super('Message replay refused');this.plaintext=plaintext;} }
export async function open(identity: Identity, sender: PublicIdentity, expectedFrom: Address, expectedTo: Address, envelope: Envelope, remember: (id: string, expires: number) => Promise<boolean>, now=Date.now(),admit?: (text:string)=>Promise<void>): Promise<string> {
 if(envelope?.version!==1 || !/^[a-f0-9-]{36}$/.test(envelope.id) || !same(envelope.from,expectedFrom) || !same(envelope.to,expectedTo) || expectedFrom.team!==expectedTo.team || !Number.isSafeInteger(envelope.created) || !Number.isSafeInteger(envelope.expires) || envelope.created>now+30000 || envelope.expires<=now || envelope.expires-envelope.created!==300000) throw Error('Invalid or expired message');
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

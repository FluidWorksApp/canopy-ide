// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {beforeAll,expect,it,vi} from 'vitest';
import {createIdentity,publicIdentity,seal,open,type Envelope,type Identity,type PublicIdentity} from './crypto';
import vector from './fixtures/relay-v2-vector.json';
beforeAll(()=>vi.stubGlobal('crypto',webcrypto));
const remember=async()=>true;
async function recipient():Promise<Identity>{
 const priv=await webcrypto.subtle.importKey('jwk',vector.recipient.agreementPrivateJwk,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']) as unknown as CryptoKey;
 const signing=(await createIdentity()).signing;
 return {agreement:{privateKey:priv,publicKey:priv},signing};
}
const sender=vector.sender.publicKeys as PublicIdentity,from=vector.sender.address,to=vector.recipient.address;
it('opens the shared v2 vectors',async()=>{
 const identity=await recipient();
 expect(vector.testOnly).toBe(true);
 for(const v of vector.vectors){
  const envelope=v.envelope as Envelope;
  expect(envelope.version).toBe(2);
  expect(await open(identity,sender,from,to,envelope,remember,vector.created+1)).toBe(v.plaintext);
 }
 const job=vector.vectors[0].envelope as Envelope;
 expect(job.expires-job.created).toBe(604800000);
 expect(await open(identity,sender,from,to,job,remember,vector.created+604799000)).toBe(vector.vectors[0].plaintext);
 await expect(open(identity,sender,from,to,job,remember,vector.created+604800000)).rejects.toThrow('expired');
});
it('binds kind and workspace into the signed header',async()=>{
 const identity=await recipient();
 const edits:((e:Envelope&{version:2})=>void)[]=[e=>{e.kind='mesh';},e=>{e.to.workspace='ws-99999999-9999-4999-8999-999999999999';},e=>{delete e.to.workspace;e.kind='chat';e.expires=e.created+300000;},e=>{e.expires-=1000;}];
 for(const edit of edits){
  const e=structuredClone(vector.vectors[0].envelope) as Envelope&{version:2};edit(e);
  await expect(open(identity,sender,from,to,e,remember,vector.created+1)).rejects.toThrow();
 }
 const downgraded={...structuredClone(vector.vectors[0].envelope),version:1} as unknown as Envelope;
 await expect(open(identity,sender,from,to,downgraded,remember,vector.created+1)).rejects.toThrow();
 const unknown={...structuredClone(vector.vectors[0].envelope),version:3} as unknown as Envelope;
 await expect(open(identity,sender,from,to,unknown,remember,vector.created+1)).rejects.toThrow('Invalid');
});
it('seals v2 within the lifetime and routing rules',async()=>{
 const a=await createIdentity(),b=await createIdentity(),bk=await publicIdentity(b),ak=await publicIdentity(a);
 const ws='ws-22222222-2222-4222-8222-222222222222';
 const e=await seal(a,bk,from,to,'{"kind":"job"}',1000,{version:2,kind:'job',workspace:ws});
 expect(e).toMatchObject({version:2,kind:'job',to:{workspace:ws},expires:1000+604800000});
 expect(await open(b,ak,from,to,e,remember,2000)).toBe('{"kind":"job"}');
 await expect(seal(a,bk,from,to,'x',1000,{version:2,kind:'job'})).rejects.toThrow('workspace');
 await expect(seal(a,bk,from,to,'x',1000,{version:2,kind:'mesh',workspace:ws,ttl:604800001})).rejects.toThrow('workspace');
 await expect(seal(a,bk,from,to,'x',1000,{version:2,kind:'mesh',workspace:'bad/id'})).rejects.toThrow('workspace');
 const chat=await seal(a,bk,from,to,'hi',1000,{version:2,kind:'chat'});
 expect(chat.expires-chat.created).toBe(300000);
 const v1=await seal(a,bk,from,to,'hi',1000);
 expect(Object.keys(v1)).toEqual(['version','id','from','to','created','expires','ephemeral','iv','ciphertext','signature']);
});

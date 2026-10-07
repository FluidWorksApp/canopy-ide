// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {beforeAll,expect,it,vi} from 'vitest';
import {createIdentity,publicIdentity,seal,open,type Envelope} from './crypto';
beforeAll(()=>vi.stubGlobal('crypto',webcrypto));
const from={team:'team',user:'alice',device:'alice-laptop'},to={team:'team',user:'bob',device:'bob-laptop'};
async function fixture(){const alice=await createIdentity(),bob=await createIdentity(),sender=await publicIdentity(alice),recipient=await publicIdentity(bob);return {alice,bob,sender,recipient,envelope:await seal(alice,recipient,from,to,'Private message',1000000)};}
it('only the recipient can open an authenticated message',async()=>{const f=await fixture();const remember=vi.fn().mockResolvedValue(true);expect(await open(f.bob,f.sender,from,to,f.envelope,remember,1000001)).toBe('Private message');await expect(open(f.alice,f.sender,from,to,f.envelope,remember,1000001)).rejects.toThrow();expect(remember).toHaveBeenCalledTimes(1);expect(JSON.stringify(f.envelope)).not.toContain('Private message');});
it('rejects relay tampering with payload, recipient, team or ephemeral identity',async()=>{const f=await fixture();for(const modify of [(e:Envelope)=>{e.ciphertext='AAAA';},(e:Envelope)=>{e.to.user='mallory';},(e:Envelope)=>{e.from.team='other';},(e:Envelope)=>{e.ephemeral.x=f.recipient.agreement.x;}]){const e=structuredClone(f.envelope);modify(e);const remember=vi.fn();await expect(open(f.bob,f.sender,from,to,e,remember,1000001)).rejects.toThrow();expect(remember).not.toHaveBeenCalled();}});
it('rejects substituted signing identities, expired messages and durable replay',async()=>{const f=await fixture();const seen=new Set();const remember=async(id:string)=>{if(seen.has(id))return false;seen.add(id);return true;};await expect(open(f.bob,f.recipient,from,to,f.envelope,remember,1000001)).rejects.toThrow('authentication');await open(f.bob,f.sender,from,to,f.envelope,remember,1000001);await expect(open(f.bob,f.sender,from,to,f.envelope,remember,1000002)).rejects.toThrow('replay');await expect(open(f.bob,f.sender,from,to,f.envelope,remember,1300000)).rejects.toThrow('expired');});
it('never delivers plaintext if replay persistence fails',async()=>{const f=await fixture();await expect(open(f.bob,f.sender,from,to,f.envelope,async()=>{throw Error('Disk unavailable');},1000001)).rejects.toThrow('Disk unavailable');});
it('produces registration and message signatures accepted by the control plane',async()=>{
 const {registration}=await import('./crypto');
 const {registrationProof,relayEnvelope}=await import('../../packages/control-plane/lib/peer-messaging.mjs');
 const f=await fixture(),registered=await registration(f.alice,from.user,'12345678-1234-1234-1234-123456789abc',1000000);
 expect(registrationProof(from.user,registered,1000000)).toEqual(f.sender);
 expect(()=>registrationProof('other-user',registered,1000000)).toThrow('signature');
 expect(relayEnvelope({teamId:from.team,envelope:f.envelope},from.user,{id:from.device,public_keys:f.sender},{id:to.device,user_id:to.user},1000001).ciphertext).toBe(f.envelope.ciphertext);
});

it('persists verified plaintext before replay admission, retaining retry after storage failure',async()=>{const f=await fixture();const remember=vi.fn().mockResolvedValue(true),admit=vi.fn().mockRejectedValueOnce(Error('History disk full'));await expect(open(f.bob,f.sender,from,to,f.envelope,remember,1000001,admit)).rejects.toThrow('History disk full');expect(remember).not.toHaveBeenCalled();admit.mockResolvedValueOnce(undefined);await open(f.bob,f.sender,from,to,f.envelope,remember,1000001,admit);expect(remember).toHaveBeenCalledTimes(1);});

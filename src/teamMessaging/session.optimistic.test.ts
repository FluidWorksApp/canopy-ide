import {afterEach,expect,it,vi} from 'vitest';
type Result={id:string;queued:boolean;partial:boolean};
const mocks=vi.hoisted(()=>({
 options:[] as any[],
 send:vi.fn(),discard:vi.fn(async()=>{}),
 start:vi.fn(async()=>{}),
}));
vi.mock('./client',()=>({PeerClient:class{constructor(options:unknown){mocks.options.push(options);}start=mocks.start;stop=vi.fn();send=mocks.send;discard=mocks.discard;}}));
vi.mock('./history',()=>({loadChatHistory:vi.fn(async()=>[]),saveChatMessage:vi.fn(async()=>{}),forgetChatMessage:vi.fn(async()=>{}),loadChatReadState:vi.fn(async()=>({unreadIds:[],receipts:{}})),saveChatReadState:vi.fn(async()=>{})}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({user:{id:'me'}}))}));
import {teamSession,clearTeamSessions} from './session';
import * as history from './history';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
let team=0;
async function open(){
 const session=teamSession(`team-${++team}`,'me');const release=session.retain();await flush();
 const events=mocks.options.at(-1);events.status('Connected · end-to-end encrypted');
 return {session,events,release,state:(id:string)=>session.getSnapshot().delivery[id]?.state};
}
afterEach(()=>{clearTeamSessions();mocks.send.mockReset();mocks.discard.mockClear();vi.unstubAllGlobals();});

it('shows the message immediately, before encryption or delivery resolves',async()=>{
 const {session,events}=await open();const pending=deferred<Result>();mocks.send.mockReturnValueOnce(pending.promise);
 const sent=session.send('Hello team',null);
 const [message]=session.getSnapshot().messages;
 expect(message).toMatchObject({sender:'me',recipient:null,text:'Hello team'});
 expect(session.getSnapshot().delivery[message.id]).toEqual({state:'sending'});
 expect(history.saveChatMessage).toHaveBeenCalledWith('me',expect.any(String),message);
 await flush();
 // The transport sends with the client-generated id and timestamp.
 expect(mocks.send).toHaveBeenCalledWith('Hello team',null,{id:message.id,created:message.created});
 pending.resolve({id:message.id,queued:false,partial:false});
 await expect(sent).resolves.toEqual({id:message.id,delivery:{state:'sent'}});
 events.receipt(message.id,'ada');
 expect(session.getSnapshot().receipts[message.id]).toEqual(['ada']);
});

it('moves through queued, relayed and expired states',async()=>{
 const {session,events,state}=await open();mocks.send.mockImplementation(async(_t:string,_r:string,draft:{id:string})=>({id:draft.id,queued:true,partial:false}));
 const {id}=await session.send('Later',null);expect(state(id)).toBe('queued');
 events.relayed(id);expect(state(id)).toBe('sent');
 events.expired(id);expect(state(id)).toBe('expired');
 const partial=await (mocks.send.mockResolvedValueOnce({id:'x',queued:false,partial:true}),session.send('Some',null));
 expect(partial.delivery).toEqual({state:'sent',detail:'Some devices could not be reached; delivery will retry.'});
 // A receipt is final: a later expiry of another device's copy does not demote it.
 events.receipt(partial.id,'ada');events.expired(partial.id);expect(state(partial.id)).toBe('sent');
});

it('keeps a failed message with its text and lets the sender retry or discard it',async()=>{
 const {session,state}=await open();mocks.send.mockRejectedValueOnce(Error('No recipient devices are registered yet.'));
 const {id}=await session.send('Important note',null);
 expect(session.getSnapshot().delivery[id]).toEqual({state:'failed',detail:'No recipient devices are registered yet.'});
 expect(session.getSnapshot().messages.map(m=>m.text)).toEqual(['Important note']);
 mocks.send.mockImplementationOnce(async(_t:string,_r:string,draft:{id:string})=>({id:draft.id,queued:false,partial:false}));
 const retried=await session.retry(id);
 expect(retried.id).not.toBe(id);expect(state(retried.id)).toBe('sent');
 expect(session.getSnapshot().messages.map(m=>[m.id,m.text])).toEqual([[retried.id,'Important note']]);
 await flush();
 expect(history.forgetChatMessage).toHaveBeenCalledWith('me',expect.any(String),id);
 await expect(session.retry(retried.id)).rejects.toThrow('cannot be resent');

 mocks.send.mockRejectedValueOnce(Error('Team not found'));
 const failed=await session.send('Discard me',null);
 session.discard(failed.id);
 expect(session.getSnapshot().messages.map(m=>m.text)).toEqual(['Important note']);
 await flush();
 expect(mocks.discard).toHaveBeenCalledWith(failed.id);expect(history.forgetChatMessage).toHaveBeenCalledWith('me',expect.any(String),failed.id);
});

it('reconciles the transport echo by client id without duplicating or counting it unread',async()=>{
 const {session,events}=await open();
 mocks.send.mockImplementationOnce(async(text:string,recipient:string|null,draft:{id:string;created:number})=>{events.message({id:draft.id,sender:'me',recipient,text,created:draft.created});return {id:draft.id,queued:false,partial:false};});
 const {id}=await session.send('Once',null);
 events.message({...session.getSnapshot().messages[0]});
 expect(session.getSnapshot().messages.map(m=>m.id)).toEqual([id]);
 expect(session.getSnapshot().unreadIds).toEqual([]);
});

it('keeps order for rapid sends and sends them one at a time',async()=>{
 const {session}=await open();const gates=[deferred<void>(),deferred<void>(),deferred<void>()];const calls:string[]=[];
 mocks.send.mockImplementation(async(text:string,_r:unknown,draft:{id:string})=>{calls.push(text);await gates[calls.length-1].promise;return {id:draft.id,queued:false,partial:false};});
 const sends=['one','two','three'].map(text=>session.send(text,null));
 const listed=session.getSnapshot().messages;
 expect(listed.map(m=>m.text)).toEqual(['one','two','three']);
 expect(listed[0].created).toBeLessThan(listed[1].created);expect(listed[1].created).toBeLessThan(listed[2].created);
 await flush();expect(calls).toEqual(['one']);
 gates[0].resolve();await flush();expect(calls).toEqual(['one','two']);
 gates[1].resolve();gates[2].resolve();await Promise.all(sends);
 expect(calls).toEqual(['one','two','three']);
 expect(Object.values(session.getSnapshot().delivery).map(d=>d.state)).toEqual(['sent','sent','sent']);
});

it('keeps messages sent before history finishes restoring',async()=>{
 const restore=deferred<any[]>();vi.mocked(history.loadChatHistory).mockReturnValueOnce(restore.promise);
 const session=teamSession('slow-history','me');session.retain();await flush();
 mocks.send.mockImplementation(async(_t:string,_r:unknown,draft:{id:string})=>({id:draft.id,queued:false,partial:false}));
 const sent=session.send('Typed fast',null);expect(session.getSnapshot().messages).toHaveLength(1);
 restore.resolve([{id:'11111111-1111-4111-8111-111111111111',sender:'ada',recipient:null,text:'Earlier',created:1}]);
 await sent;
 expect(session.getSnapshot().messages.map(m=>m.text)).toEqual(['Earlier','Typed fast']);
});

it('restores a pending message once after restart and marks unconfirmed ones as not delivered',async()=>{
 const queued={id:'22222222-2222-4222-8222-222222222222',sender:'me',recipient:null,text:'Still queued',created:1};
 const lost={id:'33333333-3333-4333-8333-333333333333',sender:'me',recipient:null,text:'Expired while closed',created:2};
 const delivered={id:'44444444-4444-4444-8444-444444444444',sender:'me',recipient:null,text:'Delivered',created:3};
 vi.mocked(history.loadChatHistory).mockResolvedValueOnce([queued,lost,delivered]);
 vi.mocked(history.loadChatReadState).mockResolvedValueOnce({unreadIds:[],receipts:{[delivered.id]:['ada']}});
 mocks.start.mockImplementationOnce(async()=>{mocks.options.at(-1).pending([queued.id]);});
 const session=teamSession('restart','me');session.retain();await flush();
 expect(session.getSnapshot().delivery).toEqual({[queued.id]:{state:'queued'},[lost.id]:{state:'expired'}});
 // Retransmission of the restored ciphertext echoes the same id: no duplicate.
 mocks.options.at(-1).message(queued);
 expect(session.getSnapshot().messages.map(m=>m.id)).toEqual([queued.id,lost.id,delivered.id]);
});

it('shows an offline message at once and sends it when the connection returns',async()=>{
 const {session,events,state}=await open();vi.stubGlobal('navigator',{onLine:false});
 mocks.send.mockRejectedValueOnce(Error('Failed to fetch'));
 const first=await session.send('Offline note',null);expect(state(first.id)).toBe('waiting');
 vi.stubGlobal('navigator',{onLine:true});
 mocks.send.mockImplementationOnce(async(_t:string,_r:unknown,draft:{id:string})=>({id:draft.id,queued:false,partial:false}));
 events.status('Connected · end-to-end encrypted');await flush();await flush();
 const [resent]=session.getSnapshot().messages;
 expect(resent.text).toBe('Offline note');expect(resent.id).not.toBe(first.id);expect(state(resent.id)).toBe('sent');
});

it('refuses empty or oversized text without adding it to the conversation',async()=>{
 const {session}=await open();
 await expect(session.send('   ',null)).rejects.toThrow('Write a message');
 await expect(session.send('x'.repeat(16001),null)).rejects.toThrow('under 16 KB');
 expect(session.getSnapshot().messages).toEqual([]);expect(mocks.send).not.toHaveBeenCalled();
});

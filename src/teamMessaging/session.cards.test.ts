// A card message is an ordinary visible message: the optimistic copy, the
// transport send and a retry all carry its extension fields unchanged.
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({options:[] as any[],send:vi.fn(),discard:vi.fn(async()=>{}),start:vi.fn(async()=>{})}));// eslint-disable-line @typescript-eslint/no-explicit-any
vi.mock('./client',()=>({PeerClient:class{constructor(options:unknown){mocks.options.push(options);}start=mocks.start;stop=vi.fn();send=mocks.send;discard=mocks.discard;}}));
vi.mock('./history',()=>({loadChatHistory:vi.fn(async()=>[]),saveChatMessage:vi.fn(async()=>{}),forgetChatMessage:vi.fn(async()=>{}),loadChatReadState:vi.fn(async()=>({unreadIds:[],receipts:{}})),saveChatReadState:vi.fn(async()=>{}),loadChatEvents:vi.fn(async()=>[]),saveChatEvent:vi.fn(async()=>{})}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({user:{id:'me'}}))}));
import {teamSession,clearTeamSessions} from './session';
import {cardDraft} from './cardSchema';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
afterEach(()=>{clearTeamSessions();mocks.send.mockReset();});

it('sends a card with its extensions and keeps them on retry',async()=>{
 const session=teamSession('team-cards','me');session.retain();await flush();
 mocks.options.at(-1).status('Connected · end-to-end encrypted');
 const draft=cardDraft({type:'pr',v:1,repo:{host:'github.com',slug:'acme/api'},number:3,title:'Fix'},'',{mentions:['bob']});
 mocks.send.mockRejectedValueOnce(Error('No recipient devices are registered yet.'));
 // A DM to bob: the session keeps only mentions of people in the conversation.
 const {id}=await session.send(draft.text,'bob',[],draft.ext);
 const [message]=session.getSnapshot().messages;
 expect(message).toMatchObject({id,text:draft.text,card:draft.ext.card,mentions:['bob']});
 expect(mocks.send).toHaveBeenCalledWith(draft.text,'bob',{id,created:message.created},[],{card:draft.ext.card,mentions:['bob']});
 mocks.send.mockImplementationOnce(async(_t:string,_r:string,d:{id:string})=>({id:d.id,queued:false,partial:false}));
 const retried=await session.retry(id);
 expect(session.getSnapshot().messages).toEqual([expect.objectContaining({id:retried.id,card:draft.ext.card,mentions:['bob']})]);
 expect(mocks.send).toHaveBeenLastCalledWith(draft.text,'bob',expect.anything(),[],{card:draft.ext.card,mentions:['bob']});
});

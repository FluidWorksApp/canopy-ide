import {it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({start:vi.fn(async()=>{}),stop:vi.fn(),send:vi.fn(async()=>({id:'sent'})),options:[] as any[]}));
vi.mock('./client',()=>({PeerClient:class{constructor(options:unknown){mocks.options.push(options);}start=mocks.start;stop=mocks.stop;send=mocks.send;}}));
vi.mock('./history',()=>({loadChatHistory:vi.fn(async()=>[]),saveChatMessage:vi.fn(async()=>{}),loadChatReadState:vi.fn(async()=>({unreadIds:[],receipts:{}})),saveChatReadState:vi.fn(async()=>{})}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({user:{id:'bob'}}))}));
import {teamSession,clearTeamSessions} from './session';
it('shares transport across tabs and clears transcript on account sign-out',async()=>{
 const a=teamSession('team','alice'),b=teamSession('team','alice');expect(a).toBe(b);const release=a.retain(),releaseOther=b.retain();
 mocks.options.at(-1).members([{id:'ada',name:'Ada'}]);expect(a.getSnapshot().members).toEqual({ada:'Ada'});
 mocks.options.at(-1).message({id:'private',text:'Private message'});expect(a.getSnapshot().messages).toHaveLength(1);
 clearTeamSessions();expect(a.getSnapshot().members).toEqual({});expect(a.getSnapshot().messages).toHaveLength(0);await expect(a.send('hello',null)).rejects.toThrow('Sign in');
 mocks.options.at(-1).members([{id:'ada',name:'Stale'}]);expect(a.getSnapshot().members).toEqual({});
 mocks.options.at(-1).message({id:'late',text:'Late packet'});expect(a.getSnapshot().messages).toHaveLength(0);
 release();releaseOther();await Promise.resolve();
});
it('React effect replay does not stop the transport before remount',async()=>{
 const start=mocks.start.mock.calls.length,stop=mocks.stop.mock.calls.length;const session=teamSession('strict','bob');const release=session.retain();release();const releaseAgain=session.retain();await new Promise(resolve=>setTimeout(resolve,0));expect(mocks.start.mock.calls.length).toBe(start+1);expect(mocks.stop.mock.calls.length).toBe(stop);releaseAgain();await Promise.resolve();expect(mocks.stop.mock.calls.length).toBe(stop+1);
});
it('does not restore an old account conversation after signing into another account',async()=>{
 const {loadChatHistory}=await import('./history');const before=vi.mocked(loadChatHistory).mock.calls.length;
 const session=teamSession('private-team','previous-account');const release=session.retain();await new Promise(resolve=>setTimeout(resolve,0));
 expect(vi.mocked(loadChatHistory).mock.calls.length).toBe(before);expect(session.getSnapshot().messages).toEqual([]);expect(session.getSnapshot().status).toContain('account that owns');release();
});

it('counts background messages and only marks the visible conversation read',async()=>{
 const session=teamSession('unread','bob');const release=session.retain();
 await new Promise(resolve=>setTimeout(resolve,0));
 const events=mocks.options.at(-1);
 events.message({id:'channel',sender:'ada',recipient:null,text:'team',created:1});
 events.message({id:'dm',sender:'ada',recipient:'bob',text:'direct',created:2});
 expect(session.getSnapshot().unreadIds).toEqual(['channel','dm']);
 session.markRead(null);expect(session.getSnapshot().unreadIds).toEqual(['dm']);
 events.message({id:'dm',sender:'ada',recipient:'bob',text:'direct',created:2});
 expect(session.getSnapshot().unreadIds).toEqual(['dm']);
 session.markRead('ada');expect(session.getSnapshot().unreadIds).toEqual([]);
 release();await Promise.resolve();
});

it('restores unread messages and persists reading them for the owning account',async()=>{
 const history=await import('./history');
 vi.mocked(history.loadChatHistory).mockResolvedValueOnce([{id:'saved',sender:'ada',recipient:null,text:'hello',created:1}]);
 vi.mocked(history.loadChatReadState).mockResolvedValueOnce({unreadIds:['saved','expired'],receipts:{}});
 const session=teamSession('restore-read-state','bob');const release=session.retain();
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(session.getSnapshot().unreadIds).toEqual(['saved']);
 session.markRead(null);
 expect(history.saveChatReadState).toHaveBeenLastCalledWith('bob','restore-read-state',{unreadIds:[],receipts:{}});
 release();await Promise.resolve();
});

it('restores authenticated history even if the separately encrypted read status is corrupt',async()=>{
 const history=await import('./history');
 vi.mocked(history.loadChatHistory).mockResolvedValueOnce([{id:'retained',sender:'ada',recipient:null,text:'retained message',created:1}]);
 vi.mocked(history.loadChatReadState).mockRejectedValueOnce(Error('authentication failed'));
 const session=teamSession('corrupt-read-state','bob');const release=session.retain();
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(session.getSnapshot().messages.map(m=>m.id)).toEqual(['retained']);
 expect(session.getSnapshot().unreadIds).toEqual(['retained']);
 release();await Promise.resolve();
});

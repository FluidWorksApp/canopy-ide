import {render,screen,fireEvent,waitFor,cleanup,within} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const R='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',B='33333333-3333-4333-8333-333333333333',MINE='44444444-4444-4444-8444-444444444444',GONE='55555555-5555-4555-8555-555555555555';
const mock=vi.hoisted(()=>({
 send:vi.fn(async(..._a:unknown[])=>({id:'new'})),edit:vi.fn(async(..._a:unknown[])=>{}),remove:vi.fn(async(..._a:unknown[])=>{}),retryNow:vi.fn(async(..._a:unknown[])=>true),markThreadRead:vi.fn(),markRead:vi.fn(),
 snapshot:{} as Record<string,unknown>,readers:[] as string[],
}));
vi.mock('../teamMessaging/session',()=>({readReceiptsOn:()=>true,teamSession:()=>({retain:()=>()=>{},markRead:mock.markRead,markThreadRead:mock.markThreadRead,subscribe:()=>()=>{},getSnapshot:()=>mock.snapshot,send:mock.send,edit:mock.edit,remove:mock.remove,retryNow:mock.retryNow,readers:()=>mock.readers,olderRecipients:()=>['sam'],attachment:vi.fn(),retry:vi.fn(),discard:vi.fn(),react:vi.fn()})}));
import {AccountChatView} from './AccountChatView';
const base=()=>({members:{ada:'Ada Lovelace',sam:'Sam',me:'Me'},receipts:{},status:'Connected · end-to-end encrypted',restoredIds:[],delivery:{},attachments:{},reactions:{},undeliveredReactions:{},edits:{},deleted:{},retryAt:{},reads:{},awaiting:{},unreadIds:[],
 messages:[
  {id:R,sender:'ada',recipient:null,text:'Root question',created:1},
  {id:A,sender:'sam',recipient:null,text:'First reply',created:2,thread:{root:R}},
  {id:B,sender:'ada',recipient:null,text:'Second reply',created:3,thread:{root:A}},
  {id:GONE,sender:'ada',recipient:null,text:'',created:4},
  {id:MINE,sender:'me',recipient:null,text:'My note',created:5},
 ]});
beforeEach(()=>{mock.snapshot=base();mock.readers=[];for(const fn of [mock.send,mock.edit,mock.remove,mock.retryNow,mock.markThreadRead])fn.mockClear();});
afterEach(cleanup);
const channel={teamId:'core',userId:'me',peer:null,name:'Core'};
const box=()=>screen.getByRole('textbox',{name:'Message'}) as HTMLTextAreaElement;
const article=(text:string)=>screen.getByText(text).closest('article')!;

it('keeps replies in the thread pane and sends a reply into the root thread',async()=>{
 mock.snapshot={...base(),deleted:{[GONE]:{created:9,id:'x'}},edits:{[R]:{text:'Root question, edited',created:8,id:'e'}},unreadIds:[B]};
 render(<AccountChatView conversation={channel}/>);
 expect(screen.queryByText('First reply')).toBeNull();
 expect(screen.getByText('This message was deleted')).toBeTruthy();
 expect(screen.getByText('(edited)')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/2 replies.*1 new reply/}));
 const pane=screen.getByRole('complementary',{name:'Thread'});
 expect(within(pane).getByText('First reply')).toBeTruthy();expect(within(pane).getByText('Second reply')).toBeTruthy();
 await waitFor(()=>expect(mock.markThreadRead).toHaveBeenCalledWith(R));
 const reply=within(pane).getByRole('textbox',{name:'Reply'});
 fireEvent.change(reply,{target:{value:'On it @Ada Lovelace'}});fireEvent.keyDown(reply,{key:'Enter'});
 await waitFor(()=>expect(mock.send).toHaveBeenCalledWith('On it @Ada Lovelace',null,[],{thread:R,mentions:['ada']}));
});

it('edits your last message with Up in an empty box, and deletes after naming who keeps it',async()=>{
 render(<AccountChatView conversation={channel}/>);
 fireEvent.keyDown(box(),{key:'ArrowUp'});
 const editor=screen.getByRole('textbox',{name:'Edit message'}) as HTMLTextAreaElement;
 expect(editor.value).toBe('My note');
 fireEvent.change(editor,{target:{value:'My better note'}});fireEvent.keyDown(editor,{key:'Enter'});
 await waitFor(()=>expect(mock.edit).toHaveBeenCalledWith(MINE,'My better note'));
 // Someone else's message has no edit or delete.
 expect(within(article('Root question')).queryByRole('button',{name:'Edit message'})).toBeNull();
 fireEvent.click(within(article('My note')).getByRole('button',{name:'Delete message'}));
 const dialog=screen.getByRole('alertdialog',{name:'Delete message'});
 expect(dialog.textContent).toContain('Sam uses an older Canopy and will keep it.');
 fireEvent.click(within(dialog).getByRole('button',{name:'Delete'}));
 await waitFor(()=>expect(mock.remove).toHaveBeenCalledWith(MINE));
});

it('suggests teammates after @ and sends who was mentioned',async()=>{
 render(<AccountChatView conversation={channel}/>);
 fireEvent.change(box(),{target:{value:'Thanks @Ad',selectionStart:10,selectionEnd:10}});
 box().setSelectionRange(10,10);fireEvent.select(box());
 const option=await screen.findByRole('option',{name:'@Ada Lovelace'});expect(option).toBeTruthy();
 fireEvent.keyDown(box(),{key:'Enter'});
 await waitFor(()=>expect(box().value).toBe('Thanks @Ada Lovelace '));
 fireEvent.keyDown(box(),{key:'Enter'});
 await waitFor(()=>expect(mock.send).toHaveBeenCalledWith('Thanks @Ada Lovelace ',null,[],{mentions:['ada']}));
});

it('shows who has seen your latest message, and the retry countdown with Retry now',async()=>{
 mock.readers=['ada','sam'];mock.snapshot={...base(),receipts:{[MINE]:['ada']},reads:{x:'y'}};
 const {unmount}=render(<AccountChatView conversation={channel}/>);
 const seen=within(article('My note')).getByText('Seen by 2');expect(seen.getAttribute('title')).toBe('Seen by Ada Lovelace and Sam');
 unmount();
 mock.snapshot={...base(),delivery:{[MINE]:{state:'queued'}},retryAt:{[MINE]:Date.now()+20_000}};
 render(<AccountChatView conversation={channel}/>);
 expect(within(article('My note')).getByText(/Saved on this device · retrying in (19|20)s/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Retry now'}));
 await waitFor(()=>expect(mock.retryNow).toHaveBeenCalledWith(MINE));
 cleanup();
 mock.snapshot={...base(),delivery:{[MINE]:{state:'expired'}},awaiting:{[MINE]:{users:['ada'],until:Date.UTC(2026,9,30,12)}}};
 render(<AccountChatView conversation={channel}/>);
 expect(within(article('My note')).getByText(/Will deliver when Ada Lovelace is online \(until/)).toBeTruthy();
});

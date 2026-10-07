import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({send:vi.fn(async(..._args:unknown[])=>({id:'new'})),retry:vi.fn(async(..._args:unknown[])=>({id:'retried'})),discard:vi.fn(),snapshot:{members:{ada:'Ada Lovelace'},messages:[{id:'m',sender:'ada',recipient:null,text:'Hello team',created:1}],receipts:{},status:'Connected · end-to-end encrypted'} as {members:Record<string,string>;messages:{id:string;sender:string;recipient:string|null;text:string;created:number}[];receipts:Record<string,string[]>;delivery?:Record<string,{state:string;detail?:string}>;status:string}}));
vi.mock('../teamMessaging/session',()=>({teamSession:()=>({retain:()=>()=>{},markRead:vi.fn(),subscribe:()=>()=>{},getSnapshot:()=>mock.snapshot,send:mock.send,retry:mock.retry,discard:mock.discard})}));
import {AccountChatView} from './AccountChatView';
beforeEach(()=>{mock.send.mockClear();mock.retry.mockClear();mock.discard.mockClear();});
afterEach(cleanup);
const channel={teamId:'engineering',userId:'me',peer:null,name:'Engineering'};
const box=()=>screen.getByRole('textbox',{name:'Message'});
it('identifies channel senders using the authenticated directory and sends in the selected team conversation',async()=>{
 render(<AccountChatView conversation={channel}/>);
 expect(screen.getByText('Ada Lovelace')).toBeTruthy();expect(screen.getByText('Hello team')).toBeTruthy();
 fireEvent.change(box(),{target:{value:'Hi Ada'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(mock.send).toHaveBeenCalledWith('Hi Ada',null));
});
it('sends on Enter and clears the composer',async()=>{
 render(<AccountChatView conversation={channel}/>);
 fireEvent.change(box(),{target:{value:'Ship it'}});
 const notPrevented=fireEvent.keyDown(box(),{key:'Enter'});
 expect(notPrevented).toBe(false);
 await waitFor(()=>expect(mock.send).toHaveBeenCalledWith('Ship it',null));
 await waitFor(()=>expect((box() as HTMLTextAreaElement).value).toBe(''));
});
it('keeps Shift+Enter for a new line instead of sending',()=>{
 render(<AccountChatView conversation={channel}/>);
 fireEvent.change(box(),{target:{value:'line one'}});
 const notPrevented=fireEvent.keyDown(box(),{key:'Enter',shiftKey:true});
 expect(notPrevented).toBe(true);
 expect(mock.send).not.toHaveBeenCalled();
});
it('does not send when Enter confirms an IME composition',()=>{
 render(<AccountChatView conversation={channel}/>);
 fireEvent.change(box(),{target:{value:'にほん'}});
 fireEvent.keyDown(box(),{key:'Enter',isComposing:true});
 fireEvent.keyDown(box(),{key:'Enter',keyCode:229});
 expect(mock.send).not.toHaveBeenCalled();
});
it('does not send an empty or whitespace-only draft, and disables the send button',()=>{
 render(<AccountChatView conversation={channel}/>);
 expect((screen.getByRole('button',{name:'Send'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(box(),{target:{value:'   '}});
 fireEvent.keyDown(box(),{key:'Enter'});
 expect(mock.send).not.toHaveBeenCalled();
 expect((screen.getByRole('button',{name:'Send'}) as HTMLButtonElement).disabled).toBe(true);
});
it('names the other person in a direct message header with a compact encrypted indicator',()=>{
 render(<AccountChatView conversation={{teamId:'engineering',userId:'me',peer:'ada',name:'Ada Lovelace',email:'ada@example.com'}}/>);
 expect(screen.getByRole('heading',{name:'Ada Lovelace'})).toBeTruthy();
 expect(screen.getByText('ada@example.com')).toBeTruthy();
 expect(screen.getByRole('status').textContent).toBe('Encrypted');
 expect(document.getElementById(box().getAttribute('aria-describedby')!)?.textContent).toBe('Enter to send · Shift+Enter for a new line');
 expect(screen.queryByText(/Pending deliveries survive/)).toBeNull();
 expect(screen.getByRole('img',{name:/Pending deliveries survive/})).toBeTruthy();
});
it('groups consecutive messages from one sender under a single header',()=>{
 const prev=mock.snapshot;
 mock.snapshot={...prev,messages:[{id:'a',sender:'ada',recipient:null,text:'one',created:1000},{id:'b',sender:'ada',recipient:null,text:'two',created:2000},{id:'c',sender:'me',recipient:null,text:'three',created:3000}],receipts:{c:['dev']}};
 try{
  render(<AccountChatView conversation={channel}/>);
  expect(screen.getAllByText('Ada Lovelace')).toHaveLength(1);
  expect(screen.getByText('Delivered')).toBeTruthy();
 }finally{mock.snapshot=prev;}
});
function withSnapshot(change:Partial<typeof mock.snapshot>,body:()=>void){const prev=mock.snapshot;mock.snapshot={...prev,...change};try{body();}finally{mock.snapshot=prev;}}
it('clears the composer at once, before the send settles, and keeps the composer usable',()=>{
 mock.send.mockReturnValueOnce(new Promise(()=>{}));
 render(<AccountChatView conversation={channel}/>);
 fireEvent.change(box(),{target:{value:'Instant'}});fireEvent.keyDown(box(),{key:'Enter'});
 expect(mock.send).toHaveBeenCalledWith('Instant',null);
 expect((box() as HTMLTextAreaElement).value).toBe('');
 expect(document.activeElement).toBe(box());
 fireEvent.change(box(),{target:{value:'Next'}});
 expect((screen.getByRole('button',{name:'Send'}) as HTMLButtonElement).disabled).toBe(false);
});
it('puts the text back when the message is refused outright',async()=>{
 mock.send.mockRejectedValueOnce(Error('Write a message under 16 KB'));
 render(<AccountChatView conversation={channel}/>);
 fireEvent.change(box(),{target:{value:'Too long'}});fireEvent.keyDown(box(),{key:'Enter'});
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('Write a message under 16 KB'));
 expect((box() as HTMLTextAreaElement).value).toBe('Too long');
});
it('shows each delivery state on your own messages',()=>{
 const own=(id:string,created:number)=>({id,sender:'me',recipient:null,text:`text ${id}`,created});
 withSnapshot({messages:['sending','sent','queued','waiting','expired'].map((id,i)=>own(id,1000+i)),receipts:{},delivery:{sending:{state:'sending'},sent:{state:'sent'},queued:{state:'queued'},waiting:{state:'waiting'},expired:{state:'expired'}}},()=>{
  render(<AccountChatView conversation={channel}/>);
  for(const label of ['Sending…','Awaiting delivery','Saved on this device','Waiting for connection','Not delivered · expired'])expect(screen.getByText(label,{exact:false})).toBeTruthy();
  expect(screen.getByText('text sending').closest('article')?.className).toContain('pending');
  expect(screen.getByText('text expired').closest('article')?.className).toContain('failed');
 });
});
it('offers Retry and Discard on a message that was not sent',()=>{
 withSnapshot({messages:[{id:'f',sender:'me',recipient:null,text:'Keep this text',created:5}],receipts:{},delivery:{f:{state:'failed',detail:'Team not found'}}},()=>{
  render(<AccountChatView conversation={channel}/>);
  expect(screen.getByText('Keep this text')).toBeTruthy();
  const status=screen.getByText('Not sent',{exact:false});expect(status.getAttribute('title')).toBe('Team not found');
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));expect(mock.retry).toHaveBeenCalledWith('f');
  fireEvent.click(screen.getByRole('button',{name:'Discard'}));expect(mock.discard).toHaveBeenCalledWith('f');
 });
});

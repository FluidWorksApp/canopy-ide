import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({attachment:vi.fn(async(..._args:unknown[])=>new Blob(['x'])),markRead:vi.fn(),send:vi.fn(async(..._args:unknown[])=>({id:'new'})),retry:vi.fn(async(..._args:unknown[])=>({id:'retried'})),discard:vi.fn(),snapshot:{members:{ada:'Ada Lovelace'},messages:[{id:'m',sender:'ada',recipient:null,text:'Hello team',created:1}],receipts:{},status:'Connected · end-to-end encrypted'} as {members:Record<string,string>;messages:{id:string;sender:string;recipient:string|null;text:string;created:number;attachments?:{id:string;name:string;size:number;type:string;sha256:string}[]}[];receipts:Record<string,string[]>;delivery?:Record<string,{state:string;detail?:string}>;attachments?:Record<string,Record<string,unknown>>;status:string}}));
vi.mock('../teamMessaging/session',()=>({teamSession:()=>({retain:()=>()=>{},markRead:mock.markRead,subscribe:()=>()=>{},getSnapshot:()=>mock.snapshot,send:mock.send,attachment:mock.attachment,retry:mock.retry,discard:mock.discard})}));
import {AccountChatView} from './AccountChatView';
beforeEach(()=>{mock.attachment.mockClear();mock.markRead.mockClear();mock.send.mockClear();mock.retry.mockClear();mock.discard.mockClear();});
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

it('marks the conversation read only while it is in front of a focused window',()=>{
 const focus=vi.spyOn(document,'hasFocus').mockReturnValue(false);
 const {rerender}=render(<AccountChatView conversation={channel} active/>);
 expect(mock.markRead).not.toHaveBeenCalled();
 focus.mockReturnValue(true);fireEvent.focus(window);
 expect(mock.markRead).toHaveBeenCalledWith(null);
 mock.markRead.mockClear();
 rerender(<AccountChatView conversation={channel} active={false}/>);fireEvent.focus(window);
 expect(mock.markRead).not.toHaveBeenCalled();
 focus.mockRestore();
});
it('leaves messages unread while scrolled away from the newest ones',()=>{
 const focus=vi.spyOn(document,'hasFocus').mockReturnValue(false);
 render(<AccountChatView conversation={channel} active/>);
 const log=screen.getByRole('log');
 Object.defineProperties(log,{scrollHeight:{configurable:true,value:2000},clientHeight:{configurable:true,value:400}});
 log.scrollTop=200;focus.mockReturnValue(true);fireEvent.focus(window);
 expect(mock.markRead).not.toHaveBeenCalled();
 log.scrollTop=1600;fireEvent.scroll(log);
 expect(mock.markRead).toHaveBeenCalledWith(null);
 focus.mockRestore();
});
it('reports the conversation as on screen only while active',async()=>{
 const {conversationShown}=await import('../teamMessaging/unread');
 const {rerender,unmount}=render(<AccountChatView conversation={channel} active/>);
 expect(conversationShown('engineering','me',null)).toBe(true);
 rerender(<AccountChatView conversation={channel} active={false}/>);
 expect(conversationShown('engineering','me',null)).toBe(false);
 rerender(<AccountChatView conversation={channel} active/>);unmount();
 expect(conversationShown('engineering','me',null)).toBe(false);
});

const picked=(name:string,bytes:number,type='text/plain')=>new File([new Uint8Array(bytes)],name,{type});
it('attaches picked and pasted files as removable chips and sends them without text',async()=>{
 render(<AccountChatView conversation={channel}/>);
 const picker=document.querySelector('input[type=file]') as HTMLInputElement,click=vi.spyOn(picker,'click');
 fireEvent.click(screen.getByRole('button',{name:'Attach files'}));expect(click).toHaveBeenCalled();
 const notes=picked('notes.txt',2048),logs=picked('logs.txt',10);
 fireEvent.change(picker,{target:{files:[notes,logs]}});
 const chips=screen.getByRole('list',{name:'Attachments'});
 expect(chips.textContent).toContain('notes.txt · 2.0 KB');expect(chips.textContent).toContain('logs.txt · 10 B');
 fireEvent.click(screen.getByRole('button',{name:'Remove logs.txt'}));
 expect(screen.queryByText('logs.txt')).toBeNull();
 const shot=picked('image.png',5,'image/png');
 fireEvent.paste(box(),{clipboardData:{files:[shot]}});
 expect(chips.textContent).toContain('image.png');
 expect((screen.getByRole('button',{name:'Send'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(mock.send).toHaveBeenCalledWith('',null,[notes,shot]));
 expect(screen.queryByRole('list',{name:'Attachments'})).toBeNull();
});
it('refuses a file over 100 MB before it reaches the composer',()=>{
 render(<AccountChatView conversation={channel}/>);
 const huge=picked('huge.iso',1);Object.defineProperty(huge,'size',{value:100*1024*1024+1});
 fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[huge]}});
 expect(screen.getByRole('alert').textContent).toBe('huge.iso is larger than 100 MB');
 expect(screen.queryByRole('list',{name:'Attachments'})).toBeNull();
});
it('shows each attachment state and pulls on Download',()=>{
 const file=(id:string,name:string,type='application/pdf')=>({id,name,size:4096,type,sha256:'a'.repeat(64)});
 withSnapshot({messages:[
  {id:'r',sender:'ada',recipient:null,text:'',created:1,attachments:[file('idle','idle.pdf'),file('busy','busy.pdf'),file('away','away.pdf'),file('gone','gone.pdf'),file('bad','bad.pdf')]},
  {id:'o',sender:'me',recipient:null,text:'mine',created:2,attachments:[file('mine','mine.pdf')]}],
  attachments:{busy:{state:'downloading',received:1730,total:4096},away:{state:'unavailable',reason:'offline'},gone:{state:'unavailable',reason:'expired'},bad:{state:'failed',detail:'The file failed its integrity check'}}},()=>{
  render(<AccountChatView conversation={channel}/>);
  const chip=(name:string)=>screen.getByTitle(name).closest('.account-chat-file') as HTMLElement;
  expect(chip('busy.pdf').textContent).toContain('Downloading 42%');
  expect(chip('away.pdf').textContent).toContain('Waiting for Ada Lovelace to come online');
  expect(chip('gone.pdf').textContent).toContain('No longer available');
  expect(chip('bad.pdf').textContent).toContain('Failed');
  expect(chip('idle.pdf').textContent).toContain('4.0 KB');
  expect(chip('mine.pdf').textContent).toContain('Save');
  expect(mock.attachment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Download'}));
  expect(mock.attachment).toHaveBeenCalledWith('r','idle');
 });
});
it('pulls a small image on sight and previews it',async()=>{
 const create=vi.fn(()=>'blob:preview'),revoke=vi.fn();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:create,revokeObjectURL:revoke}));
 const prev=mock.snapshot;mock.snapshot={...prev,messages:[{id:'r',sender:'ada',recipient:null,text:'',created:1,attachments:[{id:'img',name:'shot.png',size:2048,type:'image/png',sha256:'a'.repeat(64)}]}]};
 try{
  const {unmount}=render(<AccountChatView conversation={channel}/>);
  expect(mock.attachment).toHaveBeenCalledWith('r','img');
  await waitFor(()=>expect((screen.getByRole('img',{name:'shot.png'}) as HTMLImageElement).src).toBe('blob:preview'));
  unmount();expect(revoke).toHaveBeenCalledWith('blob:preview');
 }finally{mock.snapshot=prev;vi.unstubAllGlobals();}
});

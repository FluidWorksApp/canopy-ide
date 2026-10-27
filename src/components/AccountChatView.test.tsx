import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({attachment:vi.fn(async(..._args:unknown[])=>new Blob(['x'])),markRead:vi.fn(),send:vi.fn(async(..._args:unknown[])=>({id:'new'})),retry:vi.fn(async(..._args:unknown[])=>({id:'retried'})),discard:vi.fn(),react:vi.fn(async(..._args:unknown[])=>{}),snapshot:{members:{ada:'Ada Lovelace'},messages:[{id:'m',sender:'ada',recipient:null,text:'Hello team',created:1}],receipts:{},status:'Connected · end-to-end encrypted'} as {members:Record<string,string>;messages:{id:string;sender:string;recipient:string|null;text:string;created:number;attachments?:{id:string;name:string;size:number;type:string;sha256:string}[]}[];receipts:Record<string,string[]>;delivery?:Record<string,{state:string;detail?:string}>;attachments?:Record<string,Record<string,unknown>>;reactions?:Record<string,Record<string,{sender:string;emoji:string;on:boolean;created:number;id:string}>>;undeliveredReactions?:Record<string,string[]>;status:string}}));
vi.mock('../teamMessaging/session',()=>({teamSession:()=>({retain:()=>()=>{},markRead:mock.markRead,subscribe:()=>()=>{},getSnapshot:()=>mock.snapshot,send:mock.send,attachment:mock.attachment,retry:mock.retry,discard:mock.discard,react:mock.react})}));
import {AccountChatView} from './AccountChatView';
import {setChatHandoff} from '../teamMessaging/chatHandoff';
beforeEach(()=>{mock.attachment.mockClear();mock.markRead.mockClear();mock.send.mockClear();mock.retry.mockClear();mock.discard.mockClear();mock.react.mockClear();});
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
it('renders links in team messages as clickable links',()=>{
 const previous=mock.snapshot.messages;mock.snapshot.messages=[{id:'u',sender:'ada',recipient:null,text:'see https://claude.com/resources/webinars/x.',created:2}];
 try{render(<AccountChatView conversation={channel}/>);
  const link=screen.getByRole('link',{name:'https://claude.com/resources/webinars/x'});expect(link.getAttribute('href')).toBe('https://claude.com/resources/webinars/x');
 }finally{mock.snapshot.messages=previous;}
});
it('copies a message\'s full text from its Copy button and shows that it copied',async()=>{
 const writeText=vi.fn(async(_text:string)=>{});
 Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
 render(<AccountChatView conversation={channel}/>);
 fireEvent.click(screen.getByRole('button',{name:'Copy message'}));
 expect(writeText).toHaveBeenCalledWith('Hello team');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Copied'}).textContent).toBe('Copied'));
});
it('keeps the composer focused when a message is copied by mouse',()=>{
 render(<AccountChatView conversation={channel}/>);
 expect(fireEvent.mouseDown(screen.getByRole('button',{name:'Copy message'}))).toBe(false);
});
it('offers Copy message on right-click of a message',async()=>{
 const writeText=vi.fn(async(_text:string)=>{});
 Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
 render(<AccountChatView conversation={channel}/>);
 fireEvent.contextMenu(screen.getByText('Hello team'));
 const row=[...document.querySelectorAll<HTMLButtonElement>('.ctx-item')].find(b=>b.textContent==='Copy message');
 expect(row).toBeTruthy();fireEvent.click(row!);
 expect(writeText).toHaveBeenCalledWith('Hello team');
});
it('makes the transcript a selectable surface that Select All can target',()=>{
 render(<AccountChatView conversation={channel}/>);
 const log=screen.getByRole('log',{name:'Messages'});
 expect(log.classList.contains('account-chat-transcript')).toBe(true);
 expect(log.tabIndex).toBe(-1);
 expect(screen.getByText('Hello team').closest('.account-chat-transcript')).toBe(log);
});

const entry=(sender:string,emoji:string,created:number,on=true)=>({sender,emoji,on,created,id:`e-${sender}-${created}`});
function withReactions(run:()=>void|Promise<void>){
 const prior=mock.snapshot.reactions;
 mock.snapshot.reactions={m:{a:entry('ada','👍',1),b:entry('me','👍',2),c:entry('ada','🎉',3),d:entry('grace','👀',4,false)}};
 return Promise.resolve(run()).finally(()=>{mock.snapshot.reactions=prior;});
}
it('groups reactions under a message as labelled buttons, with yours pressed',()=>withReactions(()=>{
 render(<AccountChatView conversation={channel}/>);
 const group=screen.getByRole('group',{name:'Reactions'});
 const thumbs=screen.getByRole('button',{name:/^👍 2 reactions from You and Ada Lovelace; remove your reaction$/});
 expect(group.contains(thumbs)).toBe(true);
 expect(thumbs.getAttribute('aria-pressed')).toBe('true');expect(thumbs.classList.contains('is-mine')).toBe(true);
 expect(thumbs.textContent).toBe('👍2');expect(thumbs.title).toBe('You and Ada Lovelace reacted with 👍');
 const party=screen.getByRole('button',{name:/^🎉 1 reaction from Ada Lovelace; add your reaction$/});
 expect(party.getAttribute('aria-pressed')).toBe('false');
 // A removed reaction leaves no chip.
 expect(screen.queryByRole('button',{name:/^👀/})).toBeNull();
 fireEvent.click(thumbs);expect(mock.react).toHaveBeenCalledWith('m','👍');
 fireEvent.click(party);expect(mock.react).toHaveBeenCalledWith('m','🎉');
 // Clicking a chip keeps focus where it was, like Copy.
 expect(fireEvent.mouseDown(thumbs)).toBe(false);
}));
it('adds a reaction from the quick set or any typed emoji, and closes on Escape',async()=>{
 render(<AccountChatView conversation={channel}/>);
 const add=screen.getByRole('button',{name:'Add reaction'});
 expect(add.getAttribute('aria-expanded')).toBe('false');
 fireEvent.click(add);
 const picker=screen.getByRole('dialog',{name:'Add reaction'});
 expect(add.getAttribute('aria-expanded')).toBe('true');
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'React with 👍'}));
 for(const emoji of ['👍','❤️','😂','🎉','👀','✅'])expect(screen.getByRole('button',{name:`React with ${emoji}`})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'React with 🎉'}));
 expect(mock.react).toHaveBeenCalledWith('m','🎉');
 expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(add);
 fireEvent.click(add);
 const field=screen.getByRole('textbox',{name:'Any emoji'}),submit=screen.getByRole('button',{name:'Add'});
 fireEvent.change(field,{target:{value:'hello'}});
 expect((submit as HTMLButtonElement).disabled).toBe(true);expect(field.getAttribute('aria-invalid')).toBe('true');
 fireEvent.change(field,{target:{value:' 🦄 '}});fireEvent.click(submit);
 expect(mock.react).toHaveBeenLastCalledWith('m','🦄');
 fireEvent.click(add);
 const escaped=fireEvent.keyDown(screen.getByRole('dialog',{name:'Add reaction'}),{key:'Escape'});
 expect(escaped).toBe(false);
 expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(add);
 expect(picker.isConnected).toBe(false);
});
it('shows a reaction that could not be sent',async()=>{
 mock.react.mockRejectedValueOnce(Error('Could not be sent. Try again.'));
 render(<AccountChatView conversation={channel}/>);
 fireEvent.click(screen.getByRole('button',{name:'Add reaction'}));
 fireEvent.click(screen.getByRole('button',{name:'React with 👍'}));
 expect((await screen.findByRole('alert')).textContent).toBe('Could not be sent. Try again.');
});

it('puts the cursor in the message box when the conversation opens',()=>{
 render(<AccountChatView conversation={channel}/>);
 expect(document.activeElement).toBe(box());
});
it('focuses the message box again on switching back to the conversation or to another one',()=>{
 const outside=document.createElement('button');document.body.append(outside);
 const {rerender}=render(<AccountChatView conversation={channel} active/>);
 outside.focus();
 rerender(<AccountChatView conversation={channel} active={false}/>);
 expect(document.activeElement).toBe(outside);
 rerender(<AccountChatView conversation={channel} active/>);
 expect(document.activeElement).toBe(box());
 outside.focus();
 rerender(<AccountChatView conversation={{...channel,peer:'ada',name:'Ada Lovelace'}} active/>);
 expect(document.activeElement).toBe(box());
 outside.remove();
});
it('does not take focus on later updates, or from a field the user is typing in elsewhere',()=>{
 const other=document.createElement('input');document.body.append(other);
 // jsdom lays nothing out: give this field a box so it counts as on screen.
 other.getClientRects=()=>[{}] as unknown as DOMRectList;
 const {rerender}=render(<AccountChatView conversation={channel} active={false}/>);
 other.focus();
 rerender(<AccountChatView conversation={channel} active={false}/>);
 expect(document.activeElement).toBe(other);
 rerender(<AccountChatView conversation={channel} active/>);
 expect(document.activeElement).toBe(other);
 other.blur();other.remove();
});

it('flags your own reaction that no teammate could receive',()=>withReactions(()=>{
 const prior=mock.snapshot.undeliveredReactions;
 mock.snapshot.undeliveredReactions={m:['👍','🎉']};
 try{
  render(<AccountChatView conversation={channel}/>);
  const thumbs=screen.getByRole('button',{name:/^👍 2 reactions/});
  expect(thumbs.classList.contains('is-undelivered')).toBe(true);
  expect(thumbs.title).toBe('You and Ada Lovelace reacted with 👍. Not delivered: teammates need Canopy 0.4.10 or later to see reactions');
  expect(thumbs.getAttribute('aria-label')).toContain('Not delivered');
  // Someone else's reaction is never flagged, even if listed.
  const party=screen.getByRole('button',{name:/^🎉 1 reaction/});
  expect(party.classList.contains('is-undelivered')).toBe(false);expect(party.title).not.toContain('Not delivered');
 }finally{mock.snapshot.undeliveredReactions=prior;}
}));

it('hands a message to a new task or a running agent, only on a click',async()=>{
 const startTask=vi.fn(async(project:string)=>({started:true,project,note:''})),sendToAgent=vi.fn(async()=>'m9');
 const stop=setChatHandoff({projects:()=>['canopy-ide','portal'],agents:async()=>[{ptyId:7,name:'Wren',project:'portal',cli:'claude'}],startTask,sendToAgent});
 try{
  render(<AccountChatView conversation={channel}/>);
  expect(startTask).not.toHaveBeenCalled();expect(sendToAgent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Run as task'}));
  fireEvent.change(screen.getByRole('combobox',{name:'Workspace'}),{target:{value:'portal'}});
  fireEvent.click(screen.getByRole('button',{name:'Start task'}));
  await waitFor(()=>expect(startTask).toHaveBeenCalledWith('portal',expect.stringMatching(/^Ada Lovelace sent this in Canopy Teams chat \(#Engineering\)[\s\S]*Hello team/),'Hello team'));
  expect(await screen.findByText('Task started in portal.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Send to agent'}));
  expect(await screen.findByRole('option',{name:'Wren · portal (claude)'})).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button',{name:'Send'}).find(b=>b.closest('.account-chat-handoff'))!);
  await waitFor(()=>expect(sendToAgent).toHaveBeenCalledWith(7,expect.stringContaining('Hello team'),'m'));
  expect(await screen.findByText('Sent to Wren.')).toBeTruthy();
 }finally{stop();}
});

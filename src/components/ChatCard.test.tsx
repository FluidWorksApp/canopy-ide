import {render,screen,fireEvent,cleanup,waitFor,within} from '@testing-library/react';
import {afterEach,it,expect,vi,describe} from 'vitest';
import {ChatCard,type ChatCardDeps} from './ChatCard';
import type {ChatMessage} from '../teamMessaging/client';
import {parseCard,type Card} from '../teamMessaging/cardSchema';
import type * as ipc from '../ipc';

const A='a'.repeat(40),B='b'.repeat(40),N='c'.repeat(40);
const repo={host:'github.com',slug:'acme/api'};
const REQ='11111111-1111-4111-8111-111111111111';
const pr=(head=A)=>({number:12,title:'Fix',head_sha:head}) as ipc.PrInfo;
function deps(over:Partial<Omit<ChatCardDeps,'lookups'>>&{here?:boolean;lookups?:Partial<ChatCardDeps['lookups']>}={}):ChatCardDeps&{calls:Record<string,unknown[][]>}{
 const calls:Record<string,unknown[][]>={open:[],external:[],review:[],copy:[]};
 const {here=true,lookups,...rest}=over;
 return {calls,
  lookups:{repos:here?['/work/api']:[],remoteUrl:async()=>'git@github.com:acme/api.git',prs:async()=>[pr()],issues:async()=>[],commit:async()=>({hash:B,short:'bbbbbbb',subject:'s'}) as ipc.CommitDetail,fileExists:async()=>true,head:async()=>A,containedPath:async(r,p)=>`${r}/${p}`,...lookups},
  ghAvailable:async()=>true,
  ghPrReview:async(...args)=>{calls.review.push(args);return 'ok';},
  revCount:async()=>3,
  showAt:async()=>'one\ntwo\nthree\n',
  open:(action)=>{calls.open.push([action]);return true;},
  openExternal:url=>{calls.external.push([url]);},
  copy:async text=>{calls.copy.push([text]);},
  ...rest};
}
const msg=(card:Card,over:Partial<ChatMessage>={}):ChatMessage=>({id:REQ,sender:'alice',recipient:null,text:'t',created:1,card,...over});
const view=(card:Card,d:ChatCardDeps,over:{userId?:string;messages?:ChatMessage[];message?:Partial<ChatMessage>;onReply?:(t:string,e:unknown)=>Promise<unknown>}={})=>{
 const m=msg(card,over.message);
 return render(<ChatCard message={m} userId={over.userId??'bob'} messages={over.messages??[m]} name={id=>id.toUpperCase()} onReply={over.onReply} deps={d}/>);
};
afterEach(cleanup);

const cards:Card[]=[
 {type:'pr',v:1,repo,number:12,title:'Fix the cache'},
 {type:'file',v:1,repo,path:'src/a.ts',rev:A,lines:{start:2,end:3},snippet:'two\nthree'},
 {type:'diff',v:1,repo,base:A,head:B,path:'src/a.ts',patch:'@@ -1 +1 @@\n-a\n+b'},
 {type:'terminal',v:1,title:'npm test',command:'npm test',output:'2 passed',exit:0},
 {type:'report',v:1,agent:'Reviewer',title:'Review map',body:'See ![img](https://evil.example/x.png) and **bold**'},
 {type:'review-request',v:1,repo,number:12,title:'Fix',head:A,reviewers:['bob']},
 {type:'review-outcome',v:1,request:REQ,repo,number:12,outcome:'approved'},
];

describe('ChatCard',()=>{
 it.each(cards.map(c=>[c.type,c]))('renders a %s card',async(_type,card)=>{
  expect(parseCard(card)).toBeDefined();
  const {container}=view(card,deps());
  expect(container.querySelector(`.chat-card[data-type="${card.type}"]`)).toBeTruthy();
  await waitFor(()=>expect(container.querySelector('[aria-busy="true"]')).toBeNull());
 });
 it('renders nothing for a message whose card is invalid',()=>{
  const {container}=view({...cards[1],path:'../etc/passwd'} as Card,deps());
  expect(container.innerHTML).toBe('');
 });
 it('opens a PR natively only on a click',async()=>{
  const d=deps();view(cards[0],d);
  const open=await screen.findByRole('button',{name:'Open'});
  expect(d.calls.open).toEqual([]);
  fireEvent.click(open);
  expect(d.calls.open[0][0]).toMatchObject({do:'pr',repo:'/work/api'});
 });
 it('offers only the host page without a checkout',async()=>{
  const d=deps({here:false});view(cards[0],d);
  const web=await screen.findByRole('button',{name:/Open on github.com/});
  expect(screen.queryByRole('button',{name:'Open'})).toBeNull();
  fireEvent.click(web);
  expect(d.calls.external).toEqual([['https://github.com/acme/api/pull/12']]);
 });
 it('says when the checkout is at another commit, and shows the shared revision read-only',async()=>{
  const d=deps({lookups:{head:async()=>N}});view(cards[1],d);
  expect(await screen.findByText(/your checkout is at/)).toBeTruthy();
  expect(screen.getByRole('note').textContent).toContain('Shared at aaaaaaa; your checkout is at ccccccc');
  fireEvent.click(screen.getByRole('button',{name:'View at aaaaaaa'}));
  expect((await screen.findByLabelText('src/a.ts at aaaaaaa')).textContent).toContain('2  two');
 });
 it('renders terminal output as text to copy, with nothing to run',async()=>{
  const d=deps();view(cards[3],d);
  expect(screen.getByLabelText('Terminal output').textContent).toBe('2 passed');
  expect(screen.queryByRole('button',{name:/run/i})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Copy output'}));
  await waitFor(()=>expect(d.calls.copy).toEqual([['2 passed']]));
 });
 it('renders a report as plain text, never Markdown or images',()=>{
  const {container}=view(cards[4],deps());
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('strong')).toBeNull();
  expect(screen.getByLabelText('Report').textContent).toContain('**bold**');
  expect(screen.getByText(/Written by an agent/)).toBeTruthy();
 });
 it('shows a diff patch on request',async()=>{
  view(cards[2],deps());
  fireEvent.click(screen.getByRole('button',{name:'Show patch'}));
  expect(screen.getByLabelText('Patch').textContent).toContain('+b');
  expect(await screen.findByRole('button',{name:'Open commit'})).toBeTruthy();
 });
});

describe('review requests',()=>{
 const request=cards[5];
 it('disables reviewing without a checkout or gh',async()=>{
  view(request,deps({here:false}),{onReply:async()=>{}});
  expect(await screen.findByText('No checkout of acme/api here')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Approve…'})).toBeNull();
  expect(screen.getByRole('button',{name:/Open on github.com/})).toBeTruthy();
  cleanup();
  view(request,deps({ghAvailable:async()=>false}),{onReply:async()=>{}});
  expect(await screen.findByText(/gh\) is not available/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Approve…'})).toBeNull();
 });
 it('approves only after a confirm, then posts the outcome as a thread reply',async()=>{
  const d=deps(),replies:unknown[][]=[];
  view(request,d,{onReply:async(...a)=>{replies.push(a);}});
  fireEvent.click(await screen.findByRole('button',{name:'Approve…'}));
  expect(d.calls.review).toEqual([]);
  fireEvent.change(screen.getByLabelText('Comment (optional)'),{target:{value:'LGTM'}});
  fireEvent.click(screen.getByRole('button',{name:'Approve'}));
  await waitFor(()=>expect(d.calls.review).toEqual([['/work/api',12,'approve','LGTM']]));
  await waitFor(()=>expect(replies).toHaveLength(1));
  const [text,ext]=replies[0] as [string,{card:Card;thread:{root:string}}];
  expect(text).toBe('✅ Approved acme/api#12 (via Canopy)\nhttps://github.com/acme/api/pull/12');
  expect(ext.thread).toEqual({root:REQ});
  expect(ext.card).toMatchObject({type:'review-outcome',request:REQ,outcome:'approved',head:A});
 });
 it('needs a comment to request changes',async()=>{
  const d=deps();view(request,d,{onReply:async()=>{}});
  fireEvent.click(await screen.findByRole('button',{name:'Request changes…'}));
  const submit=screen.getByRole('button',{name:'Request changes'});
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('What needs to change'),{target:{value:'Add a test'}});
  fireEvent.click(submit);
  await waitFor(()=>expect(d.calls.review).toEqual([['/work/api',12,'request-changes','Add a test']]));
 });
 it('warns when the head moved and asks again',async()=>{
  const d=deps({lookups:{prs:async()=>[pr(N)]}}),replies:unknown[][]=[];
  view(request,d,{onReply:async(...a)=>{replies.push(a);}});
  fireEvent.click(await screen.findByRole('button',{name:'Approve…'}));
  fireEvent.click(screen.getByRole('button',{name:'Approve'}));
  expect(await screen.findByText(/3 new commits since the request/)).toBeTruthy();
  expect(d.calls.review).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Approve the latest'}));
  await waitFor(()=>expect(d.calls.review).toHaveLength(1));
  await waitFor(()=>expect((replies[0][1] as {card:{head:string}}).card.head).toBe(N));
 });
 it('posts nothing when gh fails',async()=>{
  const replies:unknown[]=[];
  view(request,deps({ghPrReview:async()=>{throw Error('gh: HTTP 422');}}),{onReply:async(...a)=>{replies.push(a);}});
  fireEvent.click(await screen.findByRole('button',{name:'Approve…'}));
  fireEvent.click(screen.getByRole('button',{name:'Approve'}));
  expect(await screen.findByText('gh: HTTP 422')).toBeTruthy();
  expect(replies).toEqual([]);
 });
 it('folds outcomes into chips on the requester side',()=>{
  const req:Card={...request,reviewers:['bob','carol']} as Card;
  const m=msg(req,{sender:'me'});
  const outcome=(id:string,sender:string,created:number,outcome:string):ChatMessage=>({id,sender,recipient:null,text:'t',created,thread:{root:REQ},card:{type:'review-outcome',v:1,request:REQ,repo,number:12,outcome}});
  render(<ChatCard message={m} userId="me" name={id=>id.toUpperCase()} deps={deps()} messages={[m,
   outcome('22222222-2222-4222-8222-222222222222','bob',2,'changes-requested'),
   outcome('33333333-3333-4333-8333-333333333333','bob',3,'approved')]}/>);
  const chips=within(screen.getByRole('list',{name:'Reviews'})).getAllByRole('listitem').map(li=>li.textContent);
  expect(chips).toEqual(['BOB ✅ Approved','CAROL Pending']);
  expect(screen.queryByRole('button',{name:'Approve…'})).toBeNull();
 });
});
vi.mock('../prWatchStore',()=>({watchedPaths:()=>[]}));

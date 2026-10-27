import {describe,expect,it} from 'vitest';
import {LIMITS,cardDraft,cardText,cardUrl,foldLayerApproval,foldOutcomes,parseCard,secretKinds,stripAnsi,validCardPath,type Card} from './cardSchema';
import {parseExtensions} from './chatEvents';
import type {ChatMessage} from './client';
import {v1ValidChatMessage,v1Renders,v1ValidateMessage} from './fixtures/v1Schema';
import {validChatMessage} from './messageSchema';

const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(64);
const repo={host:'github.com',slug:'owner/repo'};
const UUID1='11111111-1111-4111-8111-111111111111',UUID2='22222222-2222-4222-8222-222222222222';
const cards:Card[]=[
 {type:'pr',v:1,repo,number:123,title:'Fix the thing',head:A,base:B},
 {type:'file',v:1,repo,path:'src/a.ts',rev:A,lines:{start:10,end:20},snippet:'const a=1;\n\tconst b=2;'},
 {type:'diff',v:1,repo,base:A,head:C,path:'src/a.ts',lines:{start:1,end:3,side:'new'},patch:'@@ -1 +1 @@\n-a\n+b',pr:7},
 {type:'terminal',v:1,title:'npm test',command:'npm test',output:'ok\n2 passed',exit:0,truncated:false},
 {type:'report',v:1,agent:'Review agent',title:'Review map',body:'# Notes\n![x](https://evil/x.png)',repo,pr:7},
 {type:'review-request',v:1,repo,number:123,title:'Fix',head:A,reviewers:['u1','u2']},
 {type:'review-outcome',v:1,request:UUID1,repo,number:123,outcome:'approved',head:A},
];

describe('parseCard',()=>{
 it('accepts every well formed card type and returns a fresh copy',()=>{
  for(const card of cards){const parsed=parseCard(JSON.parse(JSON.stringify(card)));expect(parsed).toEqual(card);expect(parsed).not.toBe(card);}
 });
 it('drops unknown types, versions and fields',()=>{
  expect(parseCard({...cards[0],type:'poll'})).toBeUndefined();
  expect(parseCard({...cards[0],v:2})).toBeUndefined();
  expect(parseCard({...cards[0],url:'https://evil'})).toBeUndefined();
  expect(parseCard({...cards[0],repo:{...repo,path:'/home/me/repo'}})).toBeUndefined();
  expect(parseCard(null)).toBeUndefined();expect(parseCard([])).toBeUndefined();expect(parseCard('x')).toBeUndefined();
 });
 const file=(path:string)=>parseCard({type:'file',v:1,repo,path,rev:A});
 it.each([
  ['../a'],['a/../b'],['a\\b'],['/abs'],['C:/x'],['c:x'],['%2e%2e/a'],['a/%2E%2e'],['a%2fb'],['a%5cb'],['.git/config'],['a/.GIT/HEAD'],
  ['a\u0000b'],['a\u202eb'],['a\u2066b'],['a\u001b[31mb'],['a\u0085b'],['./a'],['a/./b'],['a//b'],['a/'],[''],
 ])('refuses the path %j',path=>{expect(validCardPath(path)).toBe(false);expect(file(path)).toBeUndefined();});
 it('accepts ordinary repo paths',()=>{for(const p of ['a','src/a.ts','.github/workflows/ci.yml','dir with space/x-y_z.1','ünïcode/文件.md'])expect(file(p)).toBeDefined();});
 it('checks repo refs',()=>{
  const r=(host:string,slug:string)=>parseCard({...cards[0],repo:{host,slug}});
  expect(r('github.example.com:8443','g/sub/name')).toBeDefined();
  for(const [h,s] of [['GitHub.com','o/r'],['github.com/x','o/r'],['-x.com','o/r'],['github.com','single'],['github.com','a/b/c/d/e/f'],['github.com','o/..'],['github.com','o/./r'],['github.com','o r/x'],['github.com',`o/${'r'.repeat(200)}`],['github.com','o/r\u202e']])expect(r(h,s)).toBeUndefined();
 });
 it('needs full shas',()=>{
  expect(parseCard({...cards[1],rev:A.slice(0,7)})).toBeUndefined();
  expect(parseCard({...cards[1],rev:A.toUpperCase()})).toBeUndefined();
  expect(parseCard({...cards[1],rev:C})).toBeDefined();
 });
 it('bounds numbers and line ranges',()=>{
  for(const n of [0,-1,1.5,1e9+1,'1'])expect(parseCard({...cards[0],number:n})).toBeUndefined();
  expect(parseCard({...cards[0],number:1e9})).toBeDefined();
  const lines=(l:unknown)=>parseCard({...cards[1],lines:l});
  expect(lines({start:1,end:2000})).toBeDefined();
  for(const l of [{start:1,end:2001},{start:0,end:1},{start:5,end:4},{start:999_999,end:1_000_001},{start:1,end:2,side:'new'}])expect(lines(l)).toBeUndefined();
  expect(parseCard({...cards[2],lines:{start:1,end:2}})).toBeUndefined();
  expect(parseCard({...cards[2],lines:{start:1,end:2,side:'mid'}})).toBeUndefined();
 });
 it('refuses unsafe display text',()=>{
  for(const bad of ['a\u202eb','a\nb','a\u001bb','a\u0000b','a\u009bb','a\u2069b',''])expect(parseCard({...cards[0],title:bad})).toBeUndefined();
  expect(parseCard({...cards[0],title:'t'.repeat(LIMITS.title)})).toBeDefined();
  expect(parseCard({...cards[0],title:'t'.repeat(LIMITS.title+1)})).toBeUndefined();
  // Blocks keep newlines and tabs, nothing else.
  expect(parseCard({...cards[3],output:'a\n\tb'})).toBeDefined();
  for(const bad of ['a\rb','a\u001b[31mb','a\u202eb','a\u0007b'])expect(parseCard({...cards[3],output:bad})).toBeUndefined();
  expect(parseCard({...cards[3],command:'a\nb'})).toBeUndefined();
 });
 it('enforces the size limits at the boundary',()=>{
  expect(parseCard({...cards[1],snippet:'x'.repeat(LIMITS.snippetBytes)})).toBeDefined();
  expect(parseCard({...cards[1],snippet:'x'.repeat(LIMITS.snippetBytes+1)})).toBeUndefined();
  expect(parseCard({...cards[1],snippet:'é'.repeat(LIMITS.snippetBytes/2)})).toBeDefined();
  expect(parseCard({...cards[1],snippet:'é'.repeat(LIMITS.snippetBytes/2)+'x'})).toBeUndefined();
  expect(parseCard({...cards[3],output:'x'.repeat(LIMITS.outputBytes)})).toBeDefined();
  expect(parseCard({...cards[3],output:'x'.repeat(LIMITS.outputBytes+1)})).toBeUndefined();
  expect(parseCard({...cards[4],body:'x'.repeat(LIMITS.bodyBytes+1)})).toBeUndefined();
  // Each field within its own cap, the card over the whole-card cap.
  const big={...cards[3],command:'c'.repeat(1024),output:'x'.repeat(LIMITS.outputBytes)};
  expect(JSON.stringify(big).length).toBeGreaterThan(LIMITS.cardBytes-2000);
  const bigger={...cards[3],title:'é'.repeat(200),command:'é'.repeat(1024),output:'x'.repeat(LIMITS.outputBytes)};
  expect(parseCard(bigger)).toBeUndefined();
  expect(()=>cardDraft(bigger as Card)).toThrow(/too large/);
 });
 it('bounds reviewers',()=>{
  const req=(reviewers:unknown)=>parseCard({...cards[5],reviewers});
  expect(req(Array.from({length:20},(_,i)=>`u${i}`))).toBeDefined();
  for(const r of [[],Array.from({length:21},(_,i)=>`u${i}`),['u1','u1'],['u\u0000'],[1],'u1'])expect(req(r)).toBeUndefined();
 });
 it('checks review outcomes',()=>{
  expect(parseCard({...cards[6],request:'nope'})).toBeUndefined();
  expect(parseCard({...cards[6],outcome:'merged'})).toBeUndefined();
  expect(parseCard({...cards[6],head:undefined})).toBeDefined();
 });
});

describe('the lenient extension parser',()=>{
 const msg=(card:unknown):ChatMessage=>({id:UUID1,sender:'u1',recipient:null,text:'fallback',created:1,v:2,card});
 it('surfaces a valid card',()=>expect(parseExtensions(msg(cards[0])).card).toEqual(cards[0]));
 it('drops an unknown card type, leaving a plain message',()=>{
  const ext=parseExtensions(msg({...cards[0],type:'poll'}));
  expect(ext.card).toBeUndefined();expect(ext.event).toBeUndefined();
 });
 it('drops a malformed card without failing the message',()=>{
  const m=msg({type:'file',v:1,repo,path:'../../etc/passwd',rev:A});
  expect(validChatMessage(m)).toBe(true);expect(parseExtensions(m).card).toBeUndefined();
 });
});

describe('fallback text',()=>{
 it('has the summary and canonical url',()=>{
  expect(cardText(cards[0])).toBe('PR owner/repo#123: Fix the thing\nhttps://github.com/owner/repo/pull/123');
  expect(cardText(cards[1],'look here')).toBe(`look here\nowner/repo src/a.ts:10-20 @ aaaaaaa\nhttps://github.com/owner/repo/blob/${A}/src/a.ts#L10-L20`);
  expect(cardText(cards[6])).toBe('✅ Approved owner/repo#123 (via Canopy)\nhttps://github.com/owner/repo/pull/123');
  expect(cardUrl(cards[2])).toBe('https://github.com/owner/repo/pull/7/files');
  expect(cardUrl({...cards[2],pr:undefined} as Card)).toBe(`https://github.com/owner/repo/compare/${A}...${C}`);
  expect(cardUrl({...cards[0],repo:{host:'gitlab.com',slug:'g/sub/r'}} as Card)).toBe('https://gitlab.com/g/sub/r/-/merge_requests/123');
  expect(cardUrl({...cards[1],path:'a b/#c.ts'} as Card)).toContain('/a%20b/%23c.ts#L10-L20');
  expect(cardUrl(cards[3])).toBeUndefined();
 });
 it('excerpts terminal output and reports to about 1 KB',()=>{
  const t=cardText({...cards[3],output:'x'.repeat(5000)} as Card);
  expect(new TextEncoder().encode(t).length).toBeLessThan(1200);expect(t.endsWith('…')).toBe(true);
 });
});

describe('v1 clients',()=>{
 it('accept, store and show every card message with non-empty text',()=>{
  const big:Card[]=[...cards,{...cards[3],output:'x'.repeat(LIMITS.outputBytes)} as Card,{...cards[4],body:'é'.repeat(LIMITS.bodyBytes/2)} as Card];
  for(const card of big){
   const draft=cardDraft(card,'note',card.type==='review-request'?{mentions:['u1','u2']}:card.type==='review-outcome'?{thread:{root:UUID2}}:{});
   const m={id:UUID1,sender:'u9',recipient:null,text:draft.text,created:Date.now(),v:2,...draft.ext} as ChatMessage;
   expect(v1ValidChatMessage(m)).toBe(true);
   expect(()=>v1ValidateMessage(m,'u9','me',{created:m.created,expires:m.created+60_000})).not.toThrow();
   expect(v1Renders(m)).toBe(true);
   expect(new TextEncoder().encode(JSON.stringify({kind:'message',message:m})).length).toBeLessThan(32000);
  }
 });
});

describe('secrets and ANSI',()=>{
 it('flags common credentials',()=>{
  expect(secretKinds('export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('a GitHub token');
  expect(secretKinds('AKIAIOSFODNN7EXAMPLE')).toContain('an AWS access key');
  expect(secretKinds('-----BEGIN OPENSSH PRIVATE KEY-----')).toContain('a private key');
  expect(secretKinds('password = hunter22hunter')).toContain('a password or secret');
  expect(secretKinds('https://user:pass1234@host/x')).toContain('credentials in a URL');
  expect(secretKinds('all 12 tests passed')).toEqual([]);
 });
 it('strips escape sequences and control characters',()=>{
  expect(stripAnsi('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\r\nnext\u0007\u202e')).toBe('red ok\nnext');
  expect(stripAnsi('\u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
 });
});

describe('foldOutcomes',()=>{
 const request:ChatMessage={id:UUID1,sender:'me',recipient:null,text:'t',created:1,card:cards[5]};
 const outcome=(id:string,sender:string,created:number,outcome:string,extra:Partial<ChatMessage>={}):ChatMessage=>({id,sender,recipient:null,text:'t',created,thread:{root:UUID1},card:{type:'review-outcome',v:1,request:UUID1,repo,number:123,outcome},...extra});
 it('keeps the latest outcome per reviewer by (created,id)',()=>{
  const folded=foldOutcomes(request,[request,
   outcome('33333333-3333-4333-8333-333333333333','u1',5,'changes-requested'),
   outcome('44444444-4444-4444-8444-444444444444','u1',9,'approved'),
   outcome('55555555-5555-4555-8555-555555555555','u2',4,'commented'),
   outcome('66666666-6666-4666-8666-666666666666','u2',4,'approved'),
  ]);
  expect(folded.map(f=>[f.reviewer,f.outcome])).toEqual([['u1','approved'],['u2','approved']]);
 });
 it('ignores non-reviewers, other threads, other PRs and other conversations',()=>{
  const folded=foldOutcomes(request,[
   outcome('33333333-3333-4333-8333-333333333333','intruder',5,'approved'),
   outcome('44444444-4444-4444-8444-444444444444','u1',5,'approved',{thread:{root:UUID2}}),
   outcome('55555555-5555-4555-8555-555555555555','u1',6,'approved',{card:{type:'review-outcome',v:1,request:UUID1,repo,number:999,outcome:'approved'}}),
   outcome('66666666-6666-4666-8666-666666666666','u2',6,'approved',{recipient:'me'}),
  ]);
  expect(folded).toEqual([]);
 });
});

describe('layer approval cards',()=>{
 const request:Card={type:'layer-approval',v:1,approval:'la-abc123',layer:'data',owner:'u-sam',project:'Shop',files:['prisma/schema.prisma','prisma/seed.ts'],summary:'What was asked for: add a phone number\n+phone String',repo};
 const msg=(over:Partial<ChatMessage>):ChatMessage=>({id:UUID1,sender:'u-alex',recipient:'u-sam',text:'',created:1,...over} as ChatMessage);
 it('round-trips and rejects what a modified client might send',()=>{
  expect(parseCard(JSON.parse(JSON.stringify(request)))).toEqual(request);
  expect(parseCard({...request,approval:'../etc'})).toBeUndefined();
  expect(parseCard({...request,layer:'view'})).toBeUndefined();
  expect(parseCard({...request,files:['/etc/passwd']})).toBeUndefined();
  expect(parseCard({...request,files:[]})).toBeUndefined();
  expect(parseCard({...request,files:Array.from({length:LIMITS.approvalFiles+1},(_,i)=>`f${i}.ts`)})).toBeUndefined();
  expect(parseCard({...request,summary:'x‮y'})).toBeUndefined();
  expect(parseCard({...request,path:'/x'})).toBeUndefined();
  const outcome={type:'layer-approval-outcome',v:1,request:UUID1,approval:'la-abc123',outcome:'approved'};
  expect(parseCard(outcome)).toEqual(outcome);
  expect(parseCard({...outcome,outcome:'maybe'})).toBeUndefined();
  expect(parseCard({...outcome,request:'not-a-uuid'})).toBeUndefined();
 });
 it('falls back to text that names the files, and has no URL',()=>{
  const text=cardText(request);
  expect(text).toContain('Approval needed: Data change in Shop (2 files)');
  expect(text).toContain('- prisma/schema.prisma');
  expect(cardUrl(request)).toBeUndefined();
 });
 it('folds only the owner’s answer in the request’s thread',()=>{
  const req=msg({card:request});
  const answer=(sender:string,outcome:string,created:number,thread=UUID1)=>msg({id:`3333333${created}-3333-4333-8333-333333333333`,sender,recipient:'u-alex',created,thread:{root:thread},card:{type:'layer-approval-outcome',v:1,request:UUID1,approval:'la-abc123',outcome}});
  expect(foldLayerApproval(req,[req])).toBeUndefined();
  expect(foldLayerApproval(req,[req,answer('u-mallory','approved',2)])).toBeUndefined();
  expect(foldLayerApproval(req,[req,answer('u-sam','approved',2,UUID2)])).toBeUndefined();
  expect(foldLayerApproval(req,[req,answer('u-sam','approved',2),answer('u-sam','rejected',3)])?.outcome).toBe('rejected');
 });
});

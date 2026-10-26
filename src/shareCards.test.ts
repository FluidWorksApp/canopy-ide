import {beforeEach,describe,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({origin:'git@github.com:acme/api.git',ctx:{root:'/w/api',rel:'src/a.ts',head:'a'.repeat(40),origin:'git@github.com:acme/api.git',dirty:false},list:[] as unknown[]}));
vi.mock('./ipc',()=>({
 gitRemoteUrl:async()=>io.origin,
 gitShareContext:async()=>io.ctx,
 ghPrList:async()=>io.list,
}));
import {ShareError,buildDiffCard,buildFileCard,buildPrCard,buildReportCard,buildReviewRequest,buildTerminalCard} from './shareCards';
import {LIMITS,parseCard} from './teamMessaging/cardSchema';
import type * as ipc from './ipc';

const A='a'.repeat(40),B='b'.repeat(40);
const pr=(over:Partial<ipc.PrInfo>={})=>({number:12,title:'Fix‮ the\ncache',head_sha:A,base_sha:B,...over}) as ipc.PrInfo;
beforeEach(()=>{io.origin='git@github.com:acme/api.git';io.ctx={root:'/w/api',rel:'src/a.ts',head:A,origin:io.origin,dirty:false};io.list=[];});

describe('repo cards',()=>{
 it('names the repo by origin and cleans the title',async()=>{
  const card=await buildPrCard('/w/api',pr());
  expect(card).toEqual({type:'pr',v:1,repo:{host:'github.com',slug:'acme/api'},number:12,title:'Fix the cache',head:A,base:B});
  expect(parseCard(card)).toEqual(card);
 });
 it('refuses a checkout without an origin',async()=>{
  io.origin='';
  await expect(buildPrCard('/w/api',pr())).rejects.toBeInstanceOf(ShareError);
  io.ctx={...io.ctx,origin:''};
  await expect(buildFileCard('/w/api/src/a.ts',1,2,'x')).rejects.toThrow(/no origin/);
 });
 it('pins a review request to the head, fetching it when the row lacks it',async()=>{
  io.list=[pr({head_sha:B})];
  expect((await buildReviewRequest('/w/api',pr({head_sha:''}))).head).toBe(B);
  io.list=[];
  await expect(buildReviewRequest('/w/api',pr({head_sha:''}))).rejects.toThrow(/head commit/);
 });
 it('needs both commits for a diff and clips the patch to a card',async()=>{
  await expect(buildDiffCard('/w/api',pr({base_sha:''}),'a.ts','+x')).rejects.toThrow(/commits/);
  const big=Array.from({length:2000},(_,i)=>`+line ${i}`).join('\n');
  const {card,warning}=await buildDiffCard('/w/api',pr(),'a.ts',big);
  expect(new TextEncoder().encode(card.patch).length).toBeLessThanOrEqual(LIMITS.patchBytes);
  expect(warning).toMatch(/shortened/);
  expect(parseCard(card)).toBeDefined();
 });
});

describe('file cards',()=>{
 it('shares lines at HEAD, warning about uncommitted changes',async()=>{
  io.ctx={...io.ctx,dirty:true};
  const {card,warning}=await buildFileCard('/w/api/src/a.ts',3,4,'one‮\r\ntwo');
  expect(card).toMatchObject({path:'src/a.ts',rev:A,lines:{start:3,end:4},snippet:'one\ntwo'});
  expect(warning).toMatch(/uncommitted changes/);
  expect(parseCard(card)).toBeDefined();
 });
 it('refuses huge selections, unborn repos and paths in .git',async()=>{
  await expect(buildFileCard('/w/api/src/a.ts',1,2001,'x')).rejects.toThrow(/2000 lines/);
  io.ctx={...io.ctx,head:''};
  await expect(buildFileCard('/w/api/src/a.ts',1,1,'x')).rejects.toThrow(/no commits/);
  io.ctx={...io.ctx,head:A,rel:'.git/config'};
  await expect(buildFileCard('/w/api/.git/config',1,1,'x')).rejects.toThrow(/can't be shared/);
 });
});

describe('text cards',()=>{
 it('strips ANSI from terminal output and keeps the end of long output',()=>{
  const card=buildTerminalCard('npm test','\u001b[32mok\u001b[0m\r\n','npm test');
  expect(card).toEqual({type:'terminal',v:1,title:'npm test',command:'npm test',output:'ok'});
  const long=buildTerminalCard('t',Array.from({length:3000},(_,i)=>`line ${i}`).join('\n'));
  expect(long.truncated).toBe(true);expect(long.output.endsWith('line 2999')).toBe(true);
  expect(parseCard(long)).toBeDefined();
  expect(()=>buildTerminalCard('t','  \n')).toThrow(/Select/);
 });
 it('keeps a report without an origin, just without a repo',async()=>{
  io.origin='';
  const card=await buildReportCard('Agent','Map','# Hi\n![x](https://e/x.png)','/w/api',12);
  expect(card).toEqual({type:'report',v:1,agent:'Agent',title:'Map',body:'# Hi\n![x](https://e/x.png)'});
 });
});

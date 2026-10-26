import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>({open:[] as unknown[][],browser:[] as string[]}));
vi.mock('../links',()=>({openLink:(...args:unknown[])=>calls.open.push(args),openInOsBrowser:(url:string)=>calls.browser.push(url)}));
import {ChatLinkCards} from './ChatLinkCards';
import {__resetCardCache,type CardLookups} from '../chatLinkCards';
import type * as ipc from '../ipc';

const PR='https://github.com/acme/api/pull/12';
const pr=(over:Partial<ipc.PrInfo>={}):ipc.PrInfo=>({number:12,title:'Fix the cache',author:'ada',branch:'fix',base:'main',draft:false,state:'OPEN',url:PR,created:'',updated:'',review_decision:'APPROVED',additions:1,deletions:1,mine:false,mergeable:'MERGEABLE',checks:'PASS',checks_summary:'4/4 checks passed',...over});
const look=(over:Partial<CardLookups>={}):CardLookups=>({
 watchedRows:()=>[],repos:()=>['/work/api'],remoteUrl:async()=>'git@github.com:acme/api.git',
 prs:async()=>[pr()],prState:async()=>'MERGED',
 issues:async()=>[],issueDetail:async()=>({internal_id:'',author:'grace',created_at:'',updated_at:'',state:'open',state_id:'',states:[],comments:[]}),
 commit:async()=>({hash:'abcdef1234',short:'abcdef1',author:'linus',email:'',date:'',subject:'Tidy up',body:'',refs:'',parents:[]}),
 ...over,
});
beforeEach(()=>{__resetCardCache();calls.open.length=0;calls.browser.length=0;});
afterEach(cleanup);

it('renders nothing for a message without PR, issue or commit links',()=>{
 const {container}=render(<ChatLinkCards text="see https://example.com and #12" lookups={look()}/>);
 expect(container.innerHTML).toBe('');
});
it('renders an open PR with author, CI and review, opening natively and in the browser',async()=>{
 render(<ChatLinkCards text={`look ${PR}`} lookups={look()}/>);
 const open=await screen.findByRole('button',{name:'Open Pull request #12 in acme/api, Fix the cache, Open, by ada, Checks passing, Approved'});
 expect(screen.getByText('Checks passing')).toBeTruthy();
 fireEvent.click(open);
 expect(calls.open).toEqual([[PR,false,{anyProject:true}]]);
 fireEvent.click(screen.getByRole('button',{name:'Open pull request #12 in browser'}));
 expect(calls.browser).toEqual([PR]);
});
it.each([
 ['draft',{prs:async()=>[pr({draft:true})]},'Draft'],
 ['merged',{prs:async()=>[]},'Merged'],
 ['closed',{prs:async()=>[],prState:async()=>'CLOSED'},'Closed'],
] as const)('shows a %s PR as such',async(state,over,label)=>{
 render(<ChatLinkCards text={PR} lookups={look(over as Partial<CardLookups>)}/>);
 await waitFor(()=>expect(document.querySelector('.chat-link-card')?.getAttribute('data-state')).toBe(state));
 expect(screen.getByText(label)).toBeTruthy();
});
it('renders issue and commit cards, capped at three per message',async()=>{
 const text=`${PR} https://github.com/acme/api/issues/7 https://github.com/acme/api/commit/abcdef1234 https://github.com/acme/api/pull/13`;
 render(<ChatLinkCards text={text} lookups={look()}/>);
 await screen.findByText('Tidy up');
 expect(screen.getAllByRole('button',{name:/^Open (Pull request|Issue|Commit)/})).toHaveLength(3);
 expect(screen.getByRole('button',{name:/^Open Issue #7 in acme\/api, Open, by grace$/})).toBeTruthy();
});
it('falls back to a compact card, never an error, when gh fails',async()=>{
 render(<ChatLinkCards text={PR} lookups={look({prs:async()=>{throw new Error('gh: not authenticated');}})}/>);
 await waitFor(()=>expect(document.querySelector('.chat-link-card')?.getAttribute('aria-busy')).toBeNull());
 expect(screen.getByRole('button',{name:'Open Pull request #12 in acme/api'})).toBeTruthy();
 expect(screen.getByText('Pull request')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
 expect(document.body.textContent).not.toMatch(/not authenticated/);
});
it('is keyboard-reachable: both actions are real buttons',async()=>{
 render(<ChatLinkCards text={PR} lookups={look()}/>);
 const buttons=await screen.findAllByRole('button');
 for(const b of buttons){expect(b.tagName).toBe('BUTTON');expect(b.getAttribute('type')).toBe('button');}
});

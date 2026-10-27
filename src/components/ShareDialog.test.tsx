import {render,screen,fireEvent,cleanup,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const sent=vi.hoisted(()=>[] as unknown[][]);
vi.mock('../teamMessaging/session',()=>{
 const snapshot={members:{me:'Me',bob:'Bob',carol:'Carol'}};
 return {teamSession:()=>({retain:()=>()=>{},subscribe:()=>()=>{},getSnapshot:()=>snapshot,send:async(...args:unknown[])=>{sent.push(args);return {id:'x'};}})};
});
vi.mock('../prWatchStore',()=>({watchedPaths:()=>[]}));
import {ShareDialog} from './ShareDialog';
import type {Card} from '../teamMessaging/cardSchema';

const A='a'.repeat(40);
const repo={host:'github.com',slug:'acme/api'};
const directory=async()=>({teams:[{id:'t1',name:'Core'}],selfId:'me'});
beforeEach(()=>{sent.length=0;});
afterEach(cleanup);

it('previews the exact card and fallback text, then sends it to the chosen conversation',async()=>{
 const onClose=vi.fn();
 const card:Card={type:'pr',v:1,repo,number:12,title:'Fix the cache'};
 render(<ShareDialog request={{kind:'share',card}} onClose={onClose} directory={directory}/>);
 await screen.findByRole('option',{name:'Bob'});
 fireEvent.change(screen.getByLabelText('Conversation'),{target:{value:'bob'}});
 fireEvent.change(screen.getByLabelText('Note'),{target:{value:'Can you look?'}});
 const preview=screen.getByRole('region',{name:'Preview'});
 expect(within(preview).getByLabelText('Fallback text').textContent).toBe('Can you look?\nPR acme/api#12: Fix the cache\nhttps://github.com/acme/api/pull/12');
 expect(preview.querySelector('.chat-card[data-type="pr"]')).toBeTruthy();
 expect(within(preview).getByLabelText('Card size')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(sent).toHaveLength(1));
 const [text,peer,files,ext]=sent[0] as [string,string,unknown[],{card:Card}];
 expect(text).toContain('PR acme/api#12');expect(peer).toBe('bob');expect(files).toEqual([]);
 expect(ext.card).toEqual(card);
 expect(onClose).toHaveBeenCalled();
});

it('warns when terminal output looks like it holds a credential',async()=>{
 const card:Card={type:'terminal',v:1,title:'env',output:'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'};
 render(<ShareDialog request={{kind:'share',card}} onClose={()=>{}} directory={directory}/>);
 expect((await screen.findByRole('alert')).textContent).toContain('a GitHub token');
 expect(await screen.findByRole('button',{name:'Send anyway'})).toBeTruthy();
});

it('does not warn for ordinary output',async()=>{
 const card:Card={type:'terminal',v:1,title:'npm test',output:'12 passed'};
 render(<ShareDialog request={{kind:'share',card}} onClose={()=>{}} directory={directory}/>);
 await screen.findByRole('button',{name:'Send'});
 expect(screen.queryByRole('alert')).toBeNull();
});

it('asks for reviewers and mentions them on a review request',async()=>{
 render(<ShareDialog request={{kind:'review',card:{type:'review-request',v:1,repo,number:12,title:'Fix',head:A}}} onClose={()=>{}} directory={directory}/>);
 await screen.findByRole('checkbox',{name:'Bob'});
 expect(screen.getByText('Choose who should review it.')).toBeTruthy();
 expect((screen.getByRole('button',{name:'Send'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('checkbox',{name:'Carol'}));
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(sent).toHaveLength(1));
 const [text,peer,,ext]=sent[0] as [string,null,unknown,{card:{reviewers:string[]};mentions:string[]}];
 expect(text).toContain('Review requested: acme/api#12 · head aaaaaaa');
 expect(peer).toBeNull();
 expect(ext.card.reviewers).toEqual(['carol']);expect(ext.mentions).toEqual(['carol']);
});

it('shows why something cannot be shared',()=>{
 render(<ShareDialog request={{kind:'error',message:'This checkout has no origin on a git host.'}} onClose={()=>{}} directory={directory}/>);
 expect(screen.getByRole('alert').textContent).toContain('no origin');
 expect(screen.queryByRole('button',{name:'Send'})).toBeNull();
});

it('Escape closes the share dialog, not the surface it was opened from',async()=>{
 // The session document (and every other opener) sits on the Escape stack;
 // the dialog opens over it and must be the one layer the key reaches.
 const {useEscape}=await import('../useEscape');
 const docClose=vi.fn(),dialogClose=vi.fn();
 function Doc(){useEscape(docClose);return <div>document</div>;}
 const card:Card={type:'pr',v:1,repo,number:12,title:'Fix the cache'};
 render(<><Doc/><ShareDialog request={{kind:'share',card}} onClose={dialogClose} directory={directory}/></>);
 await screen.findByRole('option',{name:'Bob'});
 fireEvent.keyDown(window,{key:'Escape'});
 expect(dialogClose).toHaveBeenCalledTimes(1);
 expect(docClose).not.toHaveBeenCalled();
});

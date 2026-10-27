import {afterEach,expect,it,vi} from 'vitest';import {act,cleanup,render,screen} from '@testing-library/react';
import type {TeamAccountState} from './TeamHub';
const hub=vi.hoisted(()=>({report:null as null|((state:TeamAccountState)=>void)}));
vi.mock('./TeamHub',()=>({TeamHub:({onAccount}:{onAccount?:(state:TeamAccountState)=>void})=>{hub.report=onAccount??null;return <div>Teams</div>;}}));
import {TeamPanel} from './TeamPanel';
import type {RelayHandle} from '../types';
afterEach(()=>{cleanup();hub.report=null;});
const relay=(role:'off'|'host'|'client')=>({status:{role,members:[],ips:[],port:0,code:null,self_id:null,visibility:'local',addr:null,name:''}} as unknown as RelayHandle);
const props=(role:'off'|'host'|'client'='off')=>({relay:relay(role),onOpenChat:vi.fn(),onOpenInboxItem:vi.fn(),onNotice:vi.fn()});
it('signed in, no join code or relay step is offered',()=>{
 render(<TeamPanel {...props()}/>);act(()=>hub.report?.('signed-in'));
 expect(screen.queryByRole('button',{name:/join code|relay/i})).toBeNull();
});
it('without an account the join-code fallback stays available',()=>{
 render(<TeamPanel {...props()}/>);act(()=>hub.report?.('signed-out'));
 expect(screen.getByRole('button',{name:'No account? Connect with a join code'})).toBeInTheDocument();
});
it('a relay session already running stays reachable when signed in',()=>{
 render(<TeamPanel {...props('client')}/>);act(()=>hub.report?.('signed-in'));
 expect(screen.getByRole('button',{name:'Self-hosted relay (connected)'})).toBeInTheDocument();
});
it('when teams cannot be loaded at all (offline LAN), the join-code fallback is offered',()=>{
 render(<TeamPanel {...props()}/>);act(()=>hub.report?.('unavailable'));
 expect(screen.getByRole('button',{name:'No account? Connect with a join code'})).toBeInTheDocument();
});

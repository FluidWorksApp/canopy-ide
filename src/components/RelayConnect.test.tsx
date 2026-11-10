import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
const sent=vi.hoisted(()=>[] as unknown[][]);
vi.mock('../teamMessaging/session',()=>({teamSession:()=>({send:async(...args:unknown[])=>{sent.push(args);return {id:'11111111-1111-4111-8111-111111111111'};}})}));
import {RelayConnect,offerAddress} from './RelayConnect';
import {setTeamIdentityFetchForTests} from '../teamIdentity';
import type {RelayHandle} from '../types';

const status=(over:Record<string,unknown>={})=>({role:'off',code:null,port:null,ips:[],addr:null,self_id:null,name:null,visibility:null,public_ip:null,members:[],...over});
const handle=(over:Record<string,unknown>={})=>{const hostStart=vi.fn().mockResolvedValue(undefined),hostStop=vi.fn().mockResolvedValue(undefined),connect=vi.fn().mockResolvedValue(undefined);return {hostStart,hostStop,connect,disconnect:vi.fn(),status:status(over)} as unknown as RelayHandle&{hostStart:ReturnType<typeof vi.fn>;hostStop:ReturnType<typeof vi.fn>;connect:ReturnType<typeof vi.fn>};};
const signedIn=()=>setTeamIdentityFetchForTests(async()=>({user:{id:'u1',name:'Sam',email:'sam@coraa.ai'}}));
beforeEach(()=>{sent.length=0;invoke.mockReset();invoke.mockResolvedValue({teams:[{id:'t1',name:'Core'}],selfId:'u1'});});
afterEach(()=>{cleanup();setTeamIdentityFetchForTests(null);});

describe('RelayConnect',()=>{
 it('signed in: one button, no fields, the account name, and the offer goes to the team',async()=>{
  signedIn();const relay=handle();
  const {rerender}=render(<RelayConnect relay={relay}/>);
  const button=await screen.findByRole('button',{name:'Share my desktop'});
  expect(screen.queryByLabelText('Your name')).toBeNull();expect(screen.queryByLabelText('Host address')).toBeNull();expect(screen.queryByLabelText('Code')).toBeNull();
  fireEvent.click(button);
  await waitFor(()=>expect(relay.hostStart).toHaveBeenCalledWith('Sam','public'));
  // The relay reports it is hosting; only then is the offer posted.
  expect(sent).toEqual([]);
  rerender(<RelayConnect relay={handle({role:'host',code:'1234567',port:6679,ips:['203.0.113.9','192.168.1.20']})}/>);
  await waitFor(()=>expect(sent).toHaveLength(1));
  const ext=sent[0][3] as {card:{type:string;addr:string;code:string}};
  expect(sent[0][1]).toBeNull();
  expect(ext.card).toEqual({type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'1234567'});
  expect(screen.getByText('Sharing your desktop')).toBeInTheDocument();
 });
 it('Stop ends the offer in the team, then stops the relay',async()=>{
  signedIn();const relay=handle();
  const {rerender}=render(<RelayConnect relay={relay}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Share my desktop'}));
  await waitFor(()=>expect(relay.hostStart).toHaveBeenCalled());
  const hosting=handle({role:'host',code:'1234567',port:6679,ips:['192.168.1.20']});
  rerender(<RelayConnect relay={hosting}/>);
  await waitFor(()=>expect(sent).toHaveLength(1));
  fireEvent.click(screen.getByRole('button',{name:'Stop'}));
  await waitFor(()=>expect(hosting.hostStop).toHaveBeenCalled());
  const ext=sent[1][3] as {card:{type:string;request:string}};
  expect(ext.card).toEqual({type:'relay-offer-ended',v:1,request:'11111111-1111-4111-8111-111111111111'});
 });
 it('signed out: the manual form is tucked under Advanced',async()=>{
  setTeamIdentityFetchForTests(async()=>{throw new Error('unauthorized');});
  const relay=handle();render(<RelayConnect relay={relay}/>);
  const summary=await screen.findByText('Advanced: host or join by address');
  expect(screen.queryByRole('button',{name:'Share my desktop'})).toBeNull();
  expect(summary.closest('details')).not.toHaveAttribute('open');
  fireEvent.change(screen.getByLabelText('Your name'),{target:{value:'Sam'}});
  fireEvent.change(screen.getByLabelText('Host address'),{target:{value:'192.168.1.20:6679'}});
  fireEvent.change(screen.getByLabelText('Code'),{target:{value:'1234567'}});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Join'}));});
  expect(relay.connect).toHaveBeenCalledWith('192.168.1.20:6679','1234567','Sam');
 });
 it('picks only an address a card may carry',()=>{
  expect(offerAddress(['203.0.113.9','10.1.2.3'],6679)).toBe('10.1.2.3:6679');
  expect(offerAddress(['203.0.113.9'],6679)).toBeNull();
  expect(offerAddress(['10.1.2.3'],null)).toBeNull();
 });
});

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
 it('signed in: no share button; hosting shows Stop, which stops the relay',async()=>{
  signedIn();
  const idle=handle();
  const {rerender}=render(<RelayConnect relay={idle}/>);
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Share my desktop'})).toBeNull());
  const hosting=handle({role:'host',code:'1234567',port:6679,ips:['192.168.1.20']});
  rerender(<RelayConnect relay={hosting}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Stop'}));
  await waitFor(()=>expect(hosting.hostStop).toHaveBeenCalled());
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

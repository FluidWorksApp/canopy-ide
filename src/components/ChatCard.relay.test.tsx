import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {ChatCard,RELAY_OFFER_TTL_MS,relayOfferOpen} from './ChatCard';
import {RELAY_JOIN_EVENT,type RelayJoinDetail} from '../relayJoin';
import type {ChatMessage} from '../teamMessaging/client';

const OFFER='11111111-1111-4111-8111-111111111111',END='22222222-2222-4222-8222-222222222222';
const offer=(over:Partial<ChatMessage>={}):ChatMessage=>({id:OFFER,sender:'ana',recipient:null,text:'x',created:Date.now(),card:{type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'1234567'},...over}) as ChatMessage;
const ended=(sender='ana',request=OFFER):ChatMessage=>({id:END,sender,recipient:null,text:'x',created:Date.now(),card:{type:'relay-offer-ended',v:1,request}}) as ChatMessage;
const name=(id:string)=>id==='ana'?'Ana':'You';
afterEach(cleanup);

describe('relay offer card',()=>{
 it('shows who offered it and joins only on a click',()=>{
  const seen:RelayJoinDetail[]=[];const on=(e:Event)=>seen.push((e as CustomEvent<RelayJoinDetail>).detail);window.addEventListener(RELAY_JOIN_EVENT,on);
  const m=offer();render(<ChatCard message={m} userId="me" messages={[m]} name={name}/>);
  expect(screen.getByText('Ana is sharing their desktop')).toBeInTheDocument();
  expect(seen).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Connect'}));
  expect(seen).toEqual([{addr:'192.168.1.20:6679',code:'1234567',from:'Ana'}]);
  expect(screen.getByRole('button',{name:'Connecting…'})).toBeDisabled();
  window.removeEventListener(RELAY_JOIN_EVENT,on);
 });
 it("has no Connect on your own offer",()=>{
  const m=offer({sender:'me'});render(<ChatCard message={m} userId="me" messages={[m]} name={name}/>);
  expect(screen.getByText('You are sharing your desktop')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Connect'})).toBeNull();
 });
 it('reads as ended once its sender ends it, and not when someone else claims to',()=>{
  const m=offer();
  expect(relayOfferOpen(m,[m,ended('ana')])).toBe(false);
  expect(relayOfferOpen(m,[m,ended('mallory')])).toBe(true);
  expect(relayOfferOpen(m,[m,ended('ana','33333333-3333-4333-8333-333333333333')])).toBe(true);
  render(<ChatCard message={m} userId="me" messages={[m,ended('ana')]} name={name}/>);
  expect(screen.getByText('This offer has ended.')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Connect'})).toBeNull();
 });
 it('lapses on its own after the time limit',()=>{
  const m=offer({created:Date.now()-RELAY_OFFER_TTL_MS-1000});
  expect(relayOfferOpen(m,[m])).toBe(false);
 });
 it('a card with an address outside the local network renders nothing',()=>{
  const m=offer({card:{type:'relay-offer',v:1,addr:'8.8.8.8:6679',code:'1234567'} as ChatMessage['card']});
  const {container}=render(<ChatCard message={m} userId="me" messages={[m]} name={name}/>);
  expect(container).toBeEmptyDOMElement();
 });
});

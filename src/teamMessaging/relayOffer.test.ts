import {describe,expect,it} from 'vitest';
import {cardDraft,cardText,parseCard,validRelayAddr,validRelayCode} from './cardSchema';

const REQ='11111111-1111-4111-8111-111111111111';

describe('relay offers',()=>{
 it('accepts only local-network addresses with a port',()=>{
  for(const ok of ['192.168.1.20:6679','10.0.0.5:6679','172.16.0.1:1','172.31.255.255:65535','169.254.3.4:7000','100.64.0.9:6679','100.127.1.1:6679'])expect(validRelayAddr(ok),ok).toBe(true);
  for(const bad of ['8.8.8.8:6679','103.80.162.232:6679','127.0.0.1:6679','172.32.0.1:6679','172.15.0.1:6679','100.128.0.1:6679','192.168.1.20','192.168.1.20:0','192.168.1.20:70000','192.168.1.256:80','192.168.01.20:80','host.local:6679','https://192.168.1.20:6679','[::1]:6679','192.168.1.20:6679/x',' 192.168.1.20:6679',5,undefined])expect(validRelayAddr(bad),String(bad)).toBe(false);
 });
 it('needs a seven-digit code',()=>{
  expect(validRelayCode('1234567')).toBe(true);
  for(const bad of ['123456','12345678','abcdefg','123 4567',1234567,''])expect(validRelayCode(bad),String(bad)).toBe(false);
 });
 it('parses a good offer and drops one with anything extra or malformed',()=>{
  expect(parseCard({type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'1234567'})).toEqual({type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'1234567'});
  expect(parseCard({type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'1234567',url:'https://x'})).toBeUndefined();
  expect(parseCard({type:'relay-offer',v:1,addr:'8.8.8.8:6679',code:'1234567'})).toBeUndefined();
  expect(parseCard({type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'12'})).toBeUndefined();
  expect(parseCard({type:'relay-offer',v:2,addr:'192.168.1.20:6679',code:'1234567'})).toBeUndefined();
 });
 it('parses an end card only with a message id',()=>{
  expect(parseCard({type:'relay-offer-ended',v:1,request:REQ})).toEqual({type:'relay-offer-ended',v:1,request:REQ});
  expect(parseCard({type:'relay-offer-ended',v:1,request:'nope'})).toBeUndefined();
  expect(parseCard({type:'relay-offer-ended',v:1})).toBeUndefined();
 });
 it('falls back to plain text an older Canopy can act on by hand, with no URL',()=>{
  const text=cardText({type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'1234567'});
  expect(text).toContain('192.168.1.20:6679');
  expect(text).toContain('123 4567');
  expect(text).not.toMatch(/https?:/);
  expect(cardDraft({type:'relay-offer',v:1,addr:'192.168.1.20:6679',code:'1234567'}).ext.card.type).toBe('relay-offer');
 });
});

import { parseCard as parseRelayCard, validRelayLink as validLink } from './cardSchema';
describe('relay request and internet link', () => {
  it('accepts a bare relay-request and rejects extras', () => {
    expect(parseRelayCard({ type: 'relay-request', v: 1 })).toBeTruthy();
    expect(parseRelayCard({ type: 'relay-request', v: 1, addr: 'x' })).toBeUndefined();
  });
  it('accepts only public https names as a link', () => {
    expect(validLink('https://abc.canopy.example')).toBe(true);
    for (const bad of ['http://a.example.com', 'https://localhost', 'https://10.0.0.1', 'https://a.local', 'https://u@a.example.com', 'https://a.example.com/x'])
      expect(validLink(bad)).toBe(false);
  });
});

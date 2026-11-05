import {act,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {RECONNECT_SETTLE_MS,reportConnection,useSettledConnectionState} from './connectionState';

beforeEach(()=>{vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();});

it('hides a drop that recovers inside the settle window',()=>{
  const key='t/flap';reportConnection(key,'connected');
  const {result}=renderHook(()=>useSettledConnectionState(key));
  act(()=>reportConnection(key,'reconnecting'));
  expect(result.current.phase).toBe('connected');
  act(()=>{vi.advanceTimersByTime(1000);reportConnection(key,'connected');});
  expect(result.current.phase).toBe('connected');
  act(()=>{vi.advanceTimersByTime(RECONNECT_SETTLE_MS*2);});
  expect(result.current.phase).toBe('connected');
});

it('shows a real outage even while failed requests keep arriving',()=>{
  const key='t/outage';reportConnection(key,'connected');
  const {result}=renderHook(()=>useSettledConnectionState(key));
  act(()=>reportConnection(key,'reconnecting'));
  for(let i=0;i<4;i++)act(()=>{vi.advanceTimersByTime(900);reportConnection(key,'reconnecting');});
  expect(result.current.phase).toBe('reconnecting');
});

it('shows sign-in errors immediately',()=>{
  const key='t/auth';reportConnection(key,'connected');
  const {result}=renderHook(()=>useSettledConnectionState(key));
  act(()=>reportConnection(key,'authentication-error'));
  expect(result.current.phase).toBe('authentication-error');
});

it('does not carry one workspace\'s state onto another',()=>{
  reportConnection('t/a','connected');reportConnection('t/b','reconnecting');
  const {result,rerender}=renderHook(({k})=>useSettledConnectionState(k),{initialProps:{k:'t/a'}});
  expect(result.current.phase).toBe('connected');
  rerender({k:'t/b'});
  expect(result.current.phase).toBe('reconnecting');
});

import {describe,expect,it,vi} from 'vitest';
import {CONNECT_GRACE_MS,MODIFIER_KEYS,RETRY_MAX_MS,STALE_AFTER_MS,releaseAllKeys,releaseMouseButtons,retryDelay,wakeAction} from './desktopInput';

describe('releaseAllKeys',()=>{
  it('sends a key-up, never a key-down, for every modifier',()=>{
    const sendKey=vi.fn();releaseAllKeys({sendKey});
    expect(sendKey).toHaveBeenCalledTimes(MODIFIER_KEYS.length);
    for(const call of sendKey.mock.calls)expect(call[2]).toBe(false);
    const sent=sendKey.mock.calls.map(c=>c[1]);
    for(const code of ['ShiftLeft','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight'])expect(sent).toContain(code);
    expect(sendKey.mock.calls.map(c=>c[0])).toEqual(expect.arrayContaining([0xffe3,0xffe4,0xffe9,0xffeb,0xffec]));
  });
  it('tolerates no connection and a socket that is closing',()=>{
    expect(()=>releaseAllKeys(null)).not.toThrow();
    expect(()=>releaseAllKeys({sendKey(){throw Error('closed');}})).not.toThrow();
  });
});

describe('releaseMouseButtons',()=>{
  it('lets go of the left, middle and right buttons on the canvas',()=>{
    const root=document.createElement('div');const canvas=document.createElement('canvas');root.append(canvas);
    const seen:number[]=[];canvas.addEventListener('mouseup',e=>seen.push((e as MouseEvent).button));
    releaseMouseButtons(root);
    expect(seen).toEqual([0,1,2]);
  });
  it('does nothing before the desktop has drawn',()=>{
    expect(()=>releaseMouseButtons(document.createElement('div'))).not.toThrow();
    expect(()=>releaseMouseButtons(null)).not.toThrow();
  });
});

describe('retryDelay',()=>{
  it('starts quick and never waits longer than the cap',()=>{
    expect([0,1,2,3,4,5,50].map(retryDelay)).toEqual([500,1000,2000,4000,5000,5000,5000]);
    expect(Math.max(...[0,1,2,3,4,5,6,7,100].map(retryDelay))).toBeLessThanOrEqual(RETRY_MAX_MS);
  });
});

describe('wakeAction',()=>{
  it('leaves a live stream alone after a short absence',()=>{
    expect(wakeAction({connected:true,awayMs:0,connectingForMs:0})).toBe('keep');
    expect(wakeAction({connected:true,awayMs:STALE_AFTER_MS-1,connectingForMs:0})).toBe('keep');
  });
  it('replaces a stream that was hidden long enough to have died unnoticed',()=>{
    expect(wakeAction({connected:true,awayMs:STALE_AFTER_MS,connectingForMs:0})).toBe('reconnect');
  });
  it('does not restart a connect that is still in progress',()=>{
    expect(wakeAction({connected:false,awayMs:60_000,connectingForMs:CONNECT_GRACE_MS-1})).toBe('keep');
  });
  it('reconnects at once when disconnected, instead of waiting out the backoff',()=>{
    expect(wakeAction({connected:false,awayMs:60_000,connectingForMs:CONNECT_GRACE_MS})).toBe('reconnect');
    expect(wakeAction({connected:false,awayMs:0,connectingForMs:60_000})).toBe('reconnect');
  });
});

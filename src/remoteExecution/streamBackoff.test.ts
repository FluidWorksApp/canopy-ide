import {describe,expect,it} from 'vitest';
import {STREAM_RETRY_MAX_MS,streamRetryDelay} from './streamBackoff';

describe('streamRetryDelay',()=>{
  it('doubles from one second to the cap',()=>{
    expect([0,1,2,3,4,5,9].map(n=>streamRetryDelay(n,()=>0.5))).toEqual([1000,2000,4000,8000,16000,30000,30000]);
  });
  it('spreads terminals out by plus or minus a quarter',()=>{
    expect(streamRetryDelay(2,()=>0)).toBe(3000);
    expect(streamRetryDelay(2,()=>1)).toBe(5000);
    for(const n of [0,1,2,3,4,5,6])expect(streamRetryDelay(n)).toBeLessThanOrEqual(STREAM_RETRY_MAX_MS*1.25);
  });
});

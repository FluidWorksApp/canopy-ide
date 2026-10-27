import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({post:vi.fn(),invoke:vi.fn()}));
vi.mock('./attention',()=>({postAttention:mocks.post}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {creditStatus,statusOf,amountToRestore,creditBanner,creditExhaustedFromError,observeCredits,usd,CREDIT_POLICY} from './credits';

describe('credit thresholds mirror the control plane',()=>{
 it('maps balances to low, zero, final and paused inclusively',()=>{
  expect([5,4.99,0,-4.99,-5,-9.99,-10,-64.48].map(b=>creditStatus(b))).toEqual(['ok','low','zero','zero','final','final','paused','paused']);
 });
 it('prefers the server status and policy, and falls back for older servers',()=>{
  expect(statusOf({balanceUsd:'3',status:'ok'})).toBe('ok');
  expect(statusOf({balanceUsd:'-3',policy:{...CREDIT_POLICY,cutoffUsd:-2}})).toBe('paused');
  expect(statusOf({balance:'200'})).toBe('low');expect(statusOf(null)).toBeNull();expect(statusOf({})).toBeNull();
 });
 it('names the exact amount that restores access',()=>{
  expect(amountToRestore(-64.48)).toBe(54.49);expect(amountToRestore(-10)).toBe(0.01);expect(amountToRestore(3)).toBe(0);
  expect(creditBanner({balanceUsd:'-64.48'})).toMatchObject({tone:'error',title:'Workspaces paused'});
  expect(creditBanner({balanceUsd:'-64.48'})!.body).toContain('Add at least $54.49');
  expect(creditBanner({balanceUsd:'-6'})!.title).toBe('Final notice');expect(creditBanner({balanceUsd:'-1'})!.body).toContain('$9.00');
  expect(creditBanner({balanceUsd:'20'})).toBeNull();expect(usd(-1.5)).toBe('−$1.50');
 });
});

describe('credit refusal parsing',()=>{
 it('reads detailed errors, status-only errors and plain messages',()=>{
  expect(creditExhaustedFromError(JSON.stringify({error:'paused',code:'credit_exhausted',balanceUsd:'-12.5',cutoffUsd:'-10',status:402}))).toEqual({message:'paused',balanceUsd:-12.5,cutoffUsd:-10,shared:false});
  expect(creditExhaustedFromError(JSON.stringify({error:'Payment required',status:402}))?.balanceUsd).toBeNull();
  expect(creditExhaustedFromError('Your Canopy balance is −$64.48. Workspaces pause at −$10.00, so this workspace can’t start until credit is added.')?.cutoffUsd).toBe(-10);
  expect(creditExhaustedFromError(Error("This shared workspace is paused because its owner's Canopy balance is past the −$10.00 limit. Ask the owner to add credit."))?.shared).toBe(true);
  expect(creditExhaustedFromError(JSON.stringify({error:'Workspace not found',status:404}))).toBeNull();
  expect(creditExhaustedFromError('Cannot reach Canopy')).toBeNull();
 });
});

describe('in-app warning',()=>{
 beforeEach(()=>localStorage.clear());afterEach(()=>vi.clearAllMocks());
 it('warns once per crossing into a worse level and re-arms after recovery',()=>{
  observeCredits({balanceUsd:'10'});expect(mocks.post).not.toHaveBeenCalled();
  observeCredits({balanceUsd:'4'});observeCredits({balanceUsd:'3'});expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[0][0]).toMatchObject({kind:'fyi',tone:'warn',title:'Balance running low',source:'app'});
  observeCredits({balanceUsd:'-0.5'});expect(mocks.post).toHaveBeenCalledTimes(2);expect(mocks.post.mock.calls[1][0].title).toBe('Out of credit');
  observeCredits({balanceUsd:'2'});expect(mocks.post).toHaveBeenCalledTimes(2);
  observeCredits({balanceUsd:'50'});observeCredits({balanceUsd:'4'});expect(mocks.post).toHaveBeenCalledTimes(3);
  observeCredits({balanceUsd:'-11'});expect(mocks.post.mock.calls[3][0]).toMatchObject({tone:'error',title:'Workspaces paused'});
 });
});

describe('Add funds',()=>{
 afterEach(()=>{mocks.invoke.mockReset();vi.useRealTimers();});
 it('reads the start minimum from a refusal just above the cutoff',()=>{
  expect(creditExhaustedFromError(JSON.stringify({error:'Your Canopy balance is −$9.95. Workspaces pause at −$10.00, and starting this one needs at least −$9.90',code:'credit_exhausted',balanceUsd:'-9.95',cutoffUsd:'-10',minimumUsd:'-9.90',status:402}))).toMatchObject({balanceUsd:-9.95,minimumUsd:-9.9});
 });
 it('names Add funds in the final notice only when payments are configured',()=>{
  expect(creditBanner({balanceUsd:'-6',paymentsEnabled:true})!.body).toContain('Add funds to keep working');
  expect(creditBanner({balanceUsd:'-6'})!.body).toContain('Request more credit to keep working');
 });
 it('starts a checkout and waits until the server lists its purchase',async()=>{
  vi.useFakeTimers();
  const {startCheckout,waitForPurchase}=await import('./credits');
  mocks.invoke.mockResolvedValueOnce({url:'https://checkout.stripe.com/x',sessionId:'cs_1',amountUsd:'25.00'});
  expect(await startCheckout(25)).toMatchObject({sessionId:'cs_1'});
  expect(mocks.invoke).toHaveBeenLastCalledWith('canopy_account_request',{route:'/api/credits',body:{action:'checkout',amountUsd:'25.00'}});
  mocks.invoke.mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({balanceUsd:'1',purchases:[]}).mockResolvedValueOnce({balanceUsd:'26',purchases:[{reference:'cs_1',amount_usd:'25',occurred_at:''}]});
  const seen:string[]=[];const done=waitForPurchase('cs_1',{intervalMs:1000,onCredits:c=>seen.push(c.balanceUsd!)});
  await vi.advanceTimersByTimeAsync(3000);
  expect((await done)?.balanceUsd).toBe('26');expect(seen).toEqual(['1','26']);
  const controller=new AbortController();const stopped=waitForPurchase('cs_2',{intervalMs:1000,signal:controller.signal});controller.abort();await vi.advanceTimersByTimeAsync(1000);
  expect(await stopped).toBeNull();
 });
});

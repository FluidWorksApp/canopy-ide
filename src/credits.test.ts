import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({post:vi.fn(),invoke:vi.fn()}));
vi.mock('./attention',()=>({postAttention:mocks.post}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {canCreateWorkspace,creditFloorMessage,creditStatus,statusOf,amountToRestore,creditBanner,creditExhaustedFromError,observeCredits,usd,CREDIT_POLICY} from './credits';

describe('credit thresholds mirror the control plane',()=>{
 it('maps balances to low, zero, final and paused inclusively',()=>{
  expect([5,4.99,0.01,0,-0.01,-64.48].map(b=>creditStatus(b))).toEqual(['ok','low','low','paused','paused','paused']);
 });
 it('prefers the server status and policy, and falls back for older servers',()=>{
  expect(statusOf({balanceUsd:'3',status:'ok'})).toBe('ok');
  expect(statusOf({balanceUsd:'-3',policy:{...CREDIT_POLICY,cutoffUsd:-2}})).toBe('paused');
  expect(statusOf({balance:'200'})).toBe('low');expect(statusOf(null)).toBeNull();expect(statusOf({})).toBeNull();
 });
 it('allows creating only at the floor, using the server amount when it sends one',()=>{
  expect(canCreateWorkspace({balanceUsd:'5'})).toBe(true);expect(canCreateWorkspace({balanceUsd:'4.99'})).toBe(false);
  expect(canCreateWorkspace(null)).toBe(false);expect(canCreateWorkspace({})).toBe(false);
  expect(canCreateWorkspace({balanceUsd:'7',policy:{...CREDIT_POLICY,minimumUsd:10}})).toBe(false);
  expect(creditFloorMessage({balanceUsd:'1'})).toContain('at least $5.00');
 });
 it('names the exact amount that restores access',()=>{
  expect(amountToRestore(-64.48)).toBe(69.48);expect(amountToRestore(0)).toBe(5);expect(amountToRestore(3)).toBe(2);expect(amountToRestore(5)).toBe(0);
  expect(creditBanner({balanceUsd:'-64.48'})).toMatchObject({tone:'error',title:'Out of credit'});
  expect(creditBanner({balanceUsd:'-64.48',enforcement:'enforce'})).toMatchObject({tone:'error',title:'Workspaces deleted'});
  expect(creditBanner({balanceUsd:'-64.48'})!.body).toContain('Add at least $69.48');
  expect(creditBanner({balanceUsd:'4',status:'final'})!.title).toBe('Final notice');expect(creditBanner({balanceUsd:'4',status:'final'})!.body).toContain('$4.00');
  expect(creditBanner({balanceUsd:'20'})).toBeNull();expect(usd(-1.5)).toBe('−$1.50');
 });
});

describe('credit refusal parsing',()=>{
 it('reads detailed errors, status-only errors and plain messages',()=>{
  expect(creditExhaustedFromError(JSON.stringify({error:'paused',code:'credit_exhausted',balanceUsd:'-12.5',cutoffUsd:'0',status:402}))).toEqual({message:'paused',balanceUsd:-12.5,cutoffUsd:0,shared:false});
  expect(creditExhaustedFromError(JSON.stringify({error:'Payment required',status:402}))?.balanceUsd).toBeNull();
  expect(creditExhaustedFromError('Your Canopy balance is −$64.48. Workspaces pause at $0.00, so this workspace can’t start until credit is added.')?.cutoffUsd).toBe(0);
  expect(creditExhaustedFromError(Error("This shared workspace is paused because its owner's Canopy balance is past the $0.00 limit. Ask the owner to add credit."))?.shared).toBe(true);
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
  observeCredits({balanceUsd:'1',status:'final'});expect(mocks.post).toHaveBeenCalledTimes(2);expect(mocks.post.mock.calls[1][0].title).toBe('Final notice');
  observeCredits({balanceUsd:'2'});expect(mocks.post).toHaveBeenCalledTimes(2);
  observeCredits({balanceUsd:'50'});observeCredits({balanceUsd:'4'});expect(mocks.post).toHaveBeenCalledTimes(3);
  observeCredits({balanceUsd:'-1',enforcement:'enforce'});expect(mocks.post.mock.calls[3][0]).toMatchObject({tone:'error',title:'Workspaces deleted'});
 });
});

describe('Add funds',()=>{
 afterEach(()=>{mocks.invoke.mockReset();vi.useRealTimers();});
 it('reads the start minimum from a refusal just above the cutoff',()=>{
  expect(creditExhaustedFromError(JSON.stringify({error:'Your Canopy balance is $0.05. Workspaces pause at $0.00, and starting this one needs at least $0.10',code:'credit_exhausted',balanceUsd:'0.05',cutoffUsd:'0',minimumUsd:'0.10',status:402}))).toMatchObject({balanceUsd:0.05,minimumUsd:0.1});
 });
 it('names Add funds in the final notice only when payments are configured',()=>{
  expect(creditBanner({balanceUsd:'4',status:'final',paymentsEnabled:true})!.body).toContain('Add funds to keep them');
  expect(creditBanner({balanceUsd:'4',status:'final'})!.body).toContain('Request more credit to keep them');
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

import {afterEach,expect,it,vi} from 'vitest';
import {startBackgroundTeams} from './background';
afterEach(()=>vi.useRealTimers());
it('receives by default without a conversation tab and reconciles removed teams',async()=>{
 vi.useFakeTimers();
 const stopA=vi.fn(),stopB=vi.fn(),retain=vi.fn((team:string)=>team==='a'?stopA:stopB);
 const request=vi.fn().mockResolvedValueOnce({selfId:'alice',teams:[{id:'a'},{id:'b'}]}).mockResolvedValue({selfId:'alice',teams:[{id:'b'}]});
 const dispose=startBackgroundTeams({request,retain});
 await vi.advanceTimersByTimeAsync(0);
 expect(retain.mock.calls).toEqual([['a','alice'],['b','alice']]);
 await vi.advanceTimersByTimeAsync(15000);
 expect(stopA).toHaveBeenCalledOnce();expect(retain).toHaveBeenCalledTimes(3);
 dispose();expect(stopB).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(30000);expect(request).toHaveBeenCalledTimes(2);
});
it('rejects late old-account directories after account change',async()=>{
 vi.useFakeTimers();
 let old!:(value:any)=>void;
 const request=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>old=resolve)).mockResolvedValue({selfId:'bob',teams:[{id:'b'}]});
 const release=vi.fn(),retain=vi.fn(()=>release);
 const dispose=startBackgroundTeams({request,retain});
 window.dispatchEvent(new Event('canopy:account-changed'));
 await vi.advanceTimersByTimeAsync(0);
 old({selfId:'alice',teams:[{id:'private'}]});
 await vi.advanceTimersByTimeAsync(0);
 expect(retain.mock.calls).toEqual([['b','bob']]);
 dispose();
});
it('releases background access on failure and retries without overlapping requests',async()=>{
 vi.useFakeTimers();
 const release=vi.fn(),retain=vi.fn(()=>release);
 const request=vi.fn().mockResolvedValueOnce({selfId:'alice',teams:[{id:'a'}]}).mockRejectedValue(Error('Signed out'));
 const dispose=startBackgroundTeams({request,retain});
 await vi.advanceTimersByTimeAsync(15000);
 expect(release).toHaveBeenCalledOnce();dispose();
});

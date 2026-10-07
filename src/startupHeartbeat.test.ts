import {afterEach,expect,it,vi} from 'vitest';
import {createStartupHeartbeat} from './startupHeartbeat';
afterEach(()=>vi.useRealTimers());
it('acknowledges the real native generation while remote startup is unavailable',async()=>{
 vi.useFakeTimers();let generation=3;
 const native=vi.fn(async(command:string)=>command==='watchdog_generation'?generation:undefined);
 const stop=createStartupHeartbeat(native as never);
 await vi.advanceTimersByTimeAsync(0);
 expect(native).toHaveBeenCalledWith('watchdog_ack',{generation:3});
 generation=4;await vi.advanceTimersByTimeAsync(3000);
 expect(native).toHaveBeenCalledWith('watchdog_ack',{generation:4});stop();
});
it('keeps one in-flight request and never acknowledges a result after shutdown',async()=>{
 vi.useFakeTimers();let resolve!:(value:number)=>void;
 const native=vi.fn(()=>new Promise<number>(r=>{resolve=r;}));const stop=createStartupHeartbeat(native as never);
 await vi.advanceTimersByTimeAsync(20000);expect(native).toHaveBeenCalledTimes(1);
 stop();resolve(7);await vi.advanceTimersByTimeAsync(10000);expect(native).toHaveBeenCalledTimes(1);
});
it('retries native unavailability without unmounting recovery or accepting invalid generations',async()=>{
 vi.useFakeTimers();const native=vi.fn().mockRejectedValueOnce(Error('native offline')).mockResolvedValueOnce(-1).mockResolvedValueOnce(5).mockResolvedValue(undefined);
 const stop=createStartupHeartbeat(native as never);await vi.advanceTimersByTimeAsync(6000);
 expect(native).toHaveBeenCalledWith('watchdog_ack',{generation:5});expect(native).not.toHaveBeenCalledWith('watchdog_ack',{generation:-1});stop();
});

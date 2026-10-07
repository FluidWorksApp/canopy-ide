import {invoke} from '@tauri-apps/api/core';

type NativeInvoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
let stop:undefined|(()=>void);

/** Recovery UI is a live renderer even when its remote connection is offline.
 * Read the native atomic generation; never invent a PTY registration generation.
 * Acknowledgements retain the native generation fence against stale replies. */
export function createStartupHeartbeat(native:NativeInvoke=invoke){
 let stopped=false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const tick=async()=>{
  try{
   const generation=await native<number>('watchdog_generation');
   if(stopped||!Number.isSafeInteger(generation)||generation<0)return;
   await native('watchdog_ack',{generation});
  }catch{/* Startup recovery remains visible if native dispatch is unavailable. */}
  finally{if(!stopped)timer=setTimeout(()=>void tick(),3000);}
 };
 void tick();
 return ()=>{stopped=true;if(timer)clearTimeout(timer);};
}
export function startStartupHeartbeat(){stop??=createStartupHeartbeat();}
export function stopStartupHeartbeat(){stop?.();stop=undefined;}

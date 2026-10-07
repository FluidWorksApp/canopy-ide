import {pullWorkspaceImage} from './image-release.mjs';
// Download the current workspace release in the background, so the next
// container start finds it on the retained disk instead of pulling ~13 GB
// while the user waits. pullWorkspaceImage only downloads on a cache miss.
export const PREPULL_FIRST_DELAY_MS=2*60*1000;
export const PREPULL_INTERVAL_MS=30*60*1000;
export function startReleasePrepull({workspace,release,docker,firstDelayMs=PREPULL_FIRST_DELAY_MS,intervalMs=PREPULL_INTERVAL_MS,onResult=()=>{},timers={setTimeout,setInterval,clearTimeout,clearInterval}}){
 if(!workspace||typeof release!=='function'||typeof docker!=='function')return {stop(){},tick:async()=>null};
 let running=null,stopped=false;
 const tick=()=>{
  if(stopped)return Promise.resolve(undefined);if(running)return running;
  running=(async()=>{
   try{const reference=await release(workspace);const result=await pullWorkspaceImage(reference,{docker});onResult({ok:true,reference:result.reference});return result;}
   catch(error){onResult({ok:false,error:error instanceof Error?error.message:String(error)});return null;}
   finally{running=null;}
  })();
  return running;
 };
 const first=timers.setTimeout(()=>void tick(),firstDelayMs);first?.unref?.();
 const every=timers.setInterval(()=>void tick(),intervalMs);every?.unref?.();
 return {tick,stop(){stopped=true;timers.clearTimeout(first);timers.clearInterval(every);}};
}

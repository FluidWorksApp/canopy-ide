import {pullWorkspaceImage} from './image-release.mjs';
// Download the current workspace release in the background, so the next
// container start finds it on the retained disk instead of pulling ~13 GB
// while the user waits. pullWorkspaceImage only downloads on a cache miss.
export const PREPULL_FIRST_DELAY_MS=2*60*1000;
export const PREPULL_INTERVAL_MS=30*60*1000;
// The pre-pull obeys the same free-space preflight as a resume (with a reserve
// left for the user's files), so it can never fill the retained disk:
// `space(reference)` returns pullWorkspaceImage's space options. `target`
// records the reference so other cleanups keep it; `retain(result)` then
// removes everything except what containers use and this one target.
export function startReleasePrepull({workspace,release,docker,space=()=>undefined,target=()=>{},retain=async()=>{},firstDelayMs=PREPULL_FIRST_DELAY_MS,intervalMs=PREPULL_INTERVAL_MS,onResult=()=>{},timers={setTimeout,setInterval,clearTimeout,clearInterval}}){
 if(!workspace||typeof release!=='function'||typeof docker!=='function')return {stop(){},tick:async()=>null};
 let running=null,stopped=false;
 const tick=()=>{
  if(stopped)return Promise.resolve(undefined);if(running)return running;
  running=(async()=>{
   try{
    const reference=await release(workspace);target(reference);
    const result=await pullWorkspaceImage(reference,{docker,space:space(reference)});target(result.reference);
    try{await retain(result);}catch(error){onResult({ok:false,error:`Workspace image cleanup skipped: ${error instanceof Error?error.message:String(error)}`});}
    onResult({ok:true,reference:result.reference});return result;
   }
   catch(error){onResult({ok:false,error:error instanceof Error?error.message:String(error),...(error?.code==='WORKSPACE_DISK_FULL'?{code:error.code}:{})});return null;}
   finally{running=null;}
  })();
  return running;
 };
 const first=timers.setTimeout(()=>void tick(),firstDelayMs);first?.unref?.();
 const every=timers.setInterval(()=>void tick(),intervalMs);every?.unref?.();
 return {tick,stop(){stopped=true;timers.clearTimeout(first);timers.clearInterval(every);}};
}

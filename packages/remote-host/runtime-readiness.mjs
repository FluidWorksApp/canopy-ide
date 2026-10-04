// Operational liveness only. User-runtime replies never authorize management or billing.
export async function runtimeReady(runtime,{fetchImpl=fetch,timeoutMs=2000}={}){
 try{
  const response=await fetchImpl(`${runtime.url}/sessions`,{headers:{authorization:`Bearer ${runtime.token}`},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok||!response.body)return false;
  const reader=response.body.getReader(),chunks=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();return false;}chunks.push(Buffer.from(value));}
  const sessions=JSON.parse(Buffer.concat(chunks).toString());
  return Array.isArray(sessions)&&sessions.length<=256&&sessions.every(s=>s&&Number.isSafeInteger(s.id)&&s.id>0&&(s.exitCode===null||Number.isSafeInteger(s.exitCode)));
 }catch{return false;}
}

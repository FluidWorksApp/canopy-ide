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

// A new image can take time to start its service. Use the same bounded wait in
// production and the real-engine smoke test, rather than a test-only retry loop.
export async function waitForRuntimeReady(runtime,{timeoutMs=30000,intervalMs=250,fetchImpl=fetch}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isInteger(intervalMs)||intervalMs<1||intervalMs>1000)throw Error('Invalid readiness deadline');
 const deadline=performance.now()+timeoutMs;
 while(performance.now()<deadline){
  const remaining=Math.max(1,Math.ceil(deadline-performance.now()));
  if(await runtimeReady(runtime,{fetchImpl,timeoutMs:Math.min(2000,remaining)}))return true;
  const pause=Math.min(intervalMs,Math.max(0,deadline-performance.now()));
  if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
 }
 return false;
}

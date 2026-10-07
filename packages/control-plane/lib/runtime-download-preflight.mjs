import {createHash} from 'node:crypto';
const limit=32*1024*1024;
const failures=new WeakMap();
function fail(reason,permanent=true){const error=new Error('Runtime download verification failed');failures.set(error,{reason,permanent});throw error;}
export const runtimeDownloadFailure=error=>failures.get(error)??null;
/** Verify the actual presigned GET path with bounded streamed bytes. Never
 * return a signed URL, response body, provider message, or credential in errors.
 * A mutable key race remains safe: the VM verifies the same required digest. */
export async function verifyRuntimeDownload(url,sha,{fetcher=fetch,expectedLength,timeoutMs=10000}={}){
 let response;
 try{response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch{fail('connection',false);}
 if(response.status===403||response.status===401)fail('access-denied');
 if(response.status===404)fail('missing');
 if(!response.ok)fail('connection',false);
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)<1||Number(length)>limit))fail('size');
 if(!response.body||!Number.isSafeInteger(expectedLength)||expectedLength<1||expectedLength>limit)fail('size');
 const reader=response.body.getReader(),hash=createHash('sha256');let bytes=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit||bytes>expectedLength)fail('size');hash.update(value);}
 }catch(error){if(runtimeDownloadFailure(error))throw error;fail('connection',false);}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(bytes!==expectedLength)fail('size');
 if(hash.digest('hex')!==sha)fail('checksum');
 return {bytes,verified:true};
}

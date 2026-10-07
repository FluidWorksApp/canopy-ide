import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {verifyRuntimeDownload,runtimeDownloadFailure} from './runtime-download-preflight.mjs';
const bytes=Buffer.from('Synthetic management archive'),sha=createHash('sha256').update(bytes).digest('hex');
test('streams actual GET and verifies exact bounded archive digest without redirects',async()=>{
 let options;const result=await verifyRuntimeDownload('https://synthetic.invalid/signed-secret',sha,{expectedLength:bytes.length,fetcher:async(_url,input)=>{options=input;return new Response(bytes);}});assert.deepEqual(result,{bytes:bytes.length,verified:true});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
});
test('actual GET denial/missing/hash/size failures are permanent and never expose response secrets',async()=>{
 for(const [response,reason]of [[new Response('SECRET',{status:403}),'access-denied'],[new Response('SECRET',{status:404}),'missing'],[new Response(Buffer.from('x'.repeat(bytes.length))),'checksum'],[new Response(bytes,{headers:{'content-length':'33554433'}}),'size'],[new Response(Buffer.from('short')),'size']])await assert.rejects(verifyRuntimeDownload('https://synthetic.invalid/signed-secret',sha,{expectedLength:bytes.length,fetcher:async()=>response}),error=>{assert.deepEqual(runtimeDownloadFailure(error),{reason,permanent:true});assert.doesNotMatch(error.message,/SECRET|signed-secret|https:/);return true;});
});
test('network and service errors remain transient while a body crossing the declared limit is cancelled',async()=>{
 for(const fetcher of [async()=>{throw Error('SECRET');},async()=>new Response('SECRET',{status:503})])await assert.rejects(verifyRuntimeDownload('https://synthetic.invalid',sha,{expectedLength:bytes.length,fetcher}),error=>{assert.deepEqual(runtimeDownloadFailure(error),{reason:'connection',permanent:false});return true;});
 let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(bytes.length+1));},cancel(){cancelled=true;}});
 await assert.rejects(verifyRuntimeDownload('https://synthetic.invalid',sha,{expectedLength:bytes.length,fetcher:async()=>new Response(body)}),error=>runtimeDownloadFailure(error)?.reason==='size');assert.equal(cancelled,true);
 assert.equal(runtimeDownloadFailure({reason:'access-denied',permanent:true}),null);
});
test('an actual body-read abort remains bounded and fails transiently without exposing its error',async()=>{
 const keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(verifyRuntimeDownload('https://synthetic.invalid',sha,{expectedLength:bytes.length,timeoutMs:15,fetcher:async(_url,{signal})=>new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(Error('SECRET abort detail')),{once:true});}}))}),error=>{assert.deepEqual(runtimeDownloadFailure(error),{reason:'connection',permanent:false});assert.doesNotMatch(error.message,/SECRET/);return true;});}finally{clearTimeout(keepAlive);}
});

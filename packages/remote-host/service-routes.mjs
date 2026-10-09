import {ServiceAdminError} from './service-admin.mjs';
// IDE -> gateway -> canopy-serviced harness routes. The gateway authorizes the
// user and names the actor; the service owns every store and its policy.
const NAME=/^[a-z][a-z0-9_-]{0,31}$/;
export const HARNESS_ACTIONS=new Set(['answer','attention_ack','notes_write','research_write']);
const plainObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function harnessQuery(admin,workspaceId,input){
 if(!plainObject(input)||Object.keys(input).some(k=>!['store','action','args'].includes(k))||!NAME.test(input.store??'')||!NAME.test(input.action??'')||input.args!==undefined&&!plainObject(input.args))throw Error('Invalid harness query');
 return admin.query(workspaceId,{store:input.store,action:input.action,args:input.args??{}});
}
export function harnessAction(admin,workspaceId,input,actor){
 if(!plainObject(input)||!HARNESS_ACTIONS.has(input.kind))throw Error('Invalid harness action');
 if(typeof actor!=='string'||!actor||actor.length>300)throw Error('Forbidden');
 // The acting user comes from the gateway's authentication, never the body.
 const {actor:_ignored,...rest}=input;
 return admin.action(workspaceId,{...rest,actor});
}
/** Map a service failure onto the IDE response; null = not a service error. */
export function harnessFailure(error){
 if(!(error instanceof ServiceAdminError))return null;
 if(error.code==='rejected'&&error.status>=400&&error.status<500)return {status:error.status,body:plainObject(error.body)?error.body:{error:error.message}};
 if(error.code==='rejected'&&error.status===503&&plainObject(error.body))return {status:503,body:error.body};
 return {status:503,body:{error:'unavailable',reason:error.code==='timeout'?'timeout':'unavailable',message:error.message}};
}
/** SSE passthrough. Ends the response when the service stream ends, the client
 *  goes, the client cannot keep up, or stillAuthorized() turns false. */
export async function pipeHarnessStream({admin,workspaceId,cursor,response,stillAuthorized,onClose=()=>{},checkMs=1000,maxBuffered=4*1024*1024}){
 const abort=new AbortController();let upstream,closed=false,timer;
 const close=()=>{if(closed)return;closed=true;clearInterval(timer);abort.abort();upstream?.destroy();if(!response.writableEnded)response.end();onClose();};
 response.once('close',close);
 try{upstream=await admin.openStream(workspaceId,cursor||null,{signal:abort.signal});}
 catch(error){
  response.removeListener('close',close);onClose();closed=true;
  const failure=harnessFailure(error)??{status:400,body:{error:error.message}};
  if(!response.headersSent){response.writeHead(failure.status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(failure.body));}
  return;
 }
 if(closed){upstream.destroy();return;}
 response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no',connection:'keep-alive'});
 response.flushHeaders?.();
 timer=setInterval(async()=>{if(closed)return;if(!await stillAuthorized())close();},checkMs);timer.unref?.();
 upstream.on('data',chunk=>{
  if(closed)return;
  // A subscriber this far behind gets cut; it reconnects and resnapshots.
  if(response.writableLength>maxBuffered)return close();
  if(!response.write(chunk)){upstream.pause();response.once('drain',()=>upstream.resume());}
 });
 upstream.once('end',close);upstream.once('error',close);upstream.once('close',close);
}

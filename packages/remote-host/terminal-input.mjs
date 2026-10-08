// Terminal input over the session's stream socket.
//
// Version 1: the gateway announces {t:'hello',input:1} on a terminal stream
// whose viewer may type (input:0 otherwise). The client then sends ordered
// {t:'input',id,seq,data} frames and receives {t:'input-ack',id,seq} or
// {t:'input-error',id,seq,error}. `id` names one client input queue and `seq`
// counts its batches from 1, so a batch resent after a reconnect (on the new
// socket or the HTTP fallback, which accepts the same id/seq) is applied once.
export const TERMINAL_INPUT_PROTOCOL=1;
export const BINARY_TERMINAL_INPUT_PROTOCOL=2;
export function decodeTerminalInput(data,encoding){
 if(typeof data!=='string'||Buffer.byteLength(data)>INPUT_MAX_BYTES)throw Error('Invalid session input');
 if(encoding===undefined)return data;
 if(encoding!=='latin1'||[...data].some(value=>value.charCodeAt(0)>255))throw Error('Invalid binary terminal input');
 return Buffer.from(data,'latin1');
}
export const INPUT_MAX_BYTES=16384;
const INPUT_ID=/^[A-Za-z0-9-]{8,64}$/;

/** Validates one sequenced input batch from either transport. */
export function sequencedInput(value,{allowType=false}={}){
 const keys=allowType?['t','id','seq','data','encoding']:['id','seq','data','encoding'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('Invalid session input');
 if(allowType&&value.t!=='input')throw Error('Invalid session input');
 if(typeof value.id!=='string'||!INPUT_ID.test(value.id)||!Number.isSafeInteger(value.seq)||value.seq<1||typeof value.data!=='string'||Buffer.byteLength(value.data)>INPUT_MAX_BYTES)throw Error('Invalid session input');
 decodeTerminalInput(value.data,value.encoding);
 return {id:value.id,seq:value.seq,data:value.data,...(value.encoding?{encoding:value.encoding}:{})};
}

/** Per input queue: the last applied batch and a serial apply chain, shared by
 * the socket and HTTP paths so a resend racing its original applies once. */
export class InputLedger{
 constructor({max=4096,idleMs=10*60_000,now=Date.now}={}){Object.assign(this,{max,idleMs,now});this.entries=new Map();}
 apply(key,seq,write){
  const time=this.now();
  let entry=this.entries.get(key);
  if(entry)this.entries.delete(key);
  else{
   // Least recently used first: drop expired queues, and idle ones while full.
   for(const [old,value] of this.entries){if(this.entries.size<this.max&&time-value.touched<this.idleMs)break;if(!value.busy)this.entries.delete(old);}
   if(this.entries.size>=this.max)return Promise.reject(Error('Terminal input capacity reached'));
   // An unknown queue (new, or forgotten after idling) starts where it is.
   entry={last:seq-1,tail:Promise.resolve(),busy:0,touched:time};
  }
  entry.touched=time;entry.busy++;this.entries.set(key,entry);
  const result=entry.tail.then(async()=>{
   try{
    if(seq<=entry.last)return {duplicate:true};
    if(seq!==entry.last+1)throw Error('Terminal input out of order');
    await write();entry.last=seq;return {duplicate:false};
   }finally{entry.busy--;}
  });
  entry.tail=result.catch(()=>{});
  return result;
 }
}

/** Token bucket; `wait(cost)` resolves once the cost fits, without dropping. */
export class RateLimit{
 constructor({rate,burst,now=Date.now}){Object.assign(this,{rate,burst,now});this.tokens=burst;this.at=now();}
 delay(cost){
  const time=this.now();this.tokens=Math.min(this.burst,this.tokens+(time-this.at)*this.rate/1000);this.at=time;
  this.tokens-=Math.min(cost,this.burst);
  return this.tokens>=0?0:Math.ceil(-this.tokens*1000/this.rate);
 }
 async wait(cost){const ms=this.delay(cost);if(ms)await new Promise(resolve=>setTimeout(resolve,ms));}
}

export const inputKey=(principal,workspaceId,target,id)=>JSON.stringify([principal.memberId?`member:${principal.memberId}`:`principal:${principal.id}`,workspaceId,target,id]);

/** One write into the runner's PTY; same route and limits as HTTP input. */
export async function forwardInput(runtime,sessionId,data,{fetchImpl=fetch,encoding}={}){
 const result=await fetchImpl(`${runtime.url}/sessions/${sessionId}/${encoding==='latin1'?'input-binary':'input'}`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${runtime.token}`,'content-type':'application/json'},body:JSON.stringify({data}),signal:AbortSignal.timeout(5000)});
 if(result.ok){await result.body?.cancel();return;}
 let error='Terminal input failed';try{const value=await result.json();if(value?.error==='Session not running')error=value.error;}catch{}
 throw Error(error);
}

/** Socket side of one terminal stream: validation, bounds, pacing, ordering. */
export class SocketInput{
 constructor({key,apply,allowed,send,close,allowBinary=()=>false,maxPendingBytes=128*1024,rate=new RateLimit({rate:64*1024,burst:128*1024}),frames=new RateLimit({rate:200,burst:400})}){
  Object.assign(this,{key,apply,allowed,send,close,allowBinary,maxPendingBytes,rate,frames});
  this.ids=new Set();this.pendingBytes=0;this.tail=Promise.resolve();this.closed=false;
 }
 receive(raw,binary){
  if(this.closed)return;
  if(binary||raw.length>INPUT_MAX_BYTES*6+256)return this.reject(1008,'Invalid terminal input');
  let input;try{input=sequencedInput(JSON.parse(raw.toString()),{allowType:true});}catch{return this.reject(1008,'Invalid terminal input');}
  // A client starts a new queue identity only after a failure; bound them.
  if(!this.ids.has(input.id)){if(this.ids.size>=64)return this.reject(1008,'Too many terminal input queues');this.ids.add(input.id);}
  const size=Buffer.byteLength(input.data);
  if(this.pendingBytes+size>this.maxPendingBytes)return this.reject(1013,'Terminal input backlog');
  this.pendingBytes+=size;
  this.tail=this.tail.then(async()=>{
   await this.frames.wait(1);await this.rate.wait(size);
   try{
    if(input.encoding&&!this.allowBinary())throw Error('Terminal input requires an updated workspace runtime');
    const denied=await this.allowed();if(denied)throw Error(denied);
    await this.apply(this.key(input.id),input.seq,input.data,input.encoding);
    this.send({t:'input-ack',id:input.id,seq:input.seq});
   }catch(error){this.send({t:'input-error',id:input.id,seq:input.seq,error:error.message==='Session not running'||/^(Forbidden|Workspace|Sharing|Terminal input)/.test(error.message)?error.message:'Terminal input failed'});}
   finally{this.pendingBytes-=size;}
  });
 }
 reject(code,reason){this.closed=true;this.close(code,reason);}
}

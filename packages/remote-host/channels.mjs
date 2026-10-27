// Streaming answers for commands the desktop gives a Tauri Channel (LSP
// output, structured runner lines, MCP progress). /native is request/response,
// so the desktop names each channel ({__canopyChannel:id}); the command gets a
// sender here and the desktop drains it with channel_poll. A channel nobody
// drains is closed rather than allowed to grow without bound.
const ID=/^[a-f0-9-]{36}$/;
export const isChannelArg=value=>!!value&&typeof value==='object'&&typeof value.__canopyChannel==='string';
export class ChannelHub{
 constructor({maxBytes=8*1024*1024,idleMs=300000,now=()=>Date.now()}={}){this.channels=new Map();this.maxBytes=maxBytes;this.idleMs=idleMs;this.now=now;}
 open(id){
  if(!ID.test(id))throw Error('Invalid channel');if(this.channels.has(id))throw Error('Channel already open');this.sweep();
  const channel={queue:[],bytes:0,closed:false,error:null,polled:this.now(),wake:new Set(),onClose:new Set()};this.channels.set(id,channel);
  const wake=()=>{for(const fn of channel.wake)fn();channel.wake.clear();};
  const close=(error=null)=>{if(channel.closed)return;channel.closed=true;channel.error=error;wake();for(const fn of channel.onClose)try{fn();}catch{}};
  return {id,
   send:message=>{if(channel.closed)return false;const size=Buffer.byteLength(JSON.stringify(message??null));if(channel.bytes+size>this.maxBytes){close('The desktop stopped reading this stream');return false;}channel.queue.push(message);channel.bytes+=size;wake();return true;},
   close,get closed(){return channel.closed;},onClose:fn=>{channel.onClose.add(fn);}};
 }
 /** Close the named channels on the desktop's request (its listener went away). */
 drop(ids){for(const id of ids??[]){const channel=this.channels.get(id);if(!channel)continue;this.channels.delete(id);channel.closed=true;for(const fn of channel.wake)fn();for(const fn of channel.onClose)try{fn();}catch{}}}
 async poll(ids,wait=0){
  if(!Array.isArray(ids)||ids.length>64||ids.some(id=>typeof id!=='string'))throw Error('Invalid channel list');
  const known=ids.map(id=>[id,this.channels.get(id)]);const ready=()=>known.some(([,c])=>!c||c.queue.length||c.closed);
  if(!ready()&&wait>0)await new Promise(resolve=>{const timer=setTimeout(done,Math.min(Number(wait)||0,5000));function done(){clearTimeout(timer);for(const [,c] of known)c?.wake.delete(done);resolve();}for(const [,c] of known)c?.wake.add(done);});
  const out={};
  for(const [id,channel] of known){
   if(!channel){out[id]={messages:[],closed:true,error:null};continue;}
   channel.polled=this.now();const messages=channel.queue.splice(0);channel.bytes=0;
   out[id]={messages,closed:channel.closed,error:channel.error};if(channel.closed)this.channels.delete(id);
  }
  return out;
 }
 sweep(){const now=this.now();for(const [id,channel] of this.channels)if(now-channel.polled>this.idleMs)this.drop([id]);}
}

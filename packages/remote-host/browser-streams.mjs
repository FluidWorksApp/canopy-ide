import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';
export function workspacePreviewUrl(value){const url=new URL(value);if(typeof value!=='string'||value.length>8192||!['http:','https:'].includes(url.protocol)||url.username||url.password||!(['localhost','127.0.0.1','0.0.0.0','[::1]'].includes(url.hostname)||url.hostname.endsWith('.localhost')))throw Error('Use a workspace localhost HTTP or HTTPS preview URL');return url.href;}
function localBridgeUrl(value){const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash||url.search||!/^\/[a-f0-9]{64}\/$/.test(url.pathname)||Number(url.port)<1025||[8080,8081,8787].includes(Number(url.port)))throw Error('Invalid private browser bridge');return url.href;}
export class BrowserStreams{
 constructor({home='/home/agent',spawnImpl=spawn,WebSocketImpl=WebSocket,script=fileURLToPath(new URL('./chrome-stream/server.mjs',import.meta.url)),maxSessions=4}={}){Object.assign(this,{home,spawnImpl,WebSocketImpl,script,maxSessions});this.entries=new Map();this.requests=new Map();this.closingProfiles=new Map();this.openingProfiles=new Set();}
 async open({sessionId,url,profileId=sessionId}){
  if(typeof sessionId!=='string'||!/^[\w:-]{1,160}$/.test(sessionId))throw Error('Invalid preview session');if(typeof profileId!=='string'||!/^[\w:-]{1,160}$/.test(profileId))throw Error('Invalid preview profile');const profileKey=createHash('sha256').update(profileId).digest('hex');const target=workspacePreviewUrl(url),old=this.requests.get(sessionId);if(old){if(old.url!==target)throw Error('Preview session URL changed');return old.promise;}
  if(this.requests.size>=this.maxSessions)throw Error('Close a workspace preview before opening another');
  const promise=this.launch(sessionId,target,profileKey);this.requests.set(sessionId,{url:target,promise});try{return await promise;}catch(e){this.requests.delete(sessionId);throw e;}
 }
 async launch(sessionId,url,profileKey){
  if(this.openingProfiles.has(profileKey))throw Error("Preview profile is already opening");this.openingProfiles.add(profileKey);try{
  await this.closingProfiles.get(profileKey);
  if([...this.entries.values()].some(e=>e.profileKey===profileKey))throw Error("Preview profile is already open");
  const id=randomUUID(),profileDirectory=join(this.home,'.canopy','browser-profiles',profileKey);await mkdir(profileDirectory,{recursive:true,mode:0o700});
  const child=this.spawnImpl(process.execPath,[this.script],{stdio:['pipe','pipe','ignore'],env:{...process.env,HOME:this.home}});const entry={id,sessionId,child,profileKey,profileDirectory,sockets:new Set()};this.entries.set(id,entry);
  child.stdin.write(JSON.stringify({url,workspace:true,profileDirectory})+'\n');
  try{entry.viewer=await new Promise((resolve,reject)=>{let output='';const finish=(error,value)=>{clearTimeout(timer);child.stdout.off('data',data);child.off('error',failed);child.off('exit',exited);error?reject(error):resolve(value);};const failed=()=>finish(Error('Workspace browser failed to start')),exited=()=>finish(Error('Workspace browser stopped')),data=chunk=>{output+=chunk.toString();if(output.length>4096)return failed();const end=output.indexOf('\n');if(end<0)return;try{finish(null,localBridgeUrl(JSON.parse(output.slice(0,end)).url));}catch{failed();}};const timer=setTimeout(()=>finish(Error('Workspace browser startup timed out')),10000);child.stdout.on('data',data);child.once('error',failed);child.once('exit',exited);});}catch(error){this.close(id);throw error;}
  child.once('exit',()=>{if(this.entries.get(id)===entry){this.entries.delete(id);this.requests.delete(sessionId);}for(const socket of entry.sockets)socket.close(1011,'Workspace browser stopped');});return {id};
  }finally{this.openingProfiles.delete(profileKey);}
 }
 attach(id,client){const entry=this.entries.get(id);if(!entry?.viewer)throw Error('Unknown workspace browser');const target=new URL(entry.viewer),upstream=new this.WebSocketImpl(entry.viewer.replace('http:','ws:')+'socket',{origin:target.origin,maxPayload:8*1024*1024,perMessageDeflate:false,handshakeTimeout:10000});entry.sockets.add(client);
  client.on('message',(data,binary)=>{if(binary||upstream.readyState!==1||data.length>256000)return;if(upstream.bufferedAmount>1048576)return client.close(1013,'Browser input queue full');upstream.send(data);});upstream.on('message',(data,binary)=>{if(client.readyState!==1)return;if(client.bufferedAmount>4*1024*1024)return client.close(1013,'Slow browser viewer');client.send(data,{binary});});client.once('close',()=>{entry.sockets.delete(client);upstream.close();});upstream.once('close',()=>client.close());upstream.on('error',()=>client.close(1011,'Workspace browser unavailable'));client.on('error',()=>upstream.close());
 }
 close(id){const entry=this.entries.get(id);if(!entry)return;this.entries.delete(id);this.requests.delete(entry.sessionId);for(const socket of entry.sockets)socket.close(1001,'Preview closed');
  let resolve;const stopped=new Promise(r=>resolve=r);this.closingProfiles.set(entry.profileKey,stopped);
  const timer=setTimeout(()=>entry.child.kill('SIGKILL'),3000);timer.unref();entry.child.once('exit',()=>{clearTimeout(timer);if(this.closingProfiles.get(entry.profileKey)===stopped)this.closingProfiles.delete(entry.profileKey);resolve();});entry.child.stdin.end();return stopped;
 }
 dispose(){for(const id of this.entries.keys())this.close(id);}
}

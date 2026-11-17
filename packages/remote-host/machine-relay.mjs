// The machine relay: how an agent running on this machine asks the Canopy
// window to do something across the person's machines.
//
// The machine tools (run, sync, copy, workflows) are carried out by the window,
// because it is the one place connected to every machine. On the desktop an
// agent reaches the window through the app's own bridge. Here there is no app:
// the window is somewhere else, connected to this host. So the agent's sidecar
// (`canopy-hook --mcp`) posts the op to a socket in this runner, the op waits
// in a queue, and the window collects it over the connection it already has
// (`machine_relay_poll`) and posts the answer back (`machine_relay_result`).
//
// It carries machine ops and nothing else, under its own variables
// (CANOPY_RELAY_*). The desktop bridge's (CANOPY_CTX_*) are deliberately not
// used: they would make every hook and tool treat this as a full bridge, which
// it is not, and on a cloud workspace they already name the Canopy service.
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {chmod,lstat,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const POLL_MAX_MS=10_000;
/** A window that has not asked for this long is treated as gone. */
const WINDOW_FRESH_MS=45_000;
const MAX_QUEUED=32, MAX_BODY=256*1024;
const KINDS=new Set(['list','run','sync','copy','workflow']);

/** How long an op may take before its caller is told the outcome is unknown.
 *  The sidecar holds the same bounds (canopy_hook.rs `machine_op`). */
export function relayDeadlineMs(kind,args){
 if(kind==='list')return 90_000;
 if(kind==='sync')return 21*60_000;
 if(kind==='copy')return 31*60_000;
 if(kind==='workflow')return 3*60*60_000;
 const minutes=Math.min(20,Math.max(0.1,Number(args?.timeoutMinutes)||10));
 return Math.round(minutes*60_000)+11*60_000;
}

export class RelayUnavailable extends Error{
 constructor(reason,message){super(message);this.reason=reason;}
}

export class MachineRelay{
 constructor({dir,now=Date.now,token=randomBytes(24).toString('base64url')}={}){
  this.dir=dir;this.now=now;this.token=token;
  this.ops=new Map();this.queue=[];this.waiters=new Set();this.next=1;this.lastPoll=0;this.server=null;this.sweeper=null;
 }

 // ---- the agent's side -----------------------------------------------------

 /** Queue one op and wait for the window's answer. Rejects with
  *  RelayUnavailable when no window is there to answer, now or any more. */
 submit(op){
  const kind=String(op?.machineOp??'');
  if(!KINDS.has(kind))return Promise.reject(Error(`unknown machine op: ${kind||'(none)'}`));
  if(typeof op.cwd!=='string'||!op.cwd.startsWith('/'))return Promise.reject(Error('a machine op needs the session\'s working directory'));
  if(this.now()-this.lastPoll>WINDOW_FRESH_MS){
   return Promise.reject(new RelayUnavailable('no-ide','The machine tools are carried out by the Canopy window, and none is connected to this machine right now. Open Canopy and connect to this machine (or turn on All workspaces), then try again.'));
  }
  if(this.ops.size>=MAX_QUEUED)return Promise.reject(new RelayUnavailable('busy','Too many machine operations are waiting on this machine; try again shortly.'));
  const id=String(this.next++);
  const args=op.machineArgs&&typeof op.machineArgs==='object'&&!Array.isArray(op.machineArgs)?op.machineArgs:{};
  return new Promise((resolve,reject)=>{
   const entry={id,kind,args,cwd:op.cwd,ptyId:Number.isInteger(op.ptyId)?op.ptyId:null,delivered:false,resolve,reject,
    timer:setTimeout(()=>this.settle(id,null,new RelayUnavailable('timeout','The Canopy window did not answer in time, so the outcome is unknown: check the other machine before trying again.')),relayDeadlineMs(kind,args))};
   this.ops.set(id,entry);this.queue.push(id);
   for(const wake of this.waiters)wake();
  });
 }

 settle(id,value,error){
  const entry=this.ops.get(id);if(!entry)return false;
  this.ops.delete(id);clearTimeout(entry.timer);
  const at=this.queue.indexOf(id);if(at>=0)this.queue.splice(at,1);
  if(error)entry.reject(error);else entry.resolve(value);
  return true;
 }

 /** Fail what a window took and never answered, once that window is gone. */
 sweep(){
  if(this.now()-this.lastPoll<=WINDOW_FRESH_MS)return;
  for(const entry of [...this.ops.values()]){
   this.settle(entry.id,null,new RelayUnavailable('no-ide',entry.delivered
    ?'The Canopy window disconnected before it answered, so the outcome is unknown: check the other machine before trying again.'
    :'The Canopy window disconnected before it took this request. Reconnect it to this machine and try again.'));
  }
 }

 // ---- the window's side ----------------------------------------------------

 /** The ops waiting for a window, each handed out once. Waits up to `wait` ms
  *  when there are none. */
 async poll(args){
  this.lastPoll=this.now();
  const wait=Math.min(POLL_MAX_MS,Math.max(0,Number(args?.wait)||0));
  if(!this.queue.length&&wait>0){
   await new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);this.waiters.delete(done);resolve();};
    const timer=setTimeout(done,wait);this.waiters.add(done);
   });
   this.lastPoll=this.now();
  }
  const ops=[];
  for(const id of this.queue.splice(0)){
   const entry=this.ops.get(id);if(!entry)continue;
   entry.delivered=true;
   ops.push({id,machineOp:entry.kind,machineArgs:entry.args,cwd:entry.cwd,ptyId:entry.ptyId});
  }
  return {ops};
 }

 /** The window's answer to one op. */
 result(args){
  this.lastPoll=this.now();
  const id=String(args?.id??'');
  const data=args?.data;
  const body=typeof data==='string'?data:JSON.stringify(data??null);
  if(Buffer.byteLength(body)>4*1024*1024)return {accepted:this.settle(id,null,Error('The answer was too large to return.'))};
  return {accepted:this.settle(id,{ok:args?.ok===true,body})};
 }

 // ---- the socket -----------------------------------------------------------

 authorized(request){
  const header=String(request.headers.authorization??'');
  const given=Buffer.from(header.startsWith('Bearer ')?header.slice(7):'');
  const want=Buffer.from(this.token);
  return given.length===want.length&&timingSafeEqual(given,want);
 }

 async handle(request,response){
  const send=(status,body,type='text/plain; charset=utf-8')=>{response.writeHead(status,{'content-type':type,'content-length':Buffer.byteLength(body),connection:'close'});response.end(body);};
  const unavailable=(reason,message)=>send(503,JSON.stringify({error:'unavailable',reason,message}),'application/json');
  if(!this.authorized(request))return send(401,'bad token');
  if(request.method!=='POST'||request.url!=='/ctx/ui')return unavailable('not-implemented','Only the machine tools are served on this machine.');
  let raw='';
  try{
   for await(const chunk of request){raw+=chunk;if(raw.length>MAX_BODY)return send(413,'request too large');}
   const op=JSON.parse(raw);
   if(op?.op!=='machine')return unavailable('not-implemented',`${String(op?.op??'that')} is not served on this machine; only the machine tools are.`);
   const answer=await this.submit(op);
   return send(answer.ok?200:400,answer.body);
  }catch(error){
   if(error instanceof RelayUnavailable)return unavailable(error.reason,error.message);
   return send(400,String(error?.message??error));
  }
 }

 /** Listen on a socket only this user can reach. Resolves with its path. */
 async listen(){
  if(this.server)return this.socket;
  await mkdir(this.dir,{recursive:true,mode:0o700});
  const info=await lstat(this.dir);
  // A folder someone else made first (a shared temp directory) is not ours to trust.
  if(!info.isDirectory()||info.isSymbolicLink()||(typeof process.getuid==='function'&&info.uid!==process.getuid()))throw Error('Relay directory is not owned by this user');
  await chmod(this.dir,0o700);
  this.socket=path.join(this.dir,'relay.sock');
  await rm(this.socket,{force:true});
  const server=http.createServer((request,response)=>{void this.handle(request,response).catch(()=>{try{response.destroy();}catch{}});});
  // A workflow can hold a request open for hours.
  server.requestTimeout=0;server.headersTimeout=60_000;server.keepAliveTimeout=0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.socket,()=>{server.off('error',reject);resolve();});});
  await chmod(this.socket,0o600);
  // The runner has its own reasons to stay up; the relay is never one of them.
  server.unref();
  this.server=server;
  this.sweeper=setInterval(()=>this.sweep(),5000);this.sweeper.unref?.();
  return this.socket;
 }

 /** What a session needs in its environment to reach this relay. */
 env(){return this.server?{CANOPY_RELAY_SOCKET:this.socket,CANOPY_RELAY_TOKEN:this.token}:{};}

 async close(){
  clearInterval(this.sweeper);
  for(const entry of [...this.ops.values()])this.settle(entry.id,null,new RelayUnavailable('no-ide','This machine\'s Canopy host is restarting.'));
  for(const wake of this.waiters)wake();
  if(this.server){await new Promise(resolve=>this.server.close(resolve));this.server=null;await rm(this.socket,{force:true});}
 }
}

/** Where this user's relay socket lives for a workspace: short (a socket path
 *  has a ~100 character limit) and private. */
export function relayDir(workspaceId,{runtime=process.env.XDG_RUNTIME_DIR,tmp=os.tmpdir(),uid=typeof process.getuid==='function'?process.getuid():0}={}){
 const name='canopy-relay-'+String(workspaceId??'workspace').replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);
 const candidates=[...(runtime&&path.isAbsolute(runtime)?[path.join(runtime,name)]:[]),path.join(tmp,`${name}-${uid}`),`/tmp/${name}-${uid}`];
 // macOS gives each user a temp folder deep enough to push a socket in it
 // past the limit; /tmp is the fallback there (listen() checks who owns it).
 return candidates.find(dir=>dir.length+'/relay.sock'.length<=100)??candidates.at(-1);
}

let shared;
/** This runner's relay, started on first use. Never rejects: a relay that
 *  cannot start means sessions run without the machine tools, as before. */
export async function machineRelay(workspaceId=process.env.CANOPY_WORKSPACE_ID){
 if(!shared){
  const relay=new MachineRelay({dir:relayDir(workspaceId)});
  shared=relay.listen().then(()=>relay,error=>{console.warn(`Machine relay unavailable: ${error.message}`);return relay;});
 }
 return shared;
}

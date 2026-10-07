import {mkdir,open,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runtimeReady} from './runtime-readiness.mjs';

// Host-owned state, never mounted into developer containers. Recovery reservations
// are durable before Docker runs, including when Docker fails or the host crashes.
export class RuntimeSupervisor{
 constructor({directory,host,authorize=async()=>false,probe=runtimeReady,now=Date.now,thresholdMs=30000,cooldownMs=60000,maxAttempts=3}){
  Object.assign(this,{directory,host,authorize,probe,now,thresholdMs,cooldownMs,maxAttempts});this.failures=new Map();this.status=new Map();
 }
 async budget(workspace,key){
  const path=join(this.directory,workspace.id+'.json');let file;
  try{
   file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();
   if(!info.isFile()||info.size>4096)throw Error('Invalid recovery state');
   const value=JSON.parse(await file.readFile('utf8'));
   if(value.version!==1||value.workspaceId!==workspace.id||!/^[a-f0-9]{64}$/.test(value.key??'')||!Number.isSafeInteger(value.attempts)||value.attempts<0||value.attempts>this.maxAttempts||!Number.isFinite(value.lastAttemptAt)||value.lastAttemptAt<0)throw Error('Invalid recovery state');
   return value.key===key?value:{version:1,workspaceId:workspace.id,key,attempts:0,lastAttemptAt:0};
  }catch(error){if(error.code==='ENOENT')return {version:1,workspaceId:workspace.id,key,attempts:0,lastAttemptAt:0};throw error;}
  finally{await file?.close();}
 }
 async reserve(workspace,value){
  await mkdir(this.directory,{recursive:true,mode:0o700});
  const destination=join(this.directory,workspace.id+'.json'),temporary=destination+'.'+randomUUID()+'.next';let file;
  try{
   file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(value));await file.sync();await file.close();file=undefined;
   await rename(temporary,destination);const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
  }finally{await file?.close();await rm(temporary,{force:true});}
 }
 async observe(workspace,runtime){
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace.id))throw Error('Invalid recovery workspace');
  if(!await this.authorize(workspace)){this.failures.delete(workspace.id);return 'unauthorized';}
  const current=await this.host.inspectRuntime(workspace);
  if(!current?.State?.Running||current.State.Paused||current.State.Restarting){this.failures.delete(workspace.id);return 'stopped';}
  if(await this.probe(runtime)){this.failures.delete(workspace.id);return 'healthy';}
  const key=createHash('sha256').update(JSON.stringify([current.Id,workspace])).digest('hex'),now=this.now();
  let failure=this.failures.get(workspace.id);
  if(!failure||failure.key!==key){failure={key,since:now,count:0};this.failures.set(workspace.id,failure);}failure.count++;
  if(failure.count<3||now-failure.since<this.thresholdMs)return 'unresponsive';
  const budget=await this.budget(workspace,key);
  if(budget.attempts>=this.maxAttempts)return 'recovery-exhausted';
  if(budget.attempts&&now-budget.lastAttemptAt<this.cooldownMs)return 'cooldown';
  const recovered=await this.host.recoverRuntime(workspace,current.Id,{authorize:()=>this.authorize(workspace),reserve:()=>this.reserve(workspace,{...budget,attempts:budget.attempts+1,lastAttemptAt:now})});
  if(recovered)this.failures.delete(workspace.id);
  return recovered?'recovering':'stopped';
 }
 async checkAll(){
  if(this.checking)return this.checking;
  this.checking=(async()=>{
   const entries=[...this.host.runtimes.values()].filter(entry=>entry.workspace);
   let index=0;const worker=async()=>{while(index<entries.length){const {workspace,runtime}=entries[index++];try{this.status.set(workspace.id,await this.observe(workspace,runtime));}catch{this.status.set(workspace.id,'recovery-blocked');}}};
   await Promise.all([worker(),worker()]);
  })();try{await this.checking;}finally{this.checking=undefined;}
 }
 start(){if(!this.timer){this.timer=setInterval(()=>void this.checkAll(),5000);this.timer.unref();}}
 close(){clearInterval(this.timer);this.timer=undefined;}
}

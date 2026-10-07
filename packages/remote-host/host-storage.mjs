// Gateway side of snapshot storage. The gateway runs unprivileged: it reports
// storage usage and warm-up progress, and can only *request* stop preparation
// by writing one small file that a root path unit acts on (storage-prep.mjs).
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {REQUEST_FILE,STATUS_FILE} from './storage-prep.mjs';
import {PROGRESS_FILE} from './warmup.mjs';
import {MOUNT_POINT,storageUsage} from './user-storage.mjs';

const REQUEST_ID=/^[A-Za-z0-9-]{8,64}$/;
const readJson=async(read,file)=>{try{return JSON.parse(await read(file,'utf8'));}catch{return null;}};
// Only coded, numeric fields leave the host; step errors stay in the journal.
export function publicPrepStatus(status,requestId){
 if(!status||status.requestId!==requestId)return {requestId,status:'requested'};
 const n=v=>Number.isSafeInteger(v)&&v>=0?v:null;
 return {requestId,status:['running','succeeded','failed'].includes(status.status)?status.status:'requested',durationMs:n(status.durationMs),trimmedBytes:n(status.trimmedBytes),usedBytes:status.usedBytes?{rootBytes:n(status.usedBytes.rootBytes),userBytes:n(status.usedBytes.userBytes)}:null,warnings:Array.isArray(status.warnings)?status.warnings.length:0,steps:Array.isArray(status.steps)?status.steps.map(s=>({name:String(s.name).slice(0,40),ok:s.ok===true,ms:n(s.ms)})):[]};
}
export function publicWarmup(progress){
 if(!progress||progress.version!==1)return null;
 const n=v=>Number.isSafeInteger(v)&&v>=0?v:0;
 return {state:progress.state==='done'?'done':'warming',phase:typeof progress.phase==='string'?progress.phase.slice(0,32):null,label:typeof progress.label==='string'?progress.label.slice(0,80):'',percent:Math.max(0,Math.min(100,n(progress.percent))),criticalReady:progress.criticalReady===true,bytesDone:n(progress.bytesDone),bytesTotal:n(progress.bytesTotal)};
}
export function hostStorage({requestFile=REQUEST_FILE,statusFile=STATUS_FILE,progressFile=PROGRESS_FILE,usage=storageUsage,read=readFile,write=writeFile,move=rename,makeDir=mkdir,now=()=>new Date()}={}){
 return {
  async status(workspace){
   const snapshot=Number.isSafeInteger(workspace?.storageGiB);
   let used=null;try{used=await usage({mountPoint:snapshot?MOUNT_POINT:'/srv/canopy',advertisedGib:snapshot?workspace.storageGiB:null});}catch{}
   return {mode:snapshot?'snapshot':'disk',storageGiB:snapshot?workspace.storageGiB:null,usage:used,warmup:snapshot?publicWarmup(await readJson(read,progressFile)):null};
  },
  async requestPrep(requestId){
   if(!REQUEST_ID.test(requestId??''))throw Error('Invalid storage preparation request');
   const current=await readJson(read,statusFile);
   if(current?.requestId===requestId)return publicPrepStatus(current,requestId);
   await makeDir(dirname(requestFile),{recursive:true});
   const temp=`${requestFile}.tmp`;await write(temp,JSON.stringify({requestId,requestedAt:now().toISOString()}),{mode:0o600});await move(temp,requestFile);
   return {requestId,status:'requested'};
  },
  async prepStatus(requestId){
   if(!REQUEST_ID.test(requestId??''))throw Error('Invalid storage preparation request');
   return publicPrepStatus(await readJson(read,statusFile),requestId);
  },
 };
}

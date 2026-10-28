#!/usr/bin/env node
// Update workspace, run detached: the control plane's recovery agent starts
//   systemd-run … node /opt/canopy-host/host-update-run.mjs <payload.json>
// as root and answers `update-host-status {updateId}` from the status file
// this writes. The payload is {updateId, url, runtimeSha256,
// runtimeLockSha256, revision, image}.
//
// Status, written atomically (temporary file + rename) to
// <statusDir>/<updateId>.json:
//   {state:'running', step:'download'|'gateway'|'gateway-ready'|'image'|'rollback', updatedAt}
//   {state:'done', code, host, image, detail, updatedAt}
// code: updated | current | rolled-back | failed | invalid | refresh-required.
// <statusDir>/current holds the updateId while it runs. Every run ends with a
// `done` status, whatever fails.
import * as nodeFs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {updateWorkspaceInPlace} from './host-update.mjs';

export const HOST_UPDATE_STATUS_DIR='/var/lib/canopy-host/host-update';
const UPDATE_ID=/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const defaultExec=(command,args,options)=>promisify(execFile)(command,args,{maxBuffer:65536,...options});

/** MANAGEMENT_READINESS_SCRIPT, once: both services active and the gateway
 * answering its management route with 401. */
export function managementReady({exec=defaultExec,fetchImpl=fetch}={}){
 return async()=>{
  try{
   for(const unit of ['canopy-host','caddy'])await exec('systemctl',['is-active','--quiet',unit],{timeout:2000});
   const response=await fetchImpl('http://127.0.0.1:8787/v1/workspaces',{redirect:'error',signal:AbortSignal.timeout(1000)});
   await response.body?.cancel?.();return response.status===401;
  }catch{return false;}
 };
}

export async function runHostUpdate(payloadPath,{fs=nodeFs,statusDir=HOST_UPDATE_STATUS_DIR,update=updateWorkspaceInPlace,ready=managementReady(),now=()=>new Date().toISOString(),options={}}={}){
 let payload=null,id='invalid-request';
 try{payload=JSON.parse(await fs.readFile(payloadPath,'utf8'));if(UPDATE_ID.test(payload?.updateId??''))id=payload.updateId;}catch{/* Reported below as invalid. */}
 const write=async(name,text)=>{const temporary=`${statusDir}/.${name}.${randomBytes(6).toString('hex')}`;await fs.writeFile(temporary,text,{mode:0o600});await fs.rename(temporary,`${statusDir}/${name}`);};
 // Writes go one after another, so a late step never lands after `done`.
 let tail=Promise.resolve();
 const status=value=>{const next=tail.then(()=>write(`${id}.json`,JSON.stringify({...value,updatedAt:now()})));tail=next.catch(()=>{});return next;};
 let done;
 try{
  await fs.mkdir(statusDir,{recursive:true,mode:0o700});
  if(id==='invalid-request')done={code:'invalid',host:null,image:null,detail:'Update request is unreadable or has no update id'};
  else{
   await write('current',id);
   await status({state:'running',step:'download'});
   // A status write that fails must not stop the update itself.
   const onStep=step=>{void status({state:'running',step}).catch(()=>{});};
   const result=await update(payload,{...options,ready,onStep});
   done={code:result.code,host:result.host??null,image:result.image??null,detail:[result.host?.detail,result.image?.detail].filter(Boolean).join(' ')||null};
  }
 }catch(error){done={code:'failed',host:null,image:null,detail:`Update stopped: ${error?.message??error}`};}
 try{await status({state:'done',...done}).catch(()=>status({state:'done',...done}));}
 finally{
  try{if(id!=='invalid-request'&&String(await fs.readFile(`${statusDir}/current`,'utf8')).trim()===id)await fs.rm(`${statusDir}/current`,{force:true});}catch{/* Nothing is running. */}
 }
 return done;
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 if(process.getuid?.()!==0){console.error('Workspace update runs as root');process.exit(2);}
 if(!process.argv[2]){console.error('Usage: host-update-run.mjs <payload.json>');process.exit(2);}
 runHostUpdate(process.argv[2]).then(done=>{console.log(`Workspace update finished: ${done.code}${done.detail?` (${done.detail})`:''}`);},error=>{console.error(error?.message??error);process.exit(1);});
}

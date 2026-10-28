#!/usr/bin/env node
// Publishes a tested workspace host release and moves workspaces to it
// (docs/designs/workspace-host-rollout.md, "Implementation contract").
//
//   publish <workspace-release.json> <workspace-host.tar.gz>
//     workspace-image.yml on main, after :stable is promoted. Uploads the
//     archive write-once to the release bucket (credentials come from the
//     assumed canopy-release-publisher role), then registers the release with
//     the control plane as a candidate.
//   activate <revision> <appVersion>
//     release.yml on a v* tag. Asks the control plane to make that revision
//     the active release, waiting up to 30 minutes for the image workflow to
//     register it.
//
// Both authenticate to the control plane with a GitHub Actions OIDC token
// (job permission id-token: write).
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {HOST_PROTOCOL} from '../packages/remote-host/native-commands.mjs';
import {runtimeReleaseKey} from '../packages/remote-host/runtime-release-key.mjs';

export const RELEASE_BUCKET='canopy-runtime-703671915771';
export const CONTROL_PLANE='https://canopyide.dev';
export const ACTIVATE_WAIT_MS=30*60*1000;
const defaultExec=(command,args)=>promisify(execFile)(command,args,{maxBuffer:1024*1024});
const sleepFor=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** A GitHub Actions OIDC token for the control plane's audience. */
export async function oidcToken({env=process.env,fetchImpl=fetch,audience=CONTROL_PLANE}={}){
 if(!env.ACTIONS_ID_TOKEN_REQUEST_URL||!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw Error('No GitHub OIDC token is available; the job needs permissions: id-token: write');
 const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);url.searchParams.set('audience',audience);
 const response=await fetchImpl(url.href,{headers:{authorization:`bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,accept:'application/json'}});
 if(!response.ok)throw Error(`GitHub OIDC token request failed (${response.status})`);
 const {value}=await response.json();if(typeof value!=='string'||!value)throw Error('GitHub OIDC token response was empty');
 return value;
}

/** What the control plane registers, from the tested manifest and archive. */
export function releaseRecord(manifest,archive){
 const runtimeSha256=createHash('sha256').update(archive).digest('hex');
 if(runtimeReleaseKey(manifest?.revision)!==manifest.runtimeKey)throw Error('Release manifest key is not this revision\'s archive');
 if(!/^[a-f0-9]{64}$/.test(manifest.runtimeLockSha256??''))throw Error('Release manifest has no dependency lock hash');
 if(typeof manifest.image!=='string'||!/@sha256:[a-f0-9]{64}$/.test(manifest.image))throw Error('Release manifest has no immutable image');
 return {revision:manifest.revision,runtimeKey:manifest.runtimeKey,runtimeSha256,runtimeLockSha256:manifest.runtimeLockSha256,image:manifest.image,hostProtocol:HOST_PROTOCOL};
}

/** Write-once upload: releases/* never accepts an overwrite. A 412 means the
 * object is already there, which is fine only when it is the same bytes. */
export async function uploadArchive(record,archivePath,{exec=defaultExec,bucket=RELEASE_BUCKET,log=console.log}={}){
 const checksum=Buffer.from(record.runtimeSha256,'hex').toString('base64');
 try{
  await exec('aws',['s3api','put-object','--bucket',bucket,'--key',record.runtimeKey,'--body',archivePath,'--if-none-match','*','--checksum-sha256',checksum,'--metadata',`sha256=${record.runtimeSha256}`,'--server-side-encryption','AES256','--content-type','application/x-tar']);
  log(`Uploaded s3://${bucket}/${record.runtimeKey}`);return 'uploaded';
 }catch(error){
  const detail=`${error?.stderr??''}${error?.message??error}`;
  if(!/PreconditionFailed|\(412\)|\b412\b/.test(detail))throw Error(`Release upload failed: ${detail.trim()}`);
 }
 const head=JSON.parse((await exec('aws',['s3api','head-object','--bucket',bucket,'--key',record.runtimeKey,'--checksum-mode','ENABLED'])).stdout);
 if(head.ChecksumSHA256!==checksum)throw Error(`s3://${bucket}/${record.runtimeKey} already exists with different contents`);
 if(head.Metadata?.sha256&&head.Metadata.sha256!==record.runtimeSha256)throw Error(`s3://${bucket}/${record.runtimeKey} already exists with a different recorded hash`);
 log(`s3://${bucket}/${record.runtimeKey} was already uploaded with the same contents`);return 'existing';
}

async function post(route,body,{token,fetchImpl,controlPlane}){
 const response=await fetchImpl(controlPlane+route,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const text=await response.text();let json=null;try{json=JSON.parse(text);}catch{/* Plain-text errors are reported as they are. */}
 return {status:response.status,ok:response.ok,json,message:json?.error??json?.message??text.slice(0,500)};
}
const transient=status=>status===408||status===429||status>=500;

/** Register the uploaded release as a candidate. Idempotent per revision. */
export async function registerRelease(record,{env=process.env,fetchImpl=fetch,controlPlane=CONTROL_PLANE,sleep=sleepFor,attempts=5,log=console.log}={}){
 for(let attempt=1;;attempt++){
  let result;try{result=await post('/api/releases',record,{token:await oidcToken({env,fetchImpl}),fetchImpl,controlPlane});}
  catch(error){result={status:0,message:String(error?.message??error)};}
  if(result.ok){log(`Registered ${record.revision} as a candidate release`);return result.json;}
  if(!(result.status===0||transient(result.status))||attempt>=attempts)throw Error(`Release registration failed (${result.status}): ${result.message}`);
  log(`Release registration attempt ${attempt} failed (${result.status}): ${result.message}; retrying`);await sleep(10000*attempt);
 }
}

export async function publish(manifestPath,archivePath,options={}){
 const {readFileImpl=readFile,log=console.log}=options;
 const manifest=JSON.parse(await readFileImpl(manifestPath,'utf8')),record=releaseRecord(manifest,await readFileImpl(archivePath));
 log(JSON.stringify(record,null,2));
 await uploadArchive(record,archivePath,options);
 await registerRelease(record,options);
 return record;
}

/** Activate the tag's revision. 404/409 and server errors are retried until
 * the image workflow has registered it (or snapshots match); other refusals
 * fail at once. */
export async function activate(revision,appVersion,{env=process.env,fetchImpl=fetch,controlPlane=CONTROL_PLANE,sleep=sleepFor,now=Date.now,waitMs=ACTIVATE_WAIT_MS,intervalMs=30000,log=console.log}={}){
 if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Activation needs the full commit of the tag');
 if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(appVersion??''))throw Error(`Not an app version: ${appVersion}`);
 const deadline=now()+waitMs;
 for(;;){
  let result;try{result=await post('/api/releases/activate',{revision,appVersion},{token:await oidcToken({env,fetchImpl}),fetchImpl,controlPlane});}
  catch(error){result={status:0,message:String(error?.message??error)};}
  if(result.ok){log(`Activated workspace host ${revision} for Canopy ${appVersion}`);return result.json;}
  const waiting=result.status===0||result.status===404||result.status===409||transient(result.status);
  if(!waiting)throw Error(`Activation refused (${result.status}): ${result.message}`);
  if(now()+intervalMs>deadline)throw Error(`Activation did not succeed within ${Math.round(waitMs/60000)} minutes (${result.status}): ${result.message}`);
  log(`Not activated yet (${result.status}): ${result.message}; retrying in ${intervalMs/1000}s`);await sleep(intervalMs);
 }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const [command,...args]=process.argv.slice(2);
 const run=command==='publish'&&args.length===2?publish(args[0],args[1]):command==='activate'&&args.length===2?activate(args[0],args[1]):null;
 if(!run){console.error('Usage: workspace-host-release.mjs publish <workspace-release.json> <workspace-host.tar.gz> | activate <revision> <appVersion>');process.exit(2);}
 run.catch(error=>{console.error(error?.message??error);process.exit(1);});
}

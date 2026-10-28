import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {activate,oidcToken,publish,releaseRecord,uploadArchive} from './workspace-host-release.mjs';
import {HOST_PROTOCOL} from '../packages/remote-host/native-commands.mjs';
const revision='a'.repeat(40),archive=Buffer.from('archive bytes'),hex=createHash('sha256').update(archive).digest('hex'),b64=Buffer.from(hex,'hex').toString('base64');
const manifest={revision,runtimeKey:`releases/${revision}/workspace-host.tar.gz`,runtimeLockSha256:'f'.repeat(64),image:'ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'1'.repeat(64),channel:'ghcr.io/fluidworksapp/canopy-workspace:stable'};
const env={ACTIONS_ID_TOKEN_REQUEST_URL:'https://token.actions.invalid/?api-version=2.0',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'request-token'};
const quiet=()=>{};
function controlPlane(responses){
 const calls=[];let token=0;
 const fetchImpl=async(url,options={})=>{
  if(url.startsWith('https://token.actions.invalid/')){calls.push({oidc:new URL(url).searchParams.get('audience'),auth:options.headers.authorization});return Response.json({value:`oidc-${++token}`});}
  calls.push({url,auth:options.headers.authorization,body:JSON.parse(options.body)});
  const next=responses.shift();return next instanceof Error?Promise.reject(next):new Response(JSON.stringify(next.body??{}),{status:next.status});
 };
 return {fetchImpl,calls};
}
test('the registered release is the tested manifest, the archive hash and this checkout\'s host protocol',()=>{
 assert.deepEqual(releaseRecord(manifest,archive),{revision,runtimeKey:manifest.runtimeKey,runtimeSha256:hex,runtimeLockSha256:manifest.runtimeLockSha256,image:manifest.image,hostProtocol:HOST_PROTOCOL});
 assert.throws(()=>releaseRecord({...manifest,runtimeKey:'releases/other/workspace-host.tar.gz'},archive));
 assert.throws(()=>releaseRecord({...manifest,image:manifest.channel},archive));
 assert.throws(()=>releaseRecord({...manifest,runtimeLockSha256:undefined},archive));
});
test('upload is write-once with checksum, metadata and encryption; an existing identical object is accepted',async()=>{
 const record=releaseRecord(manifest,archive),calls=[];
 assert.equal(await uploadArchive(record,'host.tgz',{log:quiet,exec:async(command,args)=>{calls.push([command,...args]);return {stdout:'{}'};}}),'uploaded');
 assert.deepEqual(calls,[['aws','s3api','put-object','--bucket','canopy-runtime-703671915771','--key',manifest.runtimeKey,'--body','host.tgz','--if-none-match','*','--checksum-sha256',b64,'--metadata',`sha256=${hex}`,'--server-side-encryption','AES256','--content-type','application/x-tar']]);
 const existing=head=>async(command,args)=>{if(args[1]==='put-object')throw Object.assign(Error('Command failed'),{stderr:'An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold'});assert.deepEqual(args.slice(-2),['--checksum-mode','ENABLED']);return {stdout:JSON.stringify(head)};};
 assert.equal(await uploadArchive(record,'host.tgz',{log:quiet,exec:existing({ChecksumSHA256:b64,Metadata:{sha256:hex}})}),'existing');
 await assert.rejects(uploadArchive(record,'host.tgz',{log:quiet,exec:existing({ChecksumSHA256:'different',Metadata:{sha256:hex}})}),/different contents/);
 await assert.rejects(uploadArchive(record,'host.tgz',{log:quiet,exec:existing({Metadata:{sha256:hex}})}),/different contents/,'an object without a verifiable checksum is not trusted');
 await assert.rejects(uploadArchive(record,'host.tgz',{log:quiet,exec:async()=>{throw Object.assign(Error('Command failed'),{stderr:'AccessDenied'});}}),/Release upload failed: AccessDenied/);
});
test('publish uploads then registers with a GitHub OIDC token for canopyide.dev, retrying only server errors',async()=>{
 const files={'release.json':JSON.stringify(manifest),'host.tgz':archive},order=[];
 const {fetchImpl,calls}=controlPlane([{status:502},{status:200,body:{state:'candidate'}}]);
 const record=await publish('release.json','host.tgz',{env,fetchImpl,log:quiet,sleep:async()=>{},readFileImpl:async(path,encoding)=>encoding?files[path]:files[path],exec:async()=>{order.push('upload');return {stdout:''};}});
 assert.deepEqual(order,['upload']);
 assert.deepEqual(calls.filter(c=>c.oidc).map(c=>[c.oidc,c.auth]),[['https://canopyide.dev','bearer request-token'],['https://canopyide.dev','bearer request-token']]);
 const posts=calls.filter(c=>c.url);assert.equal(posts.length,2);assert.equal(posts[0].url,'https://canopyide.dev/api/releases');assert.equal(posts[1].auth,'Bearer oidc-2','each attempt uses a fresh token');assert.deepEqual(posts[1].body,record);
 const refused=controlPlane([{status:403,body:{error:'Only main may register releases'}}]);
 await assert.rejects(publish('release.json','host.tgz',{env,fetchImpl:refused.fetchImpl,log:quiet,sleep:async()=>{},readFileImpl:async(path,encoding)=>encoding?files[path]:files[path],exec:async()=>({stdout:''})}),/\(403\): Only main may register releases/);
 await assert.rejects(oidcToken({env:{}}),/id-token: write/);
});
test('activation waits for the image workflow to register the release, up to its deadline',async()=>{
 let clock=0;const sleep=async ms=>{clock+=ms;};
 const {fetchImpl,calls}=controlPlane([{status:404,body:{error:'Unknown release'}},{status:409,body:{error:'Release is not registered yet'}},new Error('socket hang up'),{status:200,body:{state:'active'}}]);
 assert.deepEqual(await activate(revision,'0.5.3',{env,fetchImpl,sleep,now:()=>clock,log:quiet}),{state:'active'});
 const posts=calls.filter(c=>c.url);assert.equal(posts.length,4);assert.equal(posts[0].url,"https://canopyide.dev/api/releases/activate");assert.deepEqual(posts[0].body,{revision,appVersion:'0.5.3'});
 clock=0;const never=controlPlane(Array.from({length:100},()=>({status:404,body:{error:'Unknown release'}})));
 await assert.rejects(activate(revision,'0.5.3',{env,fetchImpl:never.fetchImpl,sleep,now:()=>clock,log:quiet}),/within 30 minutes \(404\): Unknown release/);
 assert.equal(never.calls.filter(c=>c.url).length,61,"one attempt every 30 s for 30 minutes");
 const forbidden=controlPlane([{status:403,body:{error:'Tag ref required'}}]);
 await assert.rejects(activate(revision,'0.5.3',{env,fetchImpl:forbidden.fetchImpl,sleep,now:()=>clock,log:quiet}),/refused \(403\)/);
 await assert.rejects(activate('v0.5.3','0.5.3',{env}),/full commit/);await assert.rejects(activate(revision,'v0.5.3',{env}),/app version/);
});

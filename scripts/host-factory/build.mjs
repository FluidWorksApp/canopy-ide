import {randomUUID} from 'node:crypto';
import {factoryRecipe,factorySeal,factoryStatusScript} from './recipe.mjs';
import {runtimeReleaseKey} from '../../packages/remote-host/runtime-release-key.mjs';
import {hostSnapshotTags,verifyHostSnapshot} from '../../packages/control-plane/lib/host-snapshot.mjs';
/** Explicit operator workflow; injected AWS/SSH adapters make lifecycle safety testable. */
export async function buildHostSnapshot(config,{aws,ssh,presign,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 if(!['ap-southeast-1','us-east-1','eu-west-1'].includes(config.region)||config.sourceBundle!=='medium_3_0'||!config.runtimeBucket||!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(config.runtimeBucket))throw Error('Factory region, private bucket and smallest source bundle are required');
 const key=runtimeReleaseKey(config.revision,config.runtimeKey),url=await presign(config.runtimeBucket,key);
 const recipe=factoryRecipe(config,url),id=randomUUID(),builder=`canopy-host-factory-${id}`,keyPairName=`canopy-factory-key-${id}`,snapshotName=`canopy-host-${config.revision.slice(0,12)}-${id.slice(0,8)}`;
 const tag={key:'canopy-factory-job',value:id},tags=[{key:'managed-by',value:'canopy-host-factory'},tag];let created=false,keyCreated=false,snapshotCreated=false,verified=false;const deadline=now()+30*60*1000;
 const own=resource=>resource&&resource.tags?.some(t=>t.key===tag.key&&t.value===tag.value)&&resource.tags?.some(t=>t.key==='managed-by'&&t.value==='canopy-host-factory');
 const observe=async()=>{const result=await aws('get-instance',{instanceName:builder});if(!own(result.instance))throw Error('Factory builder ownership changed');return result.instance;};
 const until=async(check)=>{while(now()<deadline){const result=await check();if(result)return result;await wait(5000);}throw Error('Factory stage exceeded its deadline');};
 try{
  // A job-specific credential avoids both browser-certificate compatibility
  // and the account-wide default key. It never enters user data or the catalog.
  keyCreated=true;const key=await aws('create-key-pair',{keyPairName,tags});
  if(!own(key.keyPair)||key.keyPair.name!==keyPairName||typeof key.privateKeyBase64!=='string'||!key.privateKeyBase64||key.privateKeyBase64.length>16384)throw Error('Factory SSH key identity is unavailable');
  const credential={keyPairName,privateKey:key.privateKeyBase64};
  created=true;await aws('create-instances',{instanceNames:[builder],availabilityZone:config.region+'a',blueprintId:'ubuntu_24_04',bundleId:config.sourceBundle,ipAddressType:'dualstack',keyPairName,tags,userData:recipe});
  await until(async()=> (await observe()).state?.name==='running');
  const prepared=await until(async()=>{await observe();let status;try{status=JSON.parse(await ssh(builder,factoryStatusScript,credential));}catch{return null;}
   if(status.factoryBootstrapFailed===true)throw Error('Factory bootstrap finished without passing smoke checks');
   return status.version===1?status:null;
  });
  for(const field of ['version','architecture','revision','runtimeSha256','lockSha256','nodeVersion','dockerVersion','caddyVersion'])if(prepared[field]!==({...config,version:1})[field])throw Error('Factory metadata does not match its requested immutable release');
  if(prepared.proof?.docker!==true||prepared.proof?.http!==true)throw Error('Factory Docker and HTTP smoke evidence is missing');
  await observe();const sealed=JSON.parse(await ssh(builder,factorySeal,credential));if(sealed.proof?.sanitized!==true||sealed.proof?.bootFenced!==true||sealed.revision!==config.revision)throw Error('Factory sanitization failed');
  await aws('stop-instance',{instanceName:builder});await until(async()=> (await observe()).state?.name==='stopped');
  const base={region:config.region,architecture:config.architecture,nodeVersion:config.nodeVersion,dockerVersion:config.dockerVersion,caddyVersion:config.caddyVersion,revision:config.revision,runtimeSha256:config.runtimeSha256,lockSha256:config.lockSha256,sourceBundle:config.sourceBundle,targetBundles:['medium_3_0','large_3_0','xlarge_3_0','2xlarge_3_0'],snapshotName,verifiedAt:new Date(now()).toISOString(),proof:{docker:true,http:true,sanitized:true,bootFenced:true}};
  snapshotCreated=true;await aws('create-instance-snapshot',{instanceName:builder,instanceSnapshotName:snapshotName,tags:[...hostSnapshotTags(base),tag]});
  const snapshot=await until(async()=>{const result=await aws('get-instance-snapshot',{instanceSnapshotName:snapshotName});if(!result.instanceSnapshot)return null;if(!own(result.instanceSnapshot))throw Error('Factory snapshot ownership changed');return result.instanceSnapshot.state==='available'?result.instanceSnapshot:null;});
  const record={...base,snapshotArn:snapshot.arn};verifyHostSnapshot(record,snapshot);verified=true;
  return {version:1,entries:[record]};
 }finally{
  // Cleanup is scoped to this exact job tag; never touch a workspace or a
  // resource merely because its name resembles a factory resource.
  let cleanupError;
  try{if(snapshotCreated&&!verified){const result=await aws('get-instance-snapshot',{instanceSnapshotName:snapshotName});if(result.instanceSnapshot&&!own(result.instanceSnapshot))throw Error('Refusing cleanup of a foreign factory snapshot');if(result.instanceSnapshot)await aws('delete-instance-snapshot',{instanceSnapshotName:snapshotName});}}catch(error){cleanupError=error;}
  try{if(created){const result=await aws('get-instance',{instanceName:builder});if(result.instance&&!own(result.instance))throw Error('Refusing cleanup of a foreign factory builder');if(result.instance)await aws('delete-instance',{instanceName:builder,forceDeleteAddOns:false});}}catch(error){cleanupError??=error;}
  try{if(keyCreated){const result=await aws('get-key-pair',{keyPairName});if(result.keyPair&&(!own(result.keyPair)||result.keyPair.name!==keyPairName))throw Error('Refusing cleanup of a foreign factory key');if(result.keyPair)await aws('delete-key-pair',{keyPairName});}}catch(error){cleanupError??=error;}
  if(cleanupError)throw cleanupError;
 }
}

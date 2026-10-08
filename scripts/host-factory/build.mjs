import {randomUUID} from 'node:crypto';
import {factoryRecipe,factorySeal,factoryStatusScript} from './recipe.mjs';
import {runtimeReleaseKey} from '../../packages/remote-host/runtime-release-key.mjs';
import {hostSnapshotTags,verifyHostSnapshot,selectHostSnapshot} from '../../packages/control-plane/lib/host-snapshot.mjs';
class FactoryObservationDeadline extends Error {constructor(){super('Factory stage exceeded its deadline');}}
class FactorySnapshotObservationUnavailable extends Error {constructor(){super('Factory snapshot observation is unavailable');}}
/** Explicit operator workflow; injected AWS/SSH adapters make lifecycle safety testable. */
export async function buildHostSnapshot(config,{aws,ssh,presign,onHandoff,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 if(!Array.isArray(config.targetBundles)||!config.targetBundles.length||!config.targetBundles.every(id=>/^(?:medium|large|xlarge|2xlarge|4xlarge|8xlarge)_3_0$/.test(id)))throw Error('Factory target bundles must come from the plan catalog (/api/plans bundles)');
 if(!['ap-southeast-1','us-east-1','eu-west-1'].includes(config.region)||config.sourceBundle!=='medium_3_0'||!config.runtimeBucket||!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(config.runtimeBucket))throw Error('Factory region, private bucket and smallest source bundle are required');
 const key=runtimeReleaseKey(config.revision,config.runtimeKey),url=await presign(config.runtimeBucket,key);
 const recipe=factoryRecipe(config,url),id=randomUUID(),builder=`canopy-host-factory-${id}`,keyPairName=`canopy-factory-key-${id}`,snapshotName=`canopy-host-${config.revision.slice(0,12)}-${id.slice(0,8)}`;
 if(hostSnapshotTags(config).some(tag=>typeof tag.value!=='string'||tag.value.length>256||!/^[A-Za-z0-9+_.:/@= -]+$/.test(tag.value)))throw Error('Factory snapshot tags are invalid');
 const tag={key:'canopy-factory-job',value:id},tags=[{key:'managed-by',value:'canopy-host-factory'},tag];let created=false,keyCreated=false,snapshotCreated=false,verified=false,preserved=false;const deadline=now()+30*60*1000;
 const own=resource=>resource&&resource.tags?.some(t=>t.key===tag.key&&t.value===tag.value)&&resource.tags?.some(t=>t.key==='managed-by'&&t.value==='canopy-host-factory');
 const observe=async()=>{const result=await aws('get-instance',{instanceName:builder});if(!own(result.instance))throw Error('Factory builder ownership changed');return result.instance;};
 const until=async(check)=>{while(now()<deadline){const result=await check();if(result)return result;await wait(5000);}throw new FactoryObservationDeadline();};
 try{
  // A job-specific credential avoids both browser-certificate compatibility
  // and the account-wide default key. It never enters user data or the catalog.
  keyCreated=true;const key=await aws('create-key-pair',{keyPairName,tags});
  // Verify tags on an independent provider read: the create response can omit
  // tags even when tagged creation and the subsequent read succeeded.
  const observedKey=(await aws('get-key-pair',{keyPairName})).keyPair;
  if(!own(observedKey)||observedKey.name!==keyPairName)throw Error('Factory SSH key identity is unavailable');
  if(typeof key.privateKeyBase64!=='string'||!key.privateKeyBase64||key.privateKeyBase64.length>16384)throw Error('Factory SSH key material is unavailable');
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
  const base={region:config.region,architecture:config.architecture,nodeVersion:config.nodeVersion,dockerVersion:config.dockerVersion,caddyVersion:config.caddyVersion,revision:config.revision,runtimeSha256:config.runtimeSha256,lockSha256:config.lockSha256,sourceBundle:config.sourceBundle,targetBundles:config.targetBundles,snapshotName,verifiedAt:new Date(now()).toISOString(),proof:{docker:true,http:true,sanitized:true,bootFenced:true}};
  snapshotCreated=true;await aws('create-instance-snapshot',{instanceName:builder,instanceSnapshotName:snapshotName,tags:[...hostSnapshotTags(base),tag]});
  let snapshot,lastSnapshot;
  try{snapshot=await until(async()=>{let result;try{result=await aws('get-instance-snapshot',{instanceSnapshotName:snapshotName});}catch{throw new FactorySnapshotObservationUnavailable();}if(!result.instanceSnapshot)return null;if(!own(result.instanceSnapshot))throw Error('Factory snapshot ownership changed');lastSnapshot=result.instanceSnapshot;return lastSnapshot.state==='available'?lastSnapshot:null;});}
  catch(error){if(!(error instanceof FactoryObservationDeadline||error instanceof FactorySnapshotObservationUnavailable)||lastSnapshot?.state!=='pending')throw error;
   const record={...base,snapshotArn:lastSnapshot.arn};verifyHostSnapshot(record,{...lastSnapshot,state:'available'});
   const handoff={version:1,jobId:id,builderName:builder,keyPairName,record};await onHandoff?.(handoff);preserved=true;
   return {pending:true,phase:'creating-snapshot',handoff};
  }
  const record={...base,snapshotArn:snapshot.arn};verifyHostSnapshot(record,snapshot);verified=true;
  const handoff={version:1,jobId:id,builderName:builder,keyPairName,record};await onHandoff?.(handoff);preserved=true;
  const final=await finalizeHostSnapshot(config,handoff,{aws});return final.pending?{...final,handoff}:final;
 }finally{
  // Cleanup is scoped to this exact job tag; never touch a workspace or a
  // resource merely because its name resembles a factory resource.
  if(!preserved){let cleanupError;
  try{if(snapshotCreated&&!verified){const result=await aws('get-instance-snapshot',{instanceSnapshotName:snapshotName});if(result.instanceSnapshot&&!own(result.instanceSnapshot))throw Error('Refusing cleanup of a foreign factory snapshot');if(result.instanceSnapshot)await aws('delete-instance-snapshot',{instanceSnapshotName:snapshotName});}}catch(error){cleanupError=error;}
  try{if(created){const result=await aws('get-instance',{instanceName:builder});if(result.instance&&!own(result.instance))throw Error('Refusing cleanup of a foreign factory builder');if(result.instance)await aws('delete-instance',{instanceName:builder,forceDeleteAddOns:false});}}catch(error){cleanupError??=error;}
  try{if(keyCreated){const result=await aws('get-key-pair',{keyPairName});if(result.keyPair&&(!own(result.keyPair)||result.keyPair.name!==keyPairName))throw Error('Refusing cleanup of a foreign factory key');if(result.keyPair)await aws('delete-key-pair',{keyPairName});}}catch(error){cleanupError??=error;}
  if(cleanupError)throw cleanupError;}
 }
}

/** Finish the same verified provider job after a long snapshot operation.
 * This path never creates compute, a key or a snapshot. */
export async function finalizeHostSnapshot(config,handoff,{aws}){
 const {jobId,builderName,keyPairName,record}=handoff??{};
 const fields=['region','architecture','nodeVersion','dockerVersion','caddyVersion','revision','runtimeSha256','lockSha256','sourceBundle','targetBundles','snapshotName','snapshotArn','verifiedAt','proof'];
 if(!handoff||Object.keys(handoff).length!==5||!record||Object.keys(record).length!==fields.length||fields.some(field=>!Object.hasOwn(record,field))||!record.proof||Object.keys(record.proof).length!==4)throw Error('Factory handoff contains unsupported metadata');
 if(handoff?.version!==1||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(jobId??'')||builderName!==`canopy-host-factory-${jobId}`||keyPairName!==`canopy-factory-key-${jobId}`||record?.snapshotName!==`canopy-host-${config.revision.slice(0,12)}-${jobId.slice(0,8)}`)throw Error('Factory handoff identity differs');
 for(const field of ['region','architecture','revision','runtimeSha256','lockSha256','nodeVersion','dockerVersion','caddyVersion','sourceBundle'])if(record[field]!==config[field])throw Error('Factory handoff release differs');
 selectHostSnapshot({version:1,entries:[record]},config.region,config.sourceBundle,config.runtimeSha256);
 const own=resource=>resource?.tags?.some(t=>t.key==='managed-by'&&t.value==='canopy-host-factory')&&resource.tags.some(t=>t.key==='canopy-factory-job'&&t.value===jobId);
 const snapshot=(await aws('get-instance-snapshot',{instanceSnapshotName:record.snapshotName})).instanceSnapshot;
 if(!snapshot||!own(snapshot))throw Error('Factory snapshot ownership differs');
 // Check all identity/proof tags even while the provider copy is pending.
 verifyHostSnapshot(record,{...snapshot,state:'available'});
 if(snapshot.state==='pending')return {pending:true,phase:'creating-snapshot'};
 if(snapshot.state!=='available')throw Error('Factory snapshot is not available');
 const builder=(await aws('get-instance',{instanceName:builderName})).instance;
 if(builder){if(!own(builder)||builder.name!==builderName)throw Error('Refusing cleanup of a foreign factory builder');
  if(builder.state?.name==='shutting-down'||builder.state?.name==='terminated')return {pending:true,phase:'deleting-builder'};
  if(builder.state?.name!=='stopped')throw Error('Factory builder is not observed stopped');
  await aws('delete-instance',{instanceName:builderName,forceDeleteAddOns:false});
  if((await aws('get-instance',{instanceName:builderName})).instance)return {pending:true,phase:'deleting-builder'};
 }
 const key=(await aws('get-key-pair',{keyPairName})).keyPair;
 if(key){if(!own(key)||key.name!==keyPairName)throw Error('Refusing cleanup of a foreign factory key');await aws('delete-key-pair',{keyPairName});if((await aws('get-key-pair',{keyPairName})).keyPair)return {pending:true,phase:'deleting-key'};}
 return {version:1,entries:[record]};
}

// Replica only: stands in for `@aws-sdk/client-lightsail` inside the local
// control plane (hooks.mjs maps the import here; production never loads it).
// It implements the Lightsail API calls that canopy-website's real provider
// (lib/canopy/lightsail.mjs) makes, backed by Docker on this machine:
//   instance          -> a privileged container booting its own ext4 boot disk
//                        (host/bin/replica-init) with systemd and cloud-init
//   disk              -> a sparse file attached to the instance as a loop device
//   instance snapshot -> a sparse copy of a stopped instance's boot disk
// Lightsail is asynchronous; so is this: create/stop/start/snapshot calls return
// at once and GetInstance/GetDisk/GetInstanceSnapshot report pending states
// until the Docker work finishes.
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,rmSync,statSync} from 'node:fs';
import {promisify} from 'node:util';
import {getCACertificates,setDefaultCACertificates} from 'node:tls';

const exec=promisify(execFile);
const env=process.env;
const ROOT='/disks';
const STATE=`${ROOT}/lightsail-state.json`;
const RUN=env.REPLICA_RUN??'local';
const BUNDLES={medium_3_0:{cpus:2,memoryGiB:4,diskGiB:80},large_3_0:{cpus:2,memoryGiB:8,diskGiB:160},xlarge_3_0:{cpus:4,memoryGiB:16,diskGiB:320},'2xlarge_3_0':{cpus:8,memoryGiB:32,diskGiB:640}};
const log=(...args)=>console.log('[lightsail]',...args);

class Command{constructor(input={}){this.input=input;}}
export class GetDiskCommand extends Command{}
export class GetInstanceCommand extends Command{}
export class CreateDiskCommand extends Command{}
export class CreateInstancesCommand extends Command{}
export class GetInstanceSnapshotCommand extends Command{}
export class CreateInstancesFromSnapshotCommand extends Command{}
export class AttachDiskCommand extends Command{}
export class DetachDiskCommand extends Command{}
export class StartInstanceCommand extends Command{}
export class StopInstanceCommand extends Command{}
export class DeleteInstanceCommand extends Command{}
export class DeleteDiskCommand extends Command{}
export class GetDiskSnapshotsCommand extends Command{}
export class DeleteDiskSnapshotCommand extends Command{}
export class PutInstancePublicPortsCommand extends Command{}
export class CreateInstanceSnapshotCommand extends Command{}
export class DeleteInstanceSnapshotCommand extends Command{}
export class GetInstanceSnapshotsCommand extends Command{}

const awsError=(name,message)=>Object.assign(new Error(message),{name,$metadata:{httpStatusCode:name==='NotFoundException'?400:400}});
const notFound=what=>awsError('NotFoundException',`${what} does not exist`);
const invalid=message=>awsError('InvalidInputException',message);

let state;
function load(){
 if(state)return state;
 state=existsSync(STATE)?JSON.parse(readFileSync(STATE,'utf8')):{instances:{},disks:{},snapshots:{},events:[]};
 return state;
}
function save(){const s=load();writeFileSync(STATE+'.tmp',JSON.stringify(s,null,1));renameSync(STATE+'.tmp',STATE);}
function event(kind,detail){const s=load();s.events.push({at:new Date().toISOString(),kind,...detail});save();log(kind,JSON.stringify(detail));}
export function replicaEvents(){return load().events;}

const docker=(args,options={})=>exec('docker',args,{maxBuffer:16*1024*1024,timeout:10*60_000,...options});
const containerName=name=>`canopy-replica-${RUN}-${name}`;
const arn=(kind,name,region)=>`arn:aws:lightsail:${region}:000000000000:${kind}/${name}-${randomUUID()}`;
// Background work keeps running after the API call returns, like Lightsail's.
function background(record,transition,work,after){
 record.transition=transition;save();
 work().then(()=>{record.transition=null;after?.();save();},error=>{record.transition=null;record.lastError=String(error.stderr||error.message).slice(0,2000);save();event('provider-error',{name:record.name,transition,error:record.lastError});});
}
async function inspect(name){
 try{const {stdout}=await docker(['inspect','--format','{{json .State}}|{{json .NetworkSettings.Networks}}',containerName(name)]);const [s,n]=stdout.trim().split('|');return {state:JSON.parse(s),networks:JSON.parse(n)};}
 catch{return null;}
}
// Boot disks and snapshots are reflink clones on the run's XFS filesystem
// (copy-on-write, like EBS snapshots); elsewhere a sparse copy.
const copySparse=(from,to)=>exec('cp',['--reflink=auto','--sparse=always',from,to],{timeout:60*60_000});
async function grow(file,gib){
 const current=statSync(file).size;if(current>=gib*1024**3)return;
 await exec('truncate',['-s',`${gib}G`,file]);
 await exec('e2fsck',['-pf',file],{timeout:10*60_000}).catch(error=>{if(error.code>=4)throw error;});
 await exec('resize2fs',[file],{timeout:10*60_000});
}
async function detachLoops(file){
 const {stdout}=await exec('losetup',['-j',file]).catch(()=>({stdout:''}));
 for(const line of stdout.split('\n').filter(Boolean)){
  const dev=line.split(':')[0],minor=dev.match(/^\/dev\/loop(\d+)$/)?.[1];
  if(minor&&!existsSync(dev))await exec('mknod',['-m','0660',dev,'b','7',minor]).catch(()=>{});
  await exec('losetup',['-d',dev]).catch(error=>event('loop-detach-error',{dev,error:String(error.stderr||error.message)}));
 }
}
function instanceDir(name){return `${ROOT}/instances/${name}`;}
function writeAttached(instanceName){
 const s=load();const names=Object.values(s.disks).filter(d=>d.attachedTo===instanceName).map(d=>d.name);
 writeFileSync(`${instanceDir(instanceName)}/attached`,names.join('\n')+(names.length?'\n':''));
}
async function launch(record,bootSource,userData){
 const dir=instanceDir(record.name);mkdirSync(`${dir}/seed`,{recursive:true});
 await copySparse(bootSource,`${dir}/boot.img`);
 await grow(`${dir}/boot.img`,BUNDLES[record.bundleId].diskGiB);
 // cloud-init NoCloud seed: a new instance-id per instance, so user data runs
 // once per instance (and again on an instance restored from a snapshot).
 writeFileSync(`${dir}/seed/meta-data`,`instance-id: i-${record.instanceId}\nlocal-hostname: ${record.hostname}\n`);
 writeFileSync(`${dir}/seed/user-data`,userData||'#cloud-config\n{}\n');
 writeAttached(record.name);
 if(env.REPLICA_STALE_APT_TIMERS==='1')writeFileSync(`${dir}/stale-apt-timers`,'');
 const bundle=BUNDLES[record.bundleId];
 const memory=Math.min(bundle.memoryGiB*1024,Number(env.REPLICA_MAX_MEMORY_MIB??bundle.memoryGiB*1024));
 const hosts=(env.REPLICA_ADD_HOSTS??'').split(',').filter(Boolean).flatMap(entry=>['--add-host',entry]);
 await docker(['create','--name',containerName(record.name),'--hostname',record.hostname,'--privileged','--cgroupns=private',
  '--network',env.REPLICA_NETWORK,...hosts,'-v',`${env.REPLICA_DISKS_VOLUME}:/disks`,'-e',`CANOPY_REPLICA_INSTANCE=${record.name}`,
  '--label',`canopy-replica.run=${RUN}`,'--label',`canopy-replica.pid=${env.REPLICA_OWNER_PID??''}`,'--label',`canopy-replica.instance=${record.name}`,'--memory',`${memory}m`,'--cpus',String(bundle.cpus),
  '--stop-timeout','90','--entrypoint','/usr/local/lib/canopy-replica/replica-init',env.REPLICA_HOST_IMAGE]);
 await docker(['start',containerName(record.name)]);
}
function newInstance(input,source){
 const s=load();const name=input.instanceNames?.[0];
 if(!name||input.instanceNames.length!==1)throw invalid('Exactly one instance name is supported');
 if(s.instances[name])throw invalid(`Instance ${name} already exists`);
 if(!BUNDLES[input.bundleId])throw invalid('Unknown bundle');
 const region=input.availabilityZone.slice(0,-1);
 const record={name,arn:arn('Instance',name,region),createdAt:new Date().toISOString(),bundleId:input.bundleId,blueprintId:source.blueprintId,location:{availabilityZone:input.availabilityZone,regionName:region},tags:input.tags??[],instanceId:randomUUID(),hostname:`ip-${randomUUID().slice(0,8)}`,ipAddressType:input.ipAddressType,fromSnapshot:source.snapshot??null,ports:[]};
 s.instances[name]=record;event('create-instance',{name,bundleId:record.bundleId,source:source.snapshot??source.blueprintId,userDataBytes:input.userData?.length??0});
 background(record,'pending',()=>launch(record,source.bootImage,input.userData));
 return {operations:[{resourceName:name,status:'Started'}]};
}
// Caddy on the host issues the workspace hostname's certificate from its own
// local CA (*.localhost names never qualify for a public certificate). Trust
// that root for the worker's HTTPS readiness checks, as production trusts the
// public CA. TLS still verifies the hostname.
const trusted=new Set();
async function trustHostCaddy(name){
 try{
  const {stdout}=await docker(['exec',containerName(name),'cat','/srv/canopy/caddy-state/data/caddy/pki/authorities/local/root.crt'],{timeout:5000});
  const pem=stdout.trim();if(!pem.startsWith('-----BEGIN CERTIFICATE-----')||trusted.has(pem))return;
  trusted.add(pem);setDefaultCACertificates([...getCACertificates('default'),...trusted]);
  event('trust-host-ca',{name});
 }catch{/* Caddy has not issued yet. */}
}
async function instanceView(record){
 const observed=await inspect(record.name);
 let name=record.transition;
 if(!name)name=observed?.state?.Running?'running':observed?'stopped':'pending';
 const ip=observed?.state?.Running?observed.networks?.[env.REPLICA_NETWORK]?.IPAddress||null:null;
 if(name==='running')await trustHostCaddy(record.name);
 const disks=Object.values(load().disks).filter(d=>d.attachedTo===record.name).map(d=>({name:d.name,path:d.path,sizeInGb:d.sizeInGb,isSystemDisk:false,isAttached:true,attachedTo:record.name,state:'in-use'}));
 return {name:record.name,arn:record.arn,createdAt:record.createdAt,location:record.location,resourceType:'Instance',tags:record.tags,blueprintId:record.blueprintId,bundleId:record.bundleId,state:{code:name==='running'?16:name==='stopped'?80:0,name},
  publicIpAddress:name==='running'?ip:undefined,privateIpAddress:ip??undefined,ipAddressType:record.ipAddressType,isStaticIp:false,
  hardware:{cpuCount:BUNDLES[record.bundleId].cpus,ramSizeInGb:BUNDLES[record.bundleId].memoryGiB,disks:[{name:`${record.name}-system-disk`,sizeInGb:BUNDLES[record.bundleId].diskGiB,isSystemDisk:true,path:'/dev/nvme0n1'},...disks]},
  networking:{ports:record.ports}};
}
function diskView(d){const attached=!!d.attachedTo;return {name:d.name,arn:d.arn,createdAt:d.createdAt,location:d.location,resourceType:'Disk',tags:d.tags,sizeInGb:d.sizeInGb,isSystemDisk:false,path:d.path,state:d.transition??(attached?'in-use':'available'),attachedTo:d.attachedTo??undefined,isAttached:attached,attachmentState:attached?'attached':'detached'};}
function snapshotView(s){return {name:s.name,arn:s.arn,createdAt:s.createdAt,location:s.location,resourceType:'InstanceSnapshot',tags:s.tags,state:s.transition?'pending':s.error?'error':'available',progress:s.transition?'50%':'100%',fromAttachedDisks:s.fromAttachedDisks,fromInstanceName:s.fromInstanceName,fromInstanceArn:s.fromInstanceArn,fromBlueprintId:s.fromBlueprintId,fromBundleId:s.fromBundleId,isFromAutoSnapshot:false,sizeInGb:s.sizeInGb};}

const handlers={
 async GetInstanceCommand({instanceName}){const r=load().instances[instanceName];if(!r)throw notFound(`Instance ${instanceName}`);return {instance:await instanceView(r)};},
 async GetDiskCommand({diskName}){const d=load().disks[diskName];if(!d)throw notFound(`Disk ${diskName}`);return {disk:diskView(d)};},
 async CreateDiskCommand({diskName,availabilityZone,sizeInGb,tags}){
  const s=load();if(s.disks[diskName])throw invalid(`Disk ${diskName} already exists`);
  if(!Number.isSafeInteger(sizeInGb)||sizeInGb<8||sizeInGb>16384)throw invalid('Invalid disk size');
  const region=availabilityZone.slice(0,-1);
  const d={name:diskName,arn:arn('Disk',diskName,region),createdAt:new Date().toISOString(),location:{availabilityZone,regionName:region},tags:tags??[],sizeInGb,path:'/dev/xvdf',attachedTo:null,file:`${ROOT}/disks/${diskName}.img`};
  s.disks[diskName]=d;event('create-disk',{name:diskName,sizeInGb});
  background(d,'pending',async()=>{
   mkdirSync(`${ROOT}/disks`,{recursive:true});await exec('truncate',['-s',`${sizeInGb}G`,d.file]);
   // Harness option (README: "pre-formatted new disks"): format a new disk the
   // way a first host bootstrap with no disk_name would (mkfs.ext4 -L
   // canopy-data), so scenarios can get past the new-workspace refusal below.
   if(env.REPLICA_PREFORMAT_DISKS==='1'){await exec('mkfs.ext4','-q -F -L canopy-data'.split(' ').concat(d.file),{timeout:10*60_000});event('preformat-disk',{name:diskName});}
  });
  return {operations:[{resourceName:diskName,status:'Started'}]};
 },
 async CreateInstancesCommand(input){
  if(input.blueprintId!=='ubuntu_24_04')throw invalid('Only the ubuntu_24_04 blueprint is replicated');
  return newInstance(input,{blueprintId:'ubuntu_24_04',bootImage:env.REPLICA_BLUEPRINT_IMAGE});
 },
 async CreateInstancesFromSnapshotCommand(input){
  const snap=load().snapshots[input.instanceSnapshotName];
  if(!snap)throw notFound(`Instance snapshot ${input.instanceSnapshotName}`);
  if(snap.transition)throw invalid('Instance snapshot is not available');
  if(BUNDLES[input.bundleId].diskGiB<snap.sizeInGb)throw invalid('The bundle disk is smaller than the snapshot');
  return newInstance(input,{blueprintId:snap.fromBlueprintId,bootImage:snap.file,snapshot:snap.name});
 },
 async GetInstanceSnapshotCommand({instanceSnapshotName}){const s=load().snapshots[instanceSnapshotName];if(!s)throw notFound(`Instance snapshot ${instanceSnapshotName}`);return {instanceSnapshot:snapshotView(s)};},
 async GetInstanceSnapshotsCommand(){return {instanceSnapshots:Object.values(load().snapshots).map(snapshotView)};},
 async CreateInstanceSnapshotCommand({instanceSnapshotName,instanceName,tags}){
  const s=load(),r=s.instances[instanceName];if(!r)throw notFound(`Instance ${instanceName}`);
  if(s.snapshots[instanceSnapshotName])throw invalid(`Instance snapshot ${instanceSnapshotName} already exists`);
  if((await instanceView(r)).state.name!=='stopped')throw invalid('The replica snapshots stopped instances only');
  const attached=Object.values(s.disks).filter(d=>d.attachedTo===instanceName);
  const snap={name:instanceSnapshotName,arn:arn('InstanceSnapshot',instanceSnapshotName,r.location.regionName),createdAt:new Date().toISOString(),location:r.location,tags:tags??[],fromInstanceName:instanceName,fromInstanceArn:r.arn,fromBlueprintId:r.blueprintId,fromBundleId:r.bundleId,sizeInGb:BUNDLES[r.bundleId].diskGiB,
   fromAttachedDisks:[{name:`${instanceName}-system-disk`,sizeInGb:BUNDLES[r.bundleId].diskGiB,isSystemDisk:true},...attached.map(d=>({name:d.name,sizeInGb:d.sizeInGb,isSystemDisk:false}))],file:`${ROOT}/snapshots/${instanceSnapshotName}.img`};
  s.snapshots[instanceSnapshotName]=snap;event('create-snapshot',{name:instanceSnapshotName,instanceName});
  background(snap,'pending',async()=>{mkdirSync(`${ROOT}/snapshots`,{recursive:true});await copySparse(`${instanceDir(instanceName)}/boot.img`,snap.file);});
  return {operations:[{resourceName:instanceSnapshotName,status:'Started'}]};
 },
 async DeleteInstanceSnapshotCommand({instanceSnapshotName}){
  const s=load(),snap=s.snapshots[instanceSnapshotName];if(!snap)throw notFound(`Instance snapshot ${instanceSnapshotName}`);
  if(snap.transition)throw invalid('Instance snapshot is still being created');
  delete s.snapshots[instanceSnapshotName];rmSync(snap.file,{force:true});event('delete-snapshot',{name:instanceSnapshotName});
  return {operations:[{resourceName:instanceSnapshotName,status:'Succeeded'}]};
 },
 async AttachDiskCommand({diskName,instanceName,diskPath}){
  const s=load(),d=s.disks[diskName],r=s.instances[instanceName];
  if(!d)throw notFound(`Disk ${diskName}`);if(!r)throw notFound(`Instance ${instanceName}`);
  if(d.attachedTo||d.transition)throw invalid(`Disk ${diskName} is not available`);
  if(r.transition)throw invalid(`Instance ${instanceName} is ${r.transition}`);
  d.attachedTo=instanceName;d.path=diskPath??d.path;writeAttached(instanceName);event('attach-disk',{diskName,instanceName});
  const running=(await inspect(instanceName))?.state?.Running;
  if(running)background(d,'attaching',()=>docker(['exec',containerName(instanceName),'/usr/local/lib/canopy-replica/replica-attach',diskName]));
  else save();
  return {operations:[{resourceName:diskName,status:'Started'}]};
 },
 async DetachDiskCommand({diskName}){
  const s=load(),d=s.disks[diskName];if(!d)throw notFound(`Disk ${diskName}`);
  if(!d.attachedTo)throw invalid(`Disk ${diskName} is not attached`);
  const instanceName=d.attachedTo,running=(await inspect(instanceName))?.state?.Running;
  if(running){
   try{await docker(['exec',containerName(instanceName),'/usr/local/lib/canopy-replica/replica-detach',diskName]);}
   catch(error){throw invalid(`Disk ${diskName} is in use: ${String(error.stderr||error.message).trim()}`);}
  }else await detachLoops(d.file);
  d.attachedTo=null;writeAttached(instanceName);event('detach-disk',{diskName,instanceName});
  return {operations:[{resourceName:diskName,status:'Succeeded'}]};
 },
 async DeleteDiskCommand({diskName}){
  const s=load(),d=s.disks[diskName];if(!d)throw notFound(`Disk ${diskName}`);
  if(d.attachedTo)throw invalid(`Disk ${diskName} is attached`);
  delete s.disks[diskName];rmSync(d.file,{force:true});event('delete-disk',{diskName});
  return {operations:[{resourceName:diskName,status:'Succeeded'}]};
 },
 async StartInstanceCommand({instanceName}){
  const r=load().instances[instanceName];if(!r)throw notFound(`Instance ${instanceName}`);
  if(r.transition)throw invalid(`Instance ${instanceName} is ${r.transition}`);
  event('start-instance',{instanceName});
  background(r,'pending',async()=>{writeAttached(instanceName);await docker(['start',containerName(instanceName)]);});
  return {operations:[{resourceName:instanceName,status:'Started'}]};
 },
 async StopInstanceCommand({instanceName}){
  const s=load(),r=s.instances[instanceName];if(!r)throw notFound(`Instance ${instanceName}`);
  if(r.transition)throw invalid(`Instance ${instanceName} is ${r.transition}`);
  event('stop-instance',{instanceName});
  // An EC2 stop is a clean ACPI shutdown: systemd stops every unit and
  // unmounts. Attached disks stay attached (their loop devices are released
  // with the container and recreated at the next boot).
  background(r,'stopping',async()=>{
   await collectJournal(instanceName,'before-stop');
   await docker(['stop','-t','90',containerName(instanceName)],{timeout:3*60_000});
   for(const d of Object.values(s.disks).filter(x=>x.attachedTo===instanceName))await detachLoops(d.file);
  });
  return {operations:[{resourceName:instanceName,status:'Started'}]};
 },
 async DeleteInstanceCommand({instanceName}){
  const s=load(),r=s.instances[instanceName];if(!r)throw notFound(`Instance ${instanceName}`);
  event('delete-instance',{instanceName});
  background(r,'shutting-down',async()=>{
   await collectJournal(instanceName,'before-delete');
   await docker(['rm','-f',containerName(instanceName)]).catch(()=>{});
   for(const d of Object.values(s.disks).filter(x=>x.attachedTo===instanceName)){await detachLoops(d.file);d.attachedTo=null;}
   rmSync(instanceDir(instanceName),{recursive:true,force:true});
  },()=>{delete s.instances[instanceName];});
  return {operations:[{resourceName:instanceName,status:'Started'}]};
 },
 async PutInstancePublicPortsCommand({instanceName,portInfos}){
  const r=load().instances[instanceName];if(!r)throw notFound(`Instance ${instanceName}`);
  r.ports=portInfos;save();return {operation:{resourceName:instanceName,status:'Succeeded'}};
 },
 async GetDiskSnapshotsCommand(){return {diskSnapshots:[]};},
 async DeleteDiskSnapshotCommand(){return {operations:[]};},
};
// Evidence survives the instance: every stop/delete keeps the host's journal
// and bootstrap output under /disks/evidence for the harness report.
export async function collectJournal(instanceName,label){
 const dir=`${ROOT}/evidence/${instanceName}`;mkdirSync(dir,{recursive:true});
 const capture=async(file,args)=>{try{const {stdout}=await docker(['exec',containerName(instanceName),...args],{timeout:60_000});writeFileSync(`${dir}/${label}-${file}`,stdout);}catch(error){writeFileSync(`${dir}/${label}-${file}`,String(error.stdout??'')+String(error.stderr??error.message));}};
 await capture('journal.txt',['journalctl','--no-pager','-o','short-iso-precise','-b']);
 await capture('cloud-init-output.log',['cat','/var/log/cloud-init-output.log']);
 await capture('units.txt',['systemctl','list-units','--all','--no-pager','--plain']);
 await capture('bootstrap.sh',['cat','/var/log/canopy-replica/bootstrap.sh']);
}
export async function collectAll(label){for(const name of Object.keys(load().instances))if((await inspect(name))?.state?.Running)await collectJournal(name,label);}

export class LightsailClient{
 constructor(config={}){this.config=config;}
 async send(command){
  const handler=handlers[command.constructor.name];
  if(!handler)throw awsError('InvalidInputException',`${command.constructor.name} is not replicated`);
  return handler(command.input);
 }
 destroy(){}
}

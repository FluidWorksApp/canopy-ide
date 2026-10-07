#!/usr/bin/env node
// Local managed-workspace replica: boots the real control plane (canopy-website
// at a chosen revision, with its real worker, lifecycle, bootstrap and
// readiness code) against Docker-backed stand-ins for Lightsail, Route 53 and
// S3, then drives a scenario through the same API calls the desktop app makes.
// See README.md for what is and is not identical to production.
//
//   npm run replica -- --runtime 7b23e25 --scenario resume
//   npm run replica -- --runtime path/to/workspace-host.tar.gz --flags snapshot,migrate,warmup --scenario migrate
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,cpSync,rmSync} from 'node:fs';
import {request} from 'node:https';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const HERE=dirname(fileURLToPath(import.meta.url));
const REPO=resolve(HERE,'../..');
const {values:opt}=parseArgs({options:{
 runtime:{type:'string'},image:{type:'string'},
 website:{type:'string',default:'origin/main'},'website-repo':{type:'string'},'website-dir':{type:'string'},
 flags:{type:'string',default:''},scenario:{type:'string',default:'resume'},plan:{type:'string',default:'starter'},
 keep:{type:'boolean',default:false},'timeout-minutes':{type:'string',default:'45'},cache:{type:'string'},
 'cron-seconds':{type:'string',default:'60'},help:{type:'boolean',default:false},clean:{type:'boolean',default:false},preformat:{type:'string'},'first-runtime':{type:'string'},'first-website':{type:'string'},'stale-apt-timers':{type:'boolean',default:false},'first-image':{type:'string'},
}});
const SCENARIOS=['new','resume','stop','retry','migrate'];
if(!opt.clean&&(opt.help||!opt.runtime||!SCENARIOS.includes(opt.scenario))){
 console.log(`Usage: npm run replica -- --runtime <sha|ref|workspace-host.tar.gz|artifact dir> [--image ghcr.io/...@sha256:...]
  [--website <git ref, default origin/main>] [--website-repo <canopy-website checkout>] [--website-dir <working tree>]
  [--flags snapshot,migrate,warmup] [--scenario ${SCENARIOS.join('|')}] [--plan starter] [--keep]
       npm run replica -- --clean   (remove every leftover replica run, e.g. after --keep)`);
 process.exit(opt.help?0:2);
}
const FLAGS=new Set(opt.flags.split(',').map(f=>f.trim()).filter(Boolean));
for(const f of FLAGS)if(!['snapshot','migrate','warmup'].includes(f))throw Error(`Unknown flag ${f}`);
const RUN=`${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const CACHE=resolve(opt.cache??process.env.CANOPY_REPLICA_CACHE??join(homedir(),'.cache','canopy-replica'));
const OUT=join(CACHE,'runs',RUN);mkdirSync(OUT,{recursive:true});
const NET=`canopy-replica-${RUN}`,VOLUME=`canopy-replica-${RUN}`,CACHE_VOLUME='canopy-replica-cache',REGISTRY_VOLUME='canopy-replica-registry';
const CP=`canopy-replica-${RUN}-cp`,PG=`canopy-replica-${RUN}-pg`,PROXY=`canopy-replica-${RUN}-ghcr`;
const BUCKET='canopy-replica-runtime',REGION='ap-southeast-1';
const S3_HOST=`${BUCKET}.s3.${REGION}.amazonaws.com`;
const started=Date.now();
const say=(...a)=>console.log(`[replica +${Math.round((Date.now()-started)/1000)}s]`,...a);

function run(cmd,args,{input,quiet=false,allowFail=false,cwd}={}){
 return new Promise((res,rej)=>{
  const child=spawn(cmd,args,{cwd,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>{out+=d;if(!quiet)process.stdout.write(d);});child.stderr.on('data',d=>{err+=d;if(!quiet)process.stderr.write(d);});
  if(input!==undefined){if(typeof input.pipe==='function')input.pipe(child.stdin);else child.stdin.end(input);}
  child.on('error',rej);
  child.on('close',code=>{if(code!==0&&!allowFail)rej(Object.assign(Error(`${cmd} ${args.slice(0,3).join(' ')} exited ${code}: ${err.trim().slice(-2000)}`),{code,stdout:out,stderr:err}));else res({code,stdout:out,stderr:err});});
 });
}
const docker=(args,o={})=>run('docker',args,{quiet:true,...o});
const sha256=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const hashTree=(paths,base)=>{const h=createHash('sha256');for(const p of paths.sort()){h.update(base?p.slice(base.length):p);h.update(readFileSync(p));}return h.digest('hex').slice(0,16);};
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);

// ---------------------------------------------------------------- inputs
async function localCa(){
 const dir=join(CACHE,'ca');mkdirSync(dir,{recursive:true});
 if(!existsSync(join(dir,'ca.crt'))){
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','3650','-subj','/CN=Canopy local replica CA','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.crt'),'-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],{stdio:'ignore'});
 }
 const sans=['canopyide.dev',S3_HOST,'ghcr.io'];
 const marker=join(dir,'leaf.sans');
 if(!existsSync(join(dir,'leaf.crt'))||!existsSync(marker)||readFileSync(marker,'utf8')!==sans.join(',')){
  execFileSync('openssl',['req','-newkey','rsa:2048','-nodes','-subj','/CN=canopyide.dev','-keyout',join(dir,'leaf.key'),'-out',join(dir,'leaf.csr')],{stdio:'ignore'});
  writeFileSync(join(dir,'leaf.ext'),`subjectAltName=${sans.map(s=>'DNS:'+s).join(',')}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`);
  execFileSync('openssl',['x509','-req','-in',join(dir,'leaf.csr'),'-CA',join(dir,'ca.crt'),'-CAkey',join(dir,'ca.key'),'-CAcreateserial','-days','825','-out',join(dir,'leaf.crt'),'-extfile',join(dir,'leaf.ext')],{stdio:'ignore'});
  writeFileSync(marker,sans.join(','));
 }
 execFileSync('chmod',['0644',join(dir,'leaf.key')]);
 return dir;
}
async function resolveRuntime(spec){
 let file,release=null;
 if(existsSync(spec)&&statSync(spec).isFile())file=resolve(spec);
 else if(existsSync(spec)&&statSync(spec).isDirectory())file=join(resolve(spec),'workspace-host.tar.gz');
 else{
  const sha=execFileSync('git',['-C',REPO,'rev-parse',`${spec}^{commit}`],{encoding:'utf8'}).trim();
  const dir=join(CACHE,'runtime',sha);file=join(dir,'workspace-host.tar.gz');
  if(!existsSync(file)){
   mkdirSync(dir,{recursive:true});
   const runs=JSON.parse(execFileSync('gh',['run','list','-R','FluidWorksApp/canopy-ide','-w','workspace-image.yml','-c',sha,'--json','databaseId,conclusion','-L','5'],{encoding:'utf8'}).toString()||'[]');
   const ok=runs.find(r=>r.conclusion==='success');
   if(ok){say(`downloading runtime artifact workspace-release-${sha} from run ${ok.databaseId}`);await run('gh',['run','download',String(ok.databaseId),'-R','FluidWorksApp/canopy-ide','-n',`workspace-release-${sha}`,'-D',dir]);}
   else{say(`no published artifact for ${sha}; building the runtime package from that commit`);await buildRuntime(sha,dir);}
  }
 }
 if(!existsSync(file))throw Error(`Runtime package not found: ${file}`);
 const manifestPath=join(dirname(file),'workspace-release.json');
 if(existsSync(manifestPath))release=JSON.parse(readFileSync(manifestPath,'utf8'));
 else{const {stdout}=await run('tar',['-xzOf',file,'./workspace-release.json'],{quiet:true,allowFail:true});try{release=JSON.parse(stdout);}catch{}}
 const revision=release?.revision??'0'.repeat(40);
 return {file,sha:sha256(file),key:release?.runtimeKey??`releases/${revision}/workspace-host.tar.gz`,image:release?.image??null,revision};
}
// Same packaging as workspace-image.yml's release job, for any commit or for
// the working tree (--runtime .): package-host-release.sh over that source.
async function buildRuntime(ref,dir,{image=opt.image}={}){
 const src=join(tmpdir(),`canopy-replica-src-${RUN}`);rmSync(src,{recursive:true,force:true});mkdirSync(src,{recursive:true});
 const archive=spawn('git',['-C',REPO,'archive',ref,'packages/remote-host','packages/chrome-stream','src-tauri/src/preview_picker.js']);
 await run('tar',['-x','-C',src],{input:archive.stdout,quiet:true});
 await run('node',[join(src,'packages/remote-host/prepare-browser-build.mjs')],{quiet:true});
 const lock=readFileSync(join(src,'packages/remote-host/package-lock.json'));
 const revision=execFileSync('git',['-C',REPO,'rev-parse',`${ref}^{commit}`],{encoding:'utf8'}).trim();
 const manifest={revision,runtimeLockSha256:createHash('sha256').update(lock).digest('hex'),checks:{linuxAmd64:true,linuxArm64:true},runtimeKey:`releases/${revision}/workspace-host.tar.gz`,image:image??null,channel:null,platforms:['linux/amd64','linux/arm64'],builtLocally:true};
 writeFileSync(join(dir,'workspace-release.json'),JSON.stringify(manifest,null,2));
 await run('bash',[join(src,'packages/remote-host/package-host-release.sh'),join(dir,'workspace-host.tar.gz'),join(dir,'workspace-release.json')],{quiet:true});
 rmSync(src,{recursive:true,force:true});
}
function websiteSource(target,ref=opt.website){
 const files=['api','lib','database','migrations','package.json','pnpm-lock.yaml','pnpm-workspace.yaml'];
 if(opt['website-dir']&&ref===opt.website){
  for(const f of files)cpSync(join(resolve(opt['website-dir']),f),join(target,f),{recursive:true});
  return {label:`dir:${resolve(opt['website-dir'])}`,id:hashTree(files.flatMap(f=>{const p=join(target,f);return statSync(p).isDirectory()?walk(p):[p];}),target)};
 }
 const repo=resolve(opt['website-repo']??process.env.CANOPY_WEBSITE_REPO??join(REPO,'..','canopy-website'));
 if(ref.startsWith('origin/'))execFileSync('git',['-C',repo,'fetch','-q','origin'],{stdio:'ignore'});
 const commit=execFileSync('git',['-C',repo,'rev-parse',`${ref}^{commit}`],{encoding:'utf8'}).trim();
 execFileSync('sh',['-c','git -C "$1" archive "$2" '+files.join(' ')+' | tar -x -C "$3"','sh',repo,commit,target]);
 return {label:`${ref} (${commit.slice(0,7)})`,id:commit.slice(0,16)};
}

// ---------------------------------------------------------------- images
async function buildHostImage(ca){
 const ctx=join(tmpdir(),`canopy-replica-host-${RUN}`);rmSync(ctx,{recursive:true,force:true});cpSync(join(HERE,'host'),ctx,{recursive:true});
 cpSync(join(ca,'ca.crt'),join(ctx,'replica-ca.crt'));
 const tag=`canopy-replica-host:${hashTree(walk(ctx),ctx)}`;
 if((await docker(['image','inspect',tag],{allowFail:true})).code!==0){say('building host blueprint image',tag);await docker(['build','-t',tag,ctx],{quiet:false});}
 rmSync(ctx,{recursive:true,force:true});
 return tag;
}
// The blueprint's filesystem as an ext4 boot disk image, cached per image.
async function blueprintDisk(hostImage){
 const id=(await docker(['image','inspect','--format','{{.Id}}',hostImage])).stdout.trim().replace('sha256:','').slice(0,16);
 const name=`blueprints/${id}.img`;
 await docker(['volume','create',CACHE_VOLUME]);
 if((await docker(['run','--rm','-v',`${CACHE_VOLUME}:/cache`,'--entrypoint','test',hostImage,'-f',`/cache/${name}`],{allowFail:true})).code===0)return `/cache/${name}`;
 say('creating ext4 boot disk image from',hostImage);
 const cid=(await docker(['create',hostImage])).stdout.trim();
 try{
  const exporter=spawn('docker',['export',cid]);
  await run('docker',['run','--rm','-i','-v',`${CACHE_VOLUME}:/cache`,'--entrypoint','bash',hostImage,'-c',
   `set -e; mkdir -p /cache/blueprints /r; tar -x -C /r --numeric-owner; rm -f /r/.dockerenv; t=/cache/${name}.tmp; rm -f "$t"; truncate -s 8G "$t"; mkfs.ext4 -q -L cloudimg-rootfs -d /r "$t"; mv "$t" /cache/${name}; find /cache/blueprints -name "*.img" ! -name "${id}.img" -delete`],{input:exporter.stdout,quiet:true});
 }finally{await docker(['rm','-f',cid],{allowFail:true});}
 return `/cache/${name}`;
}
async function buildControlPlane(ref=opt.website){
 const ctx=join(tmpdir(),`canopy-replica-cp-${RUN}`);rmSync(ctx,{recursive:true,force:true});mkdirSync(join(ctx,'website'),{recursive:true});
 const website=websiteSource(join(ctx,'website'),ref);
 cpSync(join(HERE,'control-plane'),join(ctx,'control-plane'),{recursive:true});
 const tag=`canopy-replica-cp:${website.id}-${hashTree(walk(join(ctx,'control-plane')),ctx)}`;
 if((await docker(['image','inspect',tag],{allowFail:true})).code!==0){say('building control plane image for website',website.label);await docker(['build','-f',join(ctx,'control-plane','Dockerfile'),'-t',tag,ctx],{quiet:false});}
 rmSync(ctx,{recursive:true,force:true});
 return {tag,label:website.label};
}

// ---------------------------------------------------------------- stack
const secrets={auth:randomBytes(32).toString('hex'),signing:randomBytes(32).toString('hex'),cron:randomBytes(24).toString('hex'),admin:randomBytes(24).toString('hex'),device:randomBytes(48).toString('base64url')};
let cpPort,caPem,cpImage,state={};
function cpEnv(flags){
 const e={
  CANOPY_DATABASE_URL:'postgres://postgres:replica@postgres:5432/canopy',CANOPY_AUTH_SECRET:secrets.auth,CANOPY_AUTH_URL:'https://canopyide.dev',
  CANOPY_WORKSPACE_SIGNING_SECRET:secrets.signing,CANOPY_WORKSPACE_DOMAIN:'replica.localhost',CANOPY_WORKSPACE_DNS_ZONE:'ZREPLICALOCAL',
  CANOPY_COMPUTE_ACCESS_KEY_ID:'AKIAREPLICALOCAL0000',CANOPY_COMPUTE_SECRET_ACCESS_KEY:'replica-local-not-a-secret',
  CANOPY_RUNTIME_BUCKET:BUCKET,CANOPY_RUNTIME_REGION:REGION,CANOPY_RUNTIME_KEY:state.runtime.key,CANOPY_RUNTIME_SHA256:state.runtime.sha,
  CANOPY_WORKSPACE_IMAGE:state.image,CRON_SECRET:secrets.cron,
  REPLICA_RUN:RUN,REPLICA_NETWORK:NET,REPLICA_DISKS_VOLUME:VOLUME,REPLICA_HOST_IMAGE:state.hostImage,REPLICA_BLUEPRINT_IMAGE:state.blueprint,
  REPLICA_RUNTIME_FILE:'/replica-data/runtime.tgz',REPLICA_ADMIN_TOKEN:secrets.admin,REPLICA_ADD_HOSTS:`ghcr.io:${state.proxyIp}`,
  REPLICA_CRON_SECONDS:opt['cron-seconds'],REPLICA_MAX_MEMORY_MIB:String(state.maxMemoryMiB),REPLICA_STALE_APT_TIMERS:opt['stale-apt-timers']?'1':'0',REPLICA_PREFORMAT_DISKS:(opt.preformat??(opt.scenario==='new'?'0':'1'))==='1'?'1':'0',REPLICA_DEVICE_TOKEN:secrets.device,NODE_EXTRA_CA_CERTS:'/replica-ca/ca.crt',
 };
 if(flags.has('snapshot'))e.CANOPY_SNAPSHOT_STORAGE='1';
 if(flags.has('migrate'))e.CANOPY_SNAPSHOT_STORAGE_MIGRATE='1';
 if(flags.has('warmup'))e.CANOPY_HOST_WARMUP='1';
 return Object.entries(e).flatMap(([k,v])=>['-e',`${k}=${v}`]);
}
async function startControlPlane(flags){
 await docker(['rm','-f',CP],{allowFail:true});
 await docker(['run','-d','--name',CP,'--privileged','--network',NET,'--network-alias','canopyide.dev','--network-alias',S3_HOST,
  '--label',`canopy-replica.run=${RUN}`,'-v','/var/run/docker.sock:/var/run/docker.sock','-v',`${VOLUME}:/disks`,'-v',`${CACHE_VOLUME}:/cache:ro`,
  '-v',`${state.ca}:/replica-ca:ro`,'-v',`${state.runtime.file}:/replica-data/runtime.tgz:ro`,'-p','127.0.0.1::443',...cpEnv(flags),cpImage]);
 cpPort=Number((await docker(['port',CP,'443/tcp'])).stdout.trim().split('\n')[0].split(':').pop());
 for(let i=0;i<60;i++){try{await api('GET','/api/plans');say(`control plane up (flags: ${[...flags].join(',')||'none'})`);return;}catch{await new Promise(r=>setTimeout(r,1000));}}
 throw Error('Control plane did not start:\n'+(await docker(['logs','--tail','80',CP],{allowFail:true})).stderr);
}
async function setup(){
 state.ca=await localCa();caPem=readFileSync(join(state.ca,'ca.crt'));
 state.runtime=await resolveRuntime(opt.runtime);
 state.image=opt.image??state.runtime.image;
 if(!state.image)throw Error('No workspace image: pass --image (the runtime package has no release manifest image)');
 say(`runtime ${state.runtime.key} sha256 ${state.runtime.sha.slice(0,12)}…  image ${state.image}`);
 state.hostImage=await buildHostImage(state.ca);
 state.blueprint=await blueprintDisk(state.hostImage);
 const cp=await buildControlPlane();cpImage=cp.tag;state.website=cp.label;
 const memTotal=Number((await docker(['info','--format','{{.MemTotal}}'])).stdout.trim());
 state.maxMemoryMiB=Math.max(2048,Math.floor(memTotal/1048576)-1536);
 state.swappiness=(await docker(['run','--rm','--entrypoint','cat',state.hostImage,'/proc/sys/vm/swappiness'])).stdout.trim();
 await docker(['network','create','--label',`canopy-replica.run=${RUN}`,NET]);
 await docker(['volume','create','--label',`canopy-replica.run=${RUN}`,VOLUME]);
 await docker(['volume','create',REGISTRY_VOLUME]);
 // Local stand-in for ghcr.io: a plain registry holding exact copies (same
 // manifests and digests) of the release image, seeded once per image and kept
 // in a volume, so the host's `docker pull <image@digest>` is the production
 // call but reads local disk. Only seeded images are pullable.
 await docker(['run','-d','--name',PROXY,'--network',NET,'--label',`canopy-replica.run=${RUN}`,
  '-v',`${REGISTRY_VOLUME}:/var/lib/registry`,'-v',`${state.ca}:/certs:ro`,'-e','REGISTRY_HTTP_ADDR=0.0.0.0:443',
  '-e','REGISTRY_HTTP_TLS_CERTIFICATE=/certs/leaf.crt','-e','REGISTRY_HTTP_TLS_KEY=/certs/leaf.key','-e','REGISTRY_LOG_LEVEL=warn','-e','REGISTRY_VALIDATION_DISABLED=true','registry:3']);
 state.proxyIp=(await docker(['inspect','--format',`{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,PROXY])).stdout.trim();
 await warmImage();
 await docker(['run','-d','--name',PG,'--network',NET,'--network-alias','postgres','--label',`canopy-replica.run=${RUN}`,'-e','POSTGRES_PASSWORD=replica','-e','POSTGRES_DB=canopy','--tmpfs','/var/lib/postgresql/data','postgres:17-alpine']);
 await docker(['run','--rm','--network',NET,...cpEnv(new Set()),cpImage,'node','/replica/db.mjs'],{quiet:false});
}
// Copy the release image (index + this machine's platform manifest and its
// layers) from ghcr.io into the local registry, digests preserved. Blobs that
// are already present are skipped, so later runs only verify.
async function warmImage(){
 const arch=(await docker(['info','--format','{{.Architecture}}'])).stdout.trim().replace('aarch64','arm64').replace('x86_64','amd64');
 const [repo,digest]=state.image.split('@');const path=repo.replace(/^ghcr\.io\//,'');
 if(!repo.startsWith('ghcr.io/')||!digest)throw Error('The replica seeds ghcr.io images pinned by digest');
 say(`seeding local ghcr.io with ${state.image} (${arch})`);
 const skopeo=args=>docker(['run','--rm','--network',NET,'quay.io/skopeo/stable:v1.16',...args],{quiet:false});
 const raw=JSON.parse((await docker(['run','--rm','quay.io/skopeo/stable:v1.16','inspect','--retry-times','5','--raw',`docker://${state.image}`])).stdout);
 const platform=raw.manifests?.find(m=>m.platform?.architecture===arch&&m.platform?.os==='linux')?.digest;
 const copy=(src,tag,extra=[])=>skopeo(['copy','--retry-times','10','--preserve-digests','--dest-tls-verify=false',...extra,`docker://${src}`,`docker://${state.proxyIp}/${path}:${tag}`]);
 if(platform){
  await copy(`${repo}@${platform}`,`replica-${arch}`);
  // Docker's containerd store also fetches the platform's attestation manifest.
  for(const m of raw.manifests.filter(x=>x.annotations?.['vnd.docker.reference.digest']===platform))await copy(`${repo}@${m.digest}`,`replica-${arch}-attestation`);
  await copy(state.image,'replica-index',['--multi-arch','index-only']);
 }
 else await copy(state.image,`replica-${arch}`);
 say('local ghcr.io seeded');
}
async function cleanup(run=RUN){
 if(opt.keep&&run===RUN){say(`--keep: leaving run ${RUN} (containers labelled canopy-replica.run=${RUN}, volume ${VOLUME})`);return;}
 const ids=(await docker(['ps','-aq','--filter',`label=canopy-replica.run=${run}`],{allowFail:true})).stdout.split('\n').filter(Boolean);
 // Clean shutdown first so hosts unmount their disks, then remove.
 const hosts=(await docker(['ps','-q','--filter',`label=canopy-replica.instance`,'--filter',`label=canopy-replica.run=${run}`],{allowFail:true})).stdout.split('\n').filter(Boolean);
 if(hosts.length)await docker(['stop','-t','30',...hosts],{allowFail:true});
 if(ids.length)await docker(['rm','-f','-v',...ids],{allowFail:true});
 if(state.hostImage){
  await docker(['run','--rm','--privileged','-v',`canopy-replica-${run}:/disks`,'--entrypoint','bash',state.hostImage,'-c',
   'for f in $(find /disks -name "*.img" 2>/dev/null); do for d in $(losetup -j "$f" | cut -d: -f1); do n=${d#/dev/loop}; [ -e "$d" ] || mknod "$d" b 7 "$n"; losetup -d "$d" || true; done; done'],{allowFail:true});
  if(state.swappiness)await docker(['run','--rm','--privileged','--entrypoint','sh',state.hostImage,'-c',`echo ${state.swappiness} > /proc/sys/vm/swappiness`],{allowFail:true});
 }
 await docker(['volume','rm',`canopy-replica-${run}`],{allowFail:true});
 await docker(['network','rm',`canopy-replica-${run}`],{allowFail:true});
 say('cleaned up run',run);
}
async function cleanStale(){
 const images=(await docker(['images','--format','{{.Repository}}:{{.Tag}}','canopy-replica-host'])).stdout.split('\n').filter(Boolean);
 state.hostImage=images[0];
 const labels=async kind=>(await docker([kind,'ls','--format','{{.Label "canopy-replica.run"}}'],{allowFail:true})).stdout.split('\n');
 const runs=new Set([...(await docker(['ps','-a','--format','{{.Label "canopy-replica.run"}}'])).stdout.split('\n'),...await labels('volume'),...await labels('network')].filter(r=>/^[a-z0-9]+$/.test(r)));
 for(const run of runs)await cleanup(run);
 if(!runs.size)say('no leftover replica runs');
}

// ---------------------------------------------------------------- API (desktop app calls)
function api(method,path,body){
 return new Promise((res,rej)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=request({host:'127.0.0.1',port:cpPort,path,method,servername:'canopyide.dev',ca:caPem,timeout:120000,headers:{host:'canopyide.dev',authorization:`Bearer ${secrets.device}`,...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},r=>{
   let text='';r.on('data',c=>text+=c);r.on('end',()=>{let json;try{json=JSON.parse(text);}catch{json=text;}if(r.statusCode>=400)rej(Object.assign(Error(`${method} ${path} ${r.statusCode}: ${text.slice(0,500)}`),{status:r.statusCode,body:json}));else res(json);});
  });req.on('error',rej);req.on('timeout',()=>req.destroy(Error('API timeout')));if(data)req.write(data);req.end();
 });
}
function admin(path,method='GET'){
 return new Promise((res,rej)=>{const req=request({host:'127.0.0.1',port:cpPort,path,method,servername:'canopyide.dev',ca:caPem,timeout:300000,headers:{host:'canopyide.dev','x-replica-token':secrets.admin}},r=>{let t='';r.on('data',c=>t+=c);r.on('end',()=>{try{res(JSON.parse(t));}catch{res(t);}});});req.on('error',rej);req.end();});
}
const psql=async sql=>(await docker(['exec',PG,'psql','-U','postgres','-d','canopy','-At','-F','\t','-c',sql])).stdout.trim();
async function operationRow(workspaceId){
 const row=await psql(`SELECT id,action,status,phase,coalesce(last_error,''),coalesce(context->'bootstrapReport','null'::jsonb)::text FROM workspace_operation WHERE workspace_id='${workspaceId}' ORDER BY created_at DESC LIMIT 1`);
 if(!row)return null;const [id,action,status,phase,lastError,report]=row.split('\t');return {id,action,status,phase,lastError,report:JSON.parse(report)};
}
class ScenarioFailure extends Error{constructor(message,detail){super(message);this.detail=detail;}}
async function createWorkspace(name){
 const created=await api('POST','/api/workspaces',{name,planId:opt.plan,regionId:REGION});
 say('created workspace',created.id??created.workspace?.id,JSON.stringify(created).slice(0,200));
 return created.id??created.workspace?.id;
}
async function operate(workspaceId,action,extra={}){
 const result=await api('POST','/api/operations',{workspaceId,action,requestKey:randomUUID(),...extra});
 say(`requested ${action}:`,JSON.stringify(result).slice(0,300));return result;
}
// The desktop app's loop (ManagedWorkspaces.tsx): advance, then read status.
async function waitFor(workspaceId,goal,{minutes=Number(opt['timeout-minutes'])}={}){
 const deadline=Date.now()+minutes*60000;let last='';
 while(Date.now()<deadline){
  try{await api('POST','/api/operations',{workspaceId,action:'advance'});}catch(error){if(error.status!==409)say('advance:',error.message);}
  const status=await api('POST','/api/workspaces',{action:'status',id:workspaceId});
  const w=(status.workspaces??[]).find(x=>x.id===workspaceId);
  const op=await operationRow(workspaceId);
  const line=`state=${w?.state} op=${op?.action}/${op?.status}/${op?.phase}${op?.report?` report=${op.report.stage}:${op.report.status}`:''}${op?.lastError?` error="${op.lastError}"`:''}`;
  if(line!==last){say(line);last=line;}
  if(w?.state===goal&&(!op||op.status==='succeeded'))return {w,op};
  if(op?.status==='failed'||w?.state==='error')throw new ScenarioFailure(`${op?.action} failed in phase ${op?.phase}${op?.report?` (bootstrap stage ${op.report.stage}: ${op.report.status})`:''}: ${op?.lastError}`,{op,w});
  await new Promise(r=>setTimeout(r,3000));
 }
 const op=await operationRow(workspaceId);
 throw new ScenarioFailure(`timed out waiting for ${goal}; last ${last}`,{op});
}
async function connect(workspaceId){
 const result=await api('POST','/api/operations',{workspaceId,action:'connect',clientId:randomUUID()});
 if(!result.connection?.endpoint||!result.connection?.token)throw new ScenarioFailure('connect returned no workspace connection',{result});
 say('desktop connect ok:',result.connection.endpoint);
}
async function startAndCheck(id,label){await operate(id,'resume');await waitFor(id,'ready');await connect(id);say(`${label}: ready`);}
async function stopAndCheck(id,label){await operate(id,'hibernate',{confirmInterrupt:true});await waitFor(id,'stopped');say(`${label}: stopped`);}

const scenarios={
 async new(){const id=await createWorkspace('Replica new');await startAndCheck(id,'new workspace');},
 async stop(){const id=await createWorkspace('Replica stop');await startAndCheck(id,'first start');await stopAndCheck(id,'stop');},
 // An existing workspace (its retained disk holds a previous host's state and
 // container) is started again: the production path of every daily resume.
 async resume(){const id=await createWorkspace('Replica resume');await startAndCheck(id,'first start');await stopAndCheck(id,'stop');await startAndCheck(id,'resume of existing workspace');},
 // A failed start is retried from the app (Retry button: action 'retry'),
 // which replaces a host whose bootstrap never reached management services.
 // --first-runtime runs the first start on another release (e.g. a broken
 // one) and switches the control plane to --runtime before the retry, as a
 // production rollout of a fix would.
 async retry(){
  const fixed=state.runtime,fixedImage=state.image;
  const fixedCp=cpImage;
  if(opt['first-runtime']){state.runtime=await resolveRuntime(opt['first-runtime']);state.image=opt['first-image']??state.runtime.image??state.image;if(state.image!==fixedImage)await warmImage();}
  if(opt['first-website'])cpImage=(await buildControlPlane(opt['first-website'])).tag;
  if(opt['first-runtime']||opt['first-website']){say(`first start on runtime ${state.runtime.key} and website ${opt['first-website']??opt.website}`);await startControlPlane(FLAGS);}
  const id=await createWorkspace('Replica retry');
  try{await startAndCheck(id,'first start');say('first start succeeded; nothing to retry');return;}
  catch(error){if(!(error instanceof ScenarioFailure))throw error;say('first start failed as expected for retry:',error.message);await evidence('before-retry');}
  if(opt['first-runtime']||opt['first-website']){state.runtime=fixed;state.image=fixedImage;cpImage=fixedCp;say('switching the control plane to the fixed release before Retry');await startControlPlane(FLAGS);}
  await operate(id,'retry');await waitFor(id,'ready');await connect(id);
 },
 // Retained-disk workspace (flags off) moves to snapshot storage when started
 // with the flags on; then a stop saves the first snapshot and a start restores.
 async migrate(){
  if(!FLAGS.has('snapshot')||!FLAGS.has('migrate'))throw Error('--scenario migrate needs --flags snapshot,migrate');
  await startControlPlane(new Set());
  const id=await createWorkspace('Replica migrate');await startAndCheck(id,'retained-disk start (flags off)');await stopAndCheck(id,'retained-disk stop');
  await startControlPlane(FLAGS);
  await startAndCheck(id,'migrating start (flags on)');
  await stopAndCheck(id,'first snapshot stop');
  await startAndCheck(id,'start from snapshot');
 },
};

async function evidence(label){
 try{await admin(`/__replica/collect?label=${encodeURIComponent(label)}`,'POST');}catch{}
 const dir=join(OUT,'evidence');mkdirSync(dir,{recursive:true});
 await docker(['cp',`${CP}:/disks/evidence/.`,dir],{allowFail:true});
 writeFileSync(join(OUT,'control-plane.log'),(await docker(['logs',CP],{allowFail:true})).stdout+(await docker(['logs',CP],{allowFail:true})).stderr);
 try{writeFileSync(join(OUT,'provider-events.json'),JSON.stringify(await admin('/__replica/events'),null,1));}catch{}
 try{writeFileSync(join(OUT,'operations.tsv'),await psql("SELECT workspace_id,action,status,phase,attempts,last_error,context::text,created_at,updated_at FROM workspace_operation ORDER BY created_at"));}catch{}
 return dir;
}
const RELEVANT=/EACCES|EPERM|ENOSPC|failed|error|Error|denied|containerd|canopy-host|exited|status=|Main process|Start request repeated/;
function summarizeEvidence(dir){
 const lines=[];
 for(const instance of existsSync(dir)?readdirSync(dir):[]){
  for(const file of readdirSync(join(dir,instance)).sort()){
   const text=readFileSync(join(dir,instance,file),'utf8');
   if(file.endsWith('cloud-init-output.log')){lines.push(`--- ${instance}/${file} (last 40 lines)`,...text.trimEnd().split('\n').slice(-40));}
   if(file.endsWith('journal.txt')){
    const hits=text.split('\n').filter(l=>/canopy-host|containerd|dockerd|canopy-|cloud-init|bootstrap/.test(l)&&RELEVANT.test(l));
    lines.push(`--- ${instance}/${file} (${hits.length} relevant lines, last 60)`,...hits.slice(-60));
   }
  }
 }
 return lines.join('\n');
}

if(opt.clean){await cleanStale();process.exit(0);}
let exitCode=0;
try{
 say(`run ${RUN}: scenario=${opt.scenario} flags=${[...FLAGS].join(',')||'none'} runtime=${opt.runtime} website=${opt['website-dir']??opt.website}`);
 await setup();
 say('website',state.website);
 if(opt.scenario!=='migrate')await startControlPlane(FLAGS);
 await scenarios[opt.scenario]();
 await evidence('final');
 say(`PASS scenario ${opt.scenario} (${Math.round((Date.now()-started)/60000)} min). Evidence: ${OUT}`);
}catch(error){
 exitCode=1;
 console.error(`\n[replica] FAIL scenario ${opt.scenario}: ${error.message}`);
 if(cpPort){
  const dir=await evidence('failure');
  const summary=summarizeEvidence(dir);writeFileSync(join(OUT,'summary.txt'),`${error.message}\n\n${summary}\n`);
  console.error(summary);
 }
 console.error(`[replica] evidence: ${OUT}`);
}finally{
 try{await cleanup();}catch(error){console.error('[replica] cleanup:',error.message);}
}
process.exit(exitCode);

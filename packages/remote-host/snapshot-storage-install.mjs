// Installs the snapshot-storage units on a managed host and mounts user
// storage. Run as root by the bootstrap (snapshot storage mode only), with
// Docker and containerd stopped. Idempotent: every unit is rewritten, the
// quota image is created once and only ever grown.
import {chmod,mkdir,writeFile} from 'node:fs/promises';
import {BINARIES} from './warmup.mjs';
import {IMAGE_PATH,MOUNT_POINT,ensureUserStorage,runner,validStorageGib} from './user-storage.mjs';
import {REQUEST_FILE} from './storage-prep.mjs';

const quoteList=list=>list.map(path=>{if(!/^\/[A-Za-z0-9_./-]+$/.test(path))throw Error('Unsafe warm-up path');return path;}).join(' ');
export function units(node='/usr/bin/node'){
 if(!/^\/[A-Za-z0-9_./-]+$/.test(node))throw Error('Node executable path is not service compatible');
 return {
  // Before the runtimes: Docker's volume directory must be the quota image.
  'canopy-user-storage.service':`[Unit]
Description=Canopy user storage (quota image for workspace volumes)
DefaultDependencies=no
After=local-fs.target canopy-warmup-early.service
Wants=canopy-warmup-early.service
Before=containerd.service docker.service canopy-host.service canopy-warmup.service
RequiresMountsFor=${IMAGE_PATH.replace(/\/[^/]+$/,'')} /srv/canopy
ConditionPathExists=${IMAGE_PATH}
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${node} /opt/canopy-host/user-storage.mjs mount
TimeoutStartSec=20min
[Install]
WantedBy=multi-user.target
`,
  'docker.service.d/canopy-user-storage.conf':`[Unit]
Requires=canopy-user-storage.service
After=canopy-user-storage.service
`,
  'containerd.service.d/canopy-user-storage.conf':`[Unit]
Requires=canopy-user-storage.service
After=canopy-user-storage.service
`,
  // (a) of the warm-up, in parallel before the daemons read their binaries
  // one lazy block at a time. Bounded; a timeout never blocks boot.
  'canopy-warmup-early.service':`[Unit]
Description=Canopy early warm-up of service binaries
DefaultDependencies=no
After=local-fs.target
Before=canopy-user-storage.service containerd.service docker.service caddy.service canopy-host.service
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'for f in ${quoteList(BINARIES)}; do [ -f "$f" ] && cat "$f" >/dev/null 2>&1 & done; find /opt/canopy-host -xdev -type f -size -64M -exec cat {} + >/dev/null 2>&1 & wait; exit 0'
TimeoutStartSec=60
[Install]
WantedBy=multi-user.target
`,
  // (b)-(d): never ordered before anything, so readiness does not wait.
  'canopy-warmup.service':`[Unit]
Description=Canopy warm-up of workspace files restored from a snapshot
After=canopy-user-storage.service canopy-warmup-early.service
[Service]
Type=simple
ExecStart=${node} /opt/canopy-host/warmup.mjs run
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
MemoryMax=256M
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
`,
  'canopy-storage-prep.path':`[Unit]
Description=Canopy stop preparation request
[Path]
PathExists=${REQUEST_FILE}
Unit=canopy-storage-prep.service
[Install]
WantedBy=multi-user.target
`,
  'canopy-storage-prep.service':`[Unit]
Description=Canopy stop preparation (quiesce, trim, release swap)
[Service]
Type=oneshot
ExecStart=${node} /opt/canopy-host/storage-prep.mjs
TimeoutStartSec=15min
`,
 };
}
export const ENABLE=Object.freeze(['canopy-user-storage.service','canopy-warmup-early.service','canopy-warmup.service','canopy-storage-prep.path','fstrim.timer']);

// Retained-disk layout (today): warm-up, stop preparation and periodic trim
// only. No quota image, no ordering change for Docker or containerd.
export const UNITS_ONLY=Object.freeze(['canopy-warmup-early.service','canopy-warmup.service','canopy-storage-prep.path','canopy-storage-prep.service']);
// Unit files hold no secrets: 0644 like every packaged unit. The bootstrap runs
// with umask 077, which would turn writeFile's 0644 into 0600 and make systemd
// warn "marked world-inaccessible" on every reload, so the mode is set
// explicitly. Drop-in directories likewise get 0755.
async function writeUnit(path,text,{write,setMode}){await write(path,text,{mode:0o644});await setMode(path,0o644);}
export async function installUnits({run=runner(),write=writeFile,setMode=chmod,root='/etc/systemd/system',node=process.execPath,startWarmup=false}={}){
 const files=units(node);
 for(const name of UNITS_ONLY)await writeUnit(`${root}/${name}`,files[name],{write,setMode});
 const must=async args=>{const r=await run('systemctl',args,{timeout:60000});if(r.code!==0)throw Error(`systemctl ${args[0]} failed`);};
 await must(['daemon-reload']);
 await must(['enable','canopy-warmup-early.service','canopy-warmup.service','canopy-storage-prep.path','fstrim.timer']);
 await must(['start','canopy-storage-prep.path']);
 if(startWarmup)await must(['start','--no-block','canopy-warmup.service']);
 return {units:[...UNITS_ONLY]};
}
export async function install(storageGib,{run=runner(),write=writeFile,makeDir=mkdir,setMode=chmod,root='/etc/systemd/system',node=process.execPath,ensure=ensureUserStorage}={}){
 const gib=validStorageGib(storageGib);
 const files=units(node);
 for(const [name,text] of Object.entries(files)){
  if(name.includes('/')){const dir=`${root}/${name.split('/')[0]}`;await makeDir(dir,{recursive:true,mode:0o755});await setMode(dir,0o755);}
  await writeUnit(`${root}/${name}`,text,{write,setMode});
 }
 const storage=await ensure(gib,{run});
 const must=async args=>{const r=await run('systemctl',args,{timeout:60000});if(r.code!==0)throw Error(`systemctl ${args[0]} failed`);};
 await must(['daemon-reload']);
 // Weekly fstrim.timer (Ubuntu default, made explicit) covers long-running
 // hosts; the stop preparation trims before every snapshot. No `discard`
 // mount option: online discard on every unlink slows deletes (node_modules
 // churn) and turns each into a hole punch in the image file.
 await must(['enable',...ENABLE]);
 await must(['start','canopy-storage-prep.path']);
 return {storage,mountPoint:MOUNT_POINT,units:Object.keys(files)};
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 try{process.stdout.write(JSON.stringify(process.argv[2]==='--units-only'?await installUnits({startWarmup:process.argv[3]==='--start-warmup'}):await install(process.argv[2]))+'\n');}
 catch(error){process.stderr.write(`${error.message}\n`);process.exit(1);}
}

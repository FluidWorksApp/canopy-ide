import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GIB,IMAGE_PATH,MOUNT_POINT,ensureUserStorage,mountUserStorage,migrateLegacyStorage,storageLevel,storageUsage,validStorageGib} from './user-storage.mjs';
import {prepareForSnapshot,runRequested,readRequest,trimmedBytes,SWAP_FILE} from './storage-prep.mjs';
import {usedExtents,planWarmup,runWarmup,progressView,parseFincore,captureRecentFiles,captureStartupFiles,PHASES} from './warmup.mjs';
import {hostStorage,publicPrepStatus,publicWarmup} from './host-storage.mjs';
import {units,install,ENABLE} from './snapshot-storage-install.mjs';
import {createGateway} from './gateway.mjs';
import {digest} from './policy.mjs';

// A scripted command runner: records calls and answers from a table.
function fakeRun(answers={}){
 const calls=[];
 const run=async(command,args=[])=>{const line=[command,...args].join(' ');calls.push(line);for(const [pattern,answer] of Object.entries(answers)){if(line.startsWith(pattern))return typeof answer==='function'?answer(line):{code:0,stdout:'',stderr:'',...answer};}return {code:0,stdout:'',stderr:''};};
 return {run,calls};
}
const enoent=()=>Object.assign(Error('missing'),{code:'ENOENT'});

test('quota sizes are limited to the advertised plan sizes and levels warn at 80% and 95%',async()=>{
 for(const gib of [50,100,200,500])assert.equal(validStorageGib(gib),gib);
 for(const bad of [0,49,51,1000,'50; rm -rf /',null,1.5])assert.throws(()=>validStorageGib(bad));
 assert.equal(storageLevel(79,100),'ok');assert.equal(storageLevel(80,100),'warning');assert.equal(storageLevel(95,100),'critical');assert.equal(storageLevel(1,0),'unknown');
 const usage=await storageUsage({advertisedGib:50,statFs:async()=>({blocks:13107200,bfree:2621440,bavail:2621440,bsize:4096})});
 assert.equal(usage.capacityBytes,50*GIB);assert.equal(usage.usedBytes,(13107200-2621440)*4096);assert.equal(usage.level,'warning');assert.equal(usage.percent,80);
});

test('user storage is created sparse, formatted once without a root reservation, and mounted with direct I/O and noatime',async()=>{
 const {run,calls}=fakeRun({'losetup --noheadings':{stdout:''},'losetup --find':{stdout:'/dev/loop7\n'},'findmnt':{code:1}});
 const truncated=[];const fs={mkdir:async()=>{},stat:async()=>{throw enoent();},readdir:async()=>[],rename:async()=>{throw Error('nothing to carry');},rm:async()=>{},open:async(path,flags,mode)=>{assert.equal(path,IMAGE_PATH);assert.equal(flags,'wx');assert.equal(mode,0o600);return {truncate:async n=>truncated.push(n),close:async()=>{}};}};
 const result=await ensureUserStorage(100,{run,fs});
 assert.deepEqual(truncated,[100*GIB]);assert.equal(result.created,true);assert.equal(result.device,'/dev/loop7');
 assert.ok(calls.includes(`mkfs.ext4 -q -F -m 0 -L canopy-user ${IMAGE_PATH}`));
 assert.ok(calls.includes(`losetup --find --show --direct-io=on --nooverlap ${IMAGE_PATH}`));
 assert.ok(calls.includes(`mount -t ext4 -o noatime /dev/loop7 ${MOUNT_POINT}`));
 assert.ok(calls.indexOf('e2fsck -p /dev/loop7')<calls.findIndex(c=>c.startsWith('mount ')));
});

test('a bigger plan grows the image online; a smaller plan never shrinks it; volumes already on root are carried in',async()=>{
 const grow=fakeRun({'losetup --noheadings':{stdout:'/dev/loop3\n'},'findmnt':{stdout:'/dev/loop3\n'}});
 const sizes=[];const file={isFile:()=>true};
 const fs=size=>({mkdir:async()=>{},stat:async()=>({...file,size}),readdir:async()=>[],rename:async()=>{},rm:async()=>{},open:async()=>({truncate:async n=>sizes.push(n),close:async()=>{}})});
 const grown=await ensureUserStorage(200,{run:grow.run,fs:fs(100*GIB)});
 assert.equal(grown.grown,true);assert.deepEqual(sizes,[200*GIB]);
 assert.deepEqual(grow.calls.filter(c=>/^(losetup --set|resize2fs|mkfs)/.test(c)),['losetup --set-capacity /dev/loop3','resize2fs /dev/loop3']);
 const shrink=fakeRun({'losetup --noheadings':{stdout:'/dev/loop3\n'},'findmnt':{stdout:'/dev/loop3\n'}});
 const refused=await ensureUserStorage(50,{run:shrink.run,fs:fs(100*GIB)});
 assert.equal(refused.shrinkRefused,true);assert.equal(shrink.calls.some(c=>/resize2fs|mkfs|truncate/.test(c)),false);
 const carry=fakeRun({'losetup --noheadings':{stdout:''},'losetup --find':{stdout:'/dev/loop1\n'},'findmnt':{code:1}});
 const moves=[],removed=[];
 await ensureUserStorage(50,{run:carry.run,fs:{mkdir:async()=>{},stat:async()=>{throw enoent();},readdir:async()=>['metadata.db'],rename:async(a,b)=>moves.push([a,b]),rm:async p=>removed.push(p),open:async()=>({truncate:async()=>{},close:async()=>{}})}});
 assert.equal(moves[0][0],MOUNT_POINT);assert.ok(carry.calls.some(c=>c.startsWith(`cp -a --sparse=always ${moves[0][1]}/.`)));assert.deepEqual(removed,[moves[0][1]]);
});

test('mount refuses a filesystem that needs a manual repair and never stacks a second mount',async()=>{
 const broken=fakeRun({'losetup --noheadings':{stdout:'/dev/loop2\n'},'findmnt':{code:1},'e2fsck':{code:4}});
 await assert.rejects(mountUserStorage({run:broken.run,fs:{mkdir:async()=>{}}}),/repair/);assert.equal(broken.calls.some(c=>c.startsWith('mount ')),false);
 const other=fakeRun({'losetup --noheadings':{stdout:'/dev/loop2\n'},'findmnt':{stdout:'/dev/nvme1n1\n'}});
 await assert.rejects(mountUserStorage({run:other.run,fs:{mkdir:async()=>{}}}),/Another filesystem/);
 const same=fakeRun({'losetup --noheadings':{stdout:'/dev/loop2\n'},'findmnt':{stdout:'/dev/loop2\n'}});
 assert.deepEqual(await mountUserStorage({run:same.run,fs:{mkdir:async()=>{}}}),{device:'/dev/loop2',mounted:false});
});

test('legacy disk migration moves only user files: volumes into the quota image and host state onto root, never images or containers',async()=>{
 const uuid='0c8a1b2e-0000-4000-8000-000000000001';
 const {run,calls}=fakeRun({'findmnt --noheadings --output UUID':{stdout:uuid+'\n'},'findmnt --noheadings --output OPTIONS':{stdout:'ro,relatime\n'},'du -sx --block-size=1 /mnt/legacy/docker/volumes':{stdout:'1000\t/x\n'},'du -sx --block-size=1 /mnt/legacy/':{stdout:'10\t/x\n'}});
 let marker=null;const made=[];
 const listing={'/mnt/legacy':['containerd','docker','host-state','caddy-state','recovery-state','lost+found'],'/mnt/legacy/docker':['overlay2','volumes','image','containers','network','buildkit'],'/mnt/legacy/host-state':['host-config.json','host.key','projects','image-upgrades','storage-prep-request.json','migrations']};
 const fs={readdir:async dir=>listing[dir]??[],readFile:async()=>{if(!marker)throw enoent();return marker;},writeFile:async(_,text)=>{marker=text;},mkdir:async dir=>{made.push(dir);},statfs:async()=>({blocks:1e9,bfree:5e8,bavail:1e9,bsize:4096})};
 const result=await migrateLegacyStorage('/mnt/legacy',{run,fs});
 assert.equal(result.copied,true);
 const copies=calls.filter(c=>c.startsWith('cp '));
 assert.deepEqual(copies,[
  'cp -a --sparse=always /mnt/legacy/host-state/host-config.json /srv/canopy/host-state/',
  'cp -a --sparse=always /mnt/legacy/host-state/host.key /srv/canopy/host-state/',
  'cp -a --sparse=always /mnt/legacy/host-state/projects /srv/canopy/host-state/',
  'cp -a --sparse=always /mnt/legacy/host-state/migrations /srv/canopy/host-state/',
  'cp -a --sparse=always /mnt/legacy/caddy-state /srv/canopy/',
  'cp -a --sparse=always /mnt/legacy/recovery-state /srv/canopy/',
  `cp -a --sparse=always /mnt/legacy/docker/volumes/. ${MOUNT_POINT}/`]);
 assert.equal(copies.some(c=>/containerd|overlay2|\/image |containers|network|buildkit|image-upgrades|storage-prep-request/.test(c)),false,'no image store, container or stale host request is carried');
 assert.deepEqual(made,['/srv/canopy/host-state']);
 assert.equal(result.volumeBytes,1000);assert.equal(result.hostBytes,60);assert.equal(result.totalBytes,1060);
 assert.equal(JSON.parse(marker).sourceUuid,uuid);assert.equal(JSON.parse(marker).totalBytes,1060);
 assert.equal(calls.some(c=>c==='du -sx --block-size=1 /mnt/legacy'),false,'the image store is never even measured');
 const again=fakeRun({'findmnt --noheadings --output UUID':{stdout:uuid+'\n'},'findmnt --noheadings --output OPTIONS':{stdout:'ro\n'}});
 assert.equal((await migrateLegacyStorage('/mnt/legacy',{run:again.run,fs})).copied,false);assert.equal(again.calls.some(c=>c.startsWith('cp ')),false);
 const writable=fakeRun({'findmnt --noheadings --output UUID':{stdout:uuid+'\n'},'findmnt --noheadings --output OPTIONS':{stdout:'rw\n'}});
 await assert.rejects(migrateLegacyStorage('/mnt/legacy',{run:writable.run,fs}),/read-only/);
 const full=fakeRun({'findmnt --noheadings --output UUID':{stdout:'0c8a1b2e-0000-4000-8000-000000000002\n'},'findmnt --noheadings --output OPTIONS':{stdout:'ro\n'},'du':{stdout:'99999999999999\t/x\n'}});
 await assert.rejects(migrateLegacyStorage('/mnt/legacy',{run:full.run,fs:{...fs,readFile:async()=>{throw enoent();}}}),e=>e.exitCode===28);assert.equal(full.calls.some(c=>c.startsWith('cp ')),false);
});

test('migration progress reports copied/total bytes from root growth while copying, then completion',async()=>{
 const uuid='0c8a1b2e-0000-4000-8000-000000000003';
 let usedBlocks=1000;const reports=[];let tick=null;
 const {run}=fakeRun({'findmnt --noheadings --output UUID':{stdout:uuid+'\n'},'findmnt --noheadings --output OPTIONS':{stdout:'ro\n'},'du -sx --block-size=1 /mnt/legacy/docker/volumes':{stdout:String(40*4096)+'\t/x\n'},'du -sx --block-size=1 /mnt/legacy/host-state':{stdout:'0\t/x\n'},
  'cp':async()=>{usedBlocks+=25;await tick();return {code:0,stdout:'',stderr:''};}});
 const fs={readdir:async dir=>dir==='/mnt/legacy'?['docker','host-state']:dir==='/mnt/legacy/docker'?['volumes']:[],readFile:async()=>{throw enoent();},writeFile:async()=>{},mkdir:async()=>{},statfs:async()=>({blocks:1e6,bfree:1e6-usedBlocks,bavail:1e6,bsize:4096})};
 const timers={setInterval:fn=>{tick=async()=>{fn();await new Promise(r=>setImmediate(r));};return 1;},clearInterval:()=>{tick=async()=>{};}};
 await migrateLegacyStorage('/mnt/legacy',{run,fs,timers,progress:async p=>{reports.push(p);}});
 assert.deepEqual(reports,[{copiedBytes:0,totalBytes:40*4096},{copiedBytes:25*4096,totalBytes:40*4096},{copiedBytes:40*4096,totalBytes:40*4096}]);
});

test('stop preparation stops containers before trimming, empties swap before trimming, trims the image before root',async()=>{
 const {run,calls}=fakeRun({'docker ps':{stdout:'canopy-ws-ws-1\ncanopy-member-x\nunrelated\n'},'swapon --show':{stdout:'/swapfile\n'},'fstrim -v /srv':{stdout:'/srv/canopy/docker/volumes: 1 GiB (1073741824 bytes) trimmed on /dev/loop0\n'},'fstrim -v /':{stdout:'/: 2 GiB (2147483648 bytes) trimmed on /dev/nvme0n1p1\n'}});
 const order=[];
 const report=await prepareForSnapshot({run,captureRecent:async()=>{order.push('capture');return {files:3};},cleanTmp:async()=>order.push('tmp'),usage:async()=>({rootBytes:9,userBytes:4}),userMounted:async()=>true,dataDiskMounted:async()=>false});
 assert.equal(report.status,'succeeded');assert.equal(report.trimmedBytes,3221225472);assert.deepEqual(report.usedBytes,{rootBytes:9,userBytes:4});
 const at=prefix=>calls.findIndex(c=>prefix.startsWith('=')?c===prefix.slice(1):c.startsWith(prefix));
 assert.equal(calls[at('docker stop')],'docker stop --time 30 canopy-ws-ws-1 canopy-member-x');
 for(const [before,after] of [['docker stop','swapoff'],['swapoff /swapfile','rm -f /swapfile'],['rm -f /swapfile','fstrim -v /srv'],['fstrim -v /srv','=fstrim -v /'],['=fstrim -v /','fallocate'],['fallocate','mkswap']])assert.ok(at(before)<at(after),`${before} before ${after}`);
 assert.equal(calls.includes('swapon /swapfile'),false,'swap is not re-enabled before the stop');
 assert.ok(calls.some(c=>c==='docker image prune --force'));assert.equal(calls.some(c=>/docker volume|system prune|--all/.test(c)),false,'volumes and in-use images are never pruned');
 assert.deepEqual(order,['capture','tmp']);
 assert.equal(trimmedBytes('/: 0 B (0 bytes) trimmed'),0);assert.equal(trimmedBytes('fstrim: /: the discard operation is not supported'),null);
});

test('a failed trim or swap step is reported but the preparation still finishes so the stop stays safe',async()=>{
 const {run,calls}=fakeRun({'docker ps':{stdout:''},'swapon --show':{stdout:'/swapfile\n'},'swapoff':{code:255},'fstrim':{code:1,stderr:'not supported'}});
 const report=await prepareForSnapshot({run,usage:async()=>null,cleanTmp:async()=>{},userMounted:async()=>false});
 assert.equal(report.status,'succeeded');assert.ok(report.warnings.some(w=>w.startsWith('release-swap')));assert.ok(report.warnings.some(w=>w.startsWith('trim:/')));
 assert.equal(calls.some(c=>c.startsWith('rm -f /swapfile')),false,'swap in use is never deleted');assert.equal(calls.some(c=>c.startsWith('fallocate')),false);
 assert.ok(calls.includes('final-sync')===false&&calls.filter(c=>c==='sync').length===2);
 // Bounded: every step receives at most the remaining overall deadline.
 let clock=0;const slow=async(command,args,{timeout})=>{clock+=timeout;return {code:0,stdout:'',stderr:''};};
 const bounded=await prepareForSnapshot({run:slow,now:()=>clock,deadlineMs:5000,usage:async()=>null,cleanTmp:async()=>{},userMounted:async()=>false});
 assert.equal(bounded.status,'succeeded');assert.ok(clock<60000,'steps do not exceed their budget');
});

test('a stop preparation request runs once per request id and its file is read without following links',async()=>{
 const writes=[];let state=null;let prepared=0;
 const deps={read:async()=>({requestId:'req-00000001'}),write:async s=>{writes.push(s.status);state=s;},current:async()=>state,prepare:async()=>{prepared++;return {status:'succeeded',trimmedBytes:5};}};
 assert.equal((await runRequested(deps)).status,'succeeded');assert.equal((await runRequested(deps)).status,'succeeded');
 assert.equal(prepared,1);assert.deepEqual(writes,['running','succeeded']);
 state={requestId:'req-00000001',status:'running',startedAt:new Date(0).toISOString()};
 await runRequested({...deps,now:()=>60*60000});assert.equal(prepared,2,'a run that died long ago may repeat');
 const failing=await runRequested({...deps,read:async()=>({requestId:'req-00000002'}),prepare:async()=>{throw Error('boom');}});assert.equal(failing.status,'failed');
 const dir=await mkdtemp(join(tmpdir(),'canopy-prep-'));
 try{
  const real=join(dir,'real.json'),link=join(dir,'request.json');await writeFile(real,JSON.stringify({requestId:'req-00000003'}));await symlink(real,link);
  await assert.rejects(readRequest(link));
  await writeFile(link+'2',JSON.stringify({requestId:'../../etc'}));await assert.rejects(readRequest(link+'2'),/Invalid/);
  await writeFile(link+'3',JSON.stringify({requestId:'req-00000004'}));assert.deepEqual(await readRequest(link+'3'),{requestId:'req-00000004'});
  await assert.rejects(readFile(link+'3'),/ENOENT/,'a consumed request is removed so the path unit does not retrigger');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('used extents come from the ext4 block bitmap, skip free space and are split into bounded reads',()=>{
 const dump=`Block size:               4096
Group 0: (Blocks 0-32767) csum 0x1234
  Free blocks: 100-199, 1000-32767
Group 1: (Blocks 32768-65535) csum 0x1
  Free blocks:
Group 2: (Blocks 65536-98303)
  Free blocks: 65536-98303
`;
 const {extents,usedBytes}=usedExtents(dump,{chunk:64*1024*1024});
 assert.deepEqual(extents.map(e=>[e.offset/4096,e.length/4096]),[[0,100],[200,800],[32768,16384],[49152,16384]]);
 assert.equal(usedBytes,(100+800+32768)*4096);
 assert.throws(()=>usedExtents('garbage'));
});

test('warm-up plan keeps priority order, removes duplicates and refuses paths outside the host trees',()=>{
 const phases=planWarmup({binaries:['/usr/bin/node','/usr/bin/caddy'],startup:[{path:'/srv/canopy/containerd/a',size:10},{path:'/usr/bin/node',size:1},{path:'/etc/shadow',size:1}],recent:[{type:'walk',path:'/srv/canopy/docker/volumes/canopy-project-x/_data/app'},{type:'file',path:'/srv/canopy/docker/volumes/canopy-project-x/_data/app/a.ts',size:4},{type:'file',path:'/srv/canopy/../etc/passwd',size:1}],device:'/dev/nvme0n1p1',extents:[{offset:0,length:8}]});
 assert.deepEqual(phases.map(p=>p.id),['binaries','startup','recent','background']);
 assert.deepEqual(phases[1].items.map(i=>i.path),['/srv/canopy/containerd/a']);assert.equal(phases[1].items[0].direct,true);
 assert.deepEqual(phases[2].items.map(i=>i.type),['walk','file']);
 assert.equal(phases[3].items[0].type,'extent');assert.deepEqual(phases.map(p=>p.critical),[true,true,false,false]);
 assert.ok(PHASES[3].concurrency<=2,'background reads stay at low concurrency');
});

test('warm-up runs phases in order, caps concurrency, signals readiness after the critical phases and publishes progress',async()=>{
 const phases=planWarmup({binaries:['/usr/bin/a','/usr/bin/b'],startup:[{path:'/srv/canopy/containerd/1',size:10}],recent:[{type:'file',path:'/srv/canopy/docker/volumes/canopy-home-1/_data/x',size:10}],device:'/dev/x',extents:Array.from({length:6},(_,i)=>({offset:i*10,length:10}))});
 const order=[];let active=0,peak=0,clock=0;const published=[];
 const read=async(item,phase)=>{order.push(phase.id);if(phase.id==='background'){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;}clock+=1500;return item.length??item.size??0;};
 let criticalAt=null;
 const result=await runWarmup({phases,read,bootId:'b1',now:()=>clock,publish:async v=>published.push(v),onCriticalDone:async()=>{criticalAt=order.length;}});
 assert.equal(result.aborted,false);
 assert.deepEqual([...new Set(order)],['binaries','startup','recent','background']);
 assert.equal(criticalAt,3,'readiness signal after binaries and startup files only');
 assert.ok(peak<=2);
 assert.equal(published.at(-1).percent,100);assert.equal(published.at(-1).state,'done');
 assert.ok(published.some(v=>v.criticalReady&&v.state==='warming'));
 assert.ok(published.every((v,i)=>i===0||v.percent>=published[i-1].percent),'progress never goes backwards');
});

test('warm-up resumes from its checkpoint in the same boot and starts over after a new boot',async()=>{
 const phases=planWarmup({binaries:['/usr/bin/a'],device:'/dev/x',extents:Array.from({length:10},(_,i)=>({offset:i,length:1}))});
 let saved=null;const checkpoint={load:async()=>saved,save:async v=>{saved=v;}};
 const controller=new AbortController();let reads=0,clock=0;
 await runWarmup({phases,bootId:'boot-1',checkpoint,now:()=>clock,signal:controller.signal,read:async()=>{reads++;clock+=2000;if(reads===6)controller.abort();return 1;}});
 assert.equal(saved.phaseIndex,3);assert.ok(saved.watermark>=4);
 const resumed=[];await runWarmup({phases,bootId:'boot-1',checkpoint,read:async item=>{resumed.push(item.offset);return 1;}});
 assert.ok(resumed.length<=10-saved.watermark+2&&!resumed.includes(0),'finished reads are not repeated');
 const fresh=[];await runWarmup({phases,bootId:'boot-2',checkpoint,read:async item=>{fresh.push(item.type);return 1;}});
 assert.equal(fresh.length,11,'a new boot (new instance from a snapshot) warms everything again');
 const failing=await runWarmup({phases,bootId:'boot-3',read:async()=>{throw Error('EIO');}});assert.equal(failing.errors,11,'a failed read is counted and skipped');
});

test('progress view and fincore parsing',()=>{
 const phases=[{id:'binaries',label:'L',bytes:50,critical:true},{id:'background',label:'B',bytes:50,critical:false}];
 assert.equal(progressView({phases,phaseIndex:1,done:3,bytesDone:63,startedAt:0,now:()=>1}).percent,63);
 assert.equal(progressView({phases,phaseIndex:1,done:3,bytesDone:100,startedAt:0,now:()=>1}).percent,99,'only completion reports 100');
 assert.deepEqual(parseFincore('4096 8192 /srv/canopy/containerd/x\n0 10 /srv/canopy/containerd/y\nbad line\n'),[{path:'/srv/canopy/containerd/x',size:8192,resident:4096}]);
});

test('startup capture records only image files the start actually read, never volume files',async()=>{
 const {run,calls}=fakeRun({'find':{stdout:'/srv/canopy/containerd/a\0/srv/canopy/docker/overlay2/b\0/etc/x\0'},'fincore':{stdout:'4096 100 /srv/canopy/containerd/a\n0 50 /srv/canopy/docker/overlay2/b\n'}});
 let written;const result=await captureStartupFiles({run,write:async(_,v)=>{written=v;}});
 assert.deepEqual(written.files,[{path:'/srv/canopy/containerd/a',size:100}]);assert.equal(result.files,1);
 assert.ok(calls[0].includes("-not -path */volumes/*"));assert.ok(!calls[1].includes('/etc/x'));
});

test('recent capture ranks repositories by git activity and orders index, packs and newest files before node_modules',async()=>{
 const root='/v';const dirent=(name,kind)=>({name,isDirectory:()=>kind==='d',isFile:()=>kind==='f',isSymbolicLink:()=>kind==='l'});
 const tree={'/v':[dirent('canopy-project-a','d'),dirent('canopy-home-a','d'),dirent('other','d')],'/v/canopy-project-a/_data':[dirent('old','d'),dirent('new','d')],'/v/canopy-home-a/_data':[],
  '/v/canopy-project-a/_data/old':[dirent('.git','d'),dirent('a.ts','f')],'/v/canopy-project-a/_data/new':[dirent('.git','d'),dirent('b.ts','f'),dirent('c.ts','f'),dirent('node_modules','d'),dirent('link','l')],
  '/v/canopy-project-a/_data/new/node_modules':[dirent('dep.js','f')],'/v/canopy-project-a/_data/new/.git/objects/pack':[dirent('p.idx','f'),dirent('p.pack','f')],'/v/canopy-project-a/_data/old/.git/objects/pack':[]};
 const mtimes={'/v/canopy-project-a/_data/new/.git/index':200,'/v/canopy-project-a/_data/old/.git/index':100,'/v/canopy-project-a/_data/new/b.ts':5,'/v/canopy-project-a/_data/new/c.ts':9};
 const io={readdir:async dir=>{if(!tree[dir])throw enoent();return tree[dir];},lstat:async path=>{if(!(path in mtimes)&&!/\.(ts|js)$/.test(path))throw enoent();return {mtimeMs:mtimes[path]??1,size:10};}};
 let written;await captureRecentFiles({volumeRoot:root,io,write:async(_,v)=>{written=v;},maxProjects:1});
 assert.deepEqual(written.projects,['/v/canopy-project-a/_data/new']);
 const paths=written.entries.map(e=>e.type==='walk'?'walk':e.path.replace('/v/canopy-project-a/_data/new/',''));
 assert.equal(paths[0],'walk');
 assert.ok(paths.indexOf('.git/objects/pack/p.idx')<paths.indexOf('c.ts'));assert.ok(paths.indexOf('c.ts')<paths.indexOf('b.ts'));assert.ok(paths.indexOf('b.ts')<paths.indexOf('node_modules/dep.js'));
 assert.equal(paths.includes('link'),false,'symlinks are never followed');
});

test('gateway storage helpers expose only coded numbers and request preparation idempotently',async()=>{
 assert.deepEqual(publicPrepStatus(null,'req-00000009'),{requestId:'req-00000009',status:'requested'});
 const shown=publicPrepStatus({requestId:'r-12345678',status:'succeeded',durationMs:5,trimmedBytes:9,usedBytes:{rootBytes:1,userBytes:2},warnings:['fstrim: /secret path'],steps:[{name:'trim:/',ok:true,ms:3,error:'x'}]},'r-12345678');
 assert.equal(shown.warnings,1);assert.equal(JSON.stringify(shown).includes('secret'),false);
 assert.equal(publicWarmup({version:1,state:'warming',percent:63,label:'x',criticalReady:true,bytesDone:1,bytesTotal:2}).percent,63);assert.equal(publicWarmup({version:2}),null);
 const files=new Map();const storage=hostStorage({requestFile:'/r/req.json',statusFile:'/s.json',progressFile:'/p.json',read:async f=>{if(!files.has(f))throw enoent();return files.get(f);},write:async(f,t)=>files.set(f,t),move:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},makeDir:async()=>{},usage:async({mountPoint,advertisedGib})=>({mountPoint,advertisedGib})});
 assert.deepEqual(await storage.requestPrep('req-00000010'),{requestId:'req-00000010',status:'requested'});assert.equal(JSON.parse(files.get('/r/req.json')).requestId,'req-00000010');
 files.set('/s.json',JSON.stringify({requestId:'req-00000010',status:'running'}));files.delete('/r/req.json');
 assert.equal((await storage.requestPrep('req-00000010')).status,'running');assert.equal(files.has('/r/req.json'),false,'a running request is not re-submitted');
 await assert.rejects(storage.requestPrep('../x'),/Invalid/);
 assert.deepEqual((await storage.status({id:'w',storageGiB:100})).usage,{mountPoint:MOUNT_POINT,advertisedGib:100});
 assert.deepEqual(await storage.status({id:'w'}),{mode:'disk',storageGiB:null,usage:{mountPoint:'/srv/canopy',advertisedGib:null},warmup:null});
});

test('gateway serves storage status to viewers and refuses stop preparation to anyone but the managed owner session',async()=>{
 const workspace={id:'ws-a',accounts:[],memoryMiB:1024,cpus:1,storageGiB:50};
 const requested=[];
 const server=createGateway({config:{workspaces:[workspace],principals:[{id:'owner',tokenSha256:digest('owner'),workspaces:[workspace.id],scope:'drive'}]},workspaces:{open:async()=>{throw Error('no runtime');}},hostStorage:{status:async w=>({mode:'snapshot',storageGiB:w.storageGiB}),requestPrep:async id=>{requested.push(id);return {};},prepStatus:async()=>({})}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
 try{
  const status=await fetch(url+'/v1/workspaces/ws-a/storage',{headers:{authorization:'Bearer owner'}});assert.equal(status.status,200);assert.deepEqual(await status.json(),{mode:'snapshot',storageGiB:50});
  const prep=await fetch(url+'/v1/workspaces/ws-a/storage-prep',{method:'POST',headers:{authorization:'Bearer owner','content-type':'application/json'},body:JSON.stringify({requestId:'req-00000011'})});
  assert.notEqual(prep.status,202);assert.deepEqual(requested,[]);
  assert.equal((await fetch(url+'/v1/workspaces/ws-a/storage')).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 void http;
});

test('installed units order user storage before the runtimes and keep warm-up off the readiness path',async()=>{
 const text=units('/usr/bin/node');
 assert.match(text['canopy-user-storage.service'],/Before=containerd\.service docker\.service canopy-host\.service/);
 assert.match(text['docker.service.d/canopy-user-storage.conf'],/Requires=canopy-user-storage\.service/);
 assert.match(text['canopy-warmup-early.service'],/Before=.*containerd\.service docker\.service caddy\.service/);assert.match(text['canopy-warmup-early.service'],/TimeoutStartSec=60/);
 assert.doesNotMatch(text['canopy-warmup.service'],/Before=/);
 assert.match(text['canopy-storage-prep.path'],/PathExists=\/srv\/canopy\/host-state\/storage-prep-request\.json/);
 assert.doesNotMatch(Object.values(text).join('\n'),/discard/);
 assert.throws(()=>units('/usr/bin/node; reboot'));
 const written=new Map(),modes=new Map();const {run,calls}=fakeRun();
 await install(100,{run,write:async(f,t)=>written.set(f,t),makeDir:async()=>{},setMode:async(f,m)=>modes.set(f,m),root:'/etc/systemd/system',node:'/usr/bin/node',ensure:async gib=>({gib})});
 for(const file of written.keys())assert.equal(modes.get(file),0o644,`${file} is not world-readable`);
 assert.equal(modes.get('/etc/systemd/system/containerd.service.d'),0o755);
 assert.ok(written.has('/etc/systemd/system/canopy-warmup.service'));assert.deepEqual(calls,['systemctl daemon-reload',`systemctl enable ${ENABLE.join(' ')}`,'systemctl start canopy-storage-prep.path']);
 assert.ok(ENABLE.includes('fstrim.timer'));
 await assert.rejects(install(64,{run,write:async()=>{},makeDir:async()=>{},setMode:async()=>{},ensure:async()=>{}}),/Invalid workspace storage size/);
 void mkdir;void SWAP_FILE;
});

test('host configuration accepts any whole storage size the plan catalog sets, and a sane process limit',async()=>{
 const {validateConfig}=await import('./policy.mjs');
 const config=gib=>({workspaces:[{id:'w1',accounts:[],memoryMiB:1024,cpus:1,storageGiB:gib}],principals:[]});
 for(const gib of [50,100,200,500,1000,undefined])assert.doesNotThrow(()=>validateConfig(config(gib)));
 for(const gib of [0,-1,64.5,'50',1e6])assert.throws(()=>validateConfig(config(gib)),/storage size/);
 const pids=limit=>({workspaces:[{id:'w1',accounts:[],memoryMiB:1024,cpus:1,pidsLimit:limit}],principals:[]});
 for(const limit of [1024,8192,undefined])assert.doesNotThrow(()=>validateConfig(pids(limit)));
 for(const limit of [0,512,100000,'8192',8192.5])assert.throws(()=>validateConfig(pids(limit)),/process limit/);
});

test('on today\'s retained-disk layout the preparation trims the data disk and root, and is harmless without a snapshot',async()=>{
 const {run,calls}=fakeRun({'docker ps':{stdout:''},'swapon --show':{stdout:''},'findmnt --noheadings --mountpoint /srv/canopy/docker/volumes':{code:1},'findmnt --noheadings --mountpoint /srv/canopy':{code:0},'fstrim -v /srv/canopy':{stdout:'/srv/canopy: 1 GiB (1073741824 bytes) trimmed\n'},'fstrim -v /':{stdout:'/: 0 B (0 bytes) trimmed\n'}});
 const report=await prepareForSnapshot({run,usage:async()=>null,cleanTmp:async()=>{}});
 assert.equal(report.status,'succeeded');assert.deepEqual(report.trimmedByMount,{'/srv/canopy':1073741824,'/':0});
 assert.ok(calls.indexOf('fstrim -v /srv/canopy')<calls.indexOf('fstrim -v /'));
 assert.equal(calls.some(c=>c.startsWith('fstrim -v /srv/canopy/docker/volumes')),false);
});

test('units-only install (retained-disk layout) adds warm-up, stop preparation and fstrim.timer without touching Docker ordering',async()=>{
 const {installUnits,UNITS_ONLY}=await import('./snapshot-storage-install.mjs');
 const written=new Map();const {run,calls}=fakeRun();
 await installUnits({run,write:async(f,t)=>written.set(f,t),setMode:async()=>{},root:'/etc/systemd/system',node:'/usr/bin/node',startWarmup:true});
 assert.deepEqual([...written.keys()].map(f=>f.split('/').pop()),[...UNITS_ONLY]);
 assert.equal([...written.keys()].some(f=>/user-storage|docker\.service\.d|containerd\.service\.d/.test(f)),false);
 assert.deepEqual(calls,['systemctl daemon-reload','systemctl enable canopy-warmup-early.service canopy-warmup.service canopy-storage-prep.path fstrim.timer','systemctl start canopy-storage-prep.path','systemctl start --no-block canopy-warmup.service']);
});

test('warm-up detects the retained-disk layout so only the lazily loaded root volume is warmed',async()=>{
 const {retainedDiskLayout}=await import('./warmup.mjs');
 assert.equal(await retainedDiskLayout(fakeRun({'findmnt':{code:0}}).run),true);
 assert.equal(await retainedDiskLayout(fakeRun({'findmnt':{code:1}}).run),false);
});

test('unit files are 0644 on disk even when installed under the bootstrap umask 077 (no "world-inaccessible" warnings)',async()=>{
 const {mkdtemp,rm,stat}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'canopy-units-'));const previous=process.umask(0o077);
 try{
  await install(100,{run:fakeRun().run,root,node:'/usr/bin/node',ensure:async gib=>({gib})});
  for(const name of Object.keys(units('/usr/bin/node')))assert.equal((await stat(join(root,name))).mode&0o777,0o644,name);
  for(const dir of ['docker.service.d','containerd.service.d'])assert.equal((await stat(join(root,dir))).mode&0o777,0o755,dir);
  for(const text of Object.values(units('/usr/bin/node')))assert.doesNotMatch(text,/token|secret|password|key=/i,'units carry no secrets');
 }finally{process.umask(previous);await rm(root,{recursive:true,force:true});}
});

// Pinned by canopy-website tests/runtime-start-order.test.mjs (its systemd
// model mirrors these dependencies): nothing installed here can stop, restart
// or start containerd or Docker on its own.
test('snapshot-storage units never restart the runtimes: drop-ins only require/order user storage, nothing binds or restarts them',async()=>{
 const text=units('/usr/bin/node');
 for(const runtime of ['docker','containerd'])assert.equal(text[`${runtime}.service.d/canopy-user-storage.conf`],'[Unit]\nRequires=canopy-user-storage.service\nAfter=canopy-user-storage.service\n');
 const all=Object.values(text).join('\n');
 assert.doesNotMatch(all,/BindsTo=|PartOf=|PropagatesReloadTo=|ReloadPropagatedFrom=|Conflicts=/);
 assert.doesNotMatch(all,/systemctl|\bkill\b|Restart=always/);
 assert.match(text['canopy-user-storage.service'],/Wants=canopy-warmup-early\.service/);assert.doesNotMatch(text['canopy-user-storage.service'],/Requires=/);
 const {run,calls}=fakeRun();
 await install(100,{run,write:async()=>{},makeDir:async()=>{},setMode:async()=>{},ensure:async gib=>({gib})});
 assert.equal(calls.some(c=>/containerd|docker/.test(c)&&/start|restart|stop/.test(c)),false,calls.join('\n'));
});

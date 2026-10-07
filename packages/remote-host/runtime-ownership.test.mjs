// Shared runtime files are created by exactly one owner (systemd-tmpfiles, as
// root) and only opened by the unprivileged gateway and root tools. Regression
// for runtime 34d0550: the bootstrap's `mkdir -p /run/canopy` under umask 077
// left a root 0700 directory, and canopy-host crash-looped with EACCES opening
// /run/canopy/resource-admission.lock.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,writeFile,rm,stat,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {acquireResourceAdmission} from './resource-admission.mjs';
import {publishRuntimeFile} from './runtime-dir.mjs';

const here=new URL('.',import.meta.url).pathname;
const read=name=>readFile(join(here,name),'utf8');
const tmpfilesLines=async()=> (await read('canopy-runtime.tmpfiles.conf')).split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(/\s+/));

test('the runtime declares /run/canopy and the admission lock once, root-owned and gateway-readable',async()=>{
 assert.deepEqual(await tmpfilesLines(),[
  ['d','/run/canopy','0755','root','root','-','-'],
  ['f','/run/canopy/resource-admission.lock','0660','root','canopy-host','-','-'],
 ]);
 const unit=await read('canopy-host.service');
 const pre=unit.indexOf('ExecStartPre=+/usr/bin/systemd-tmpfiles --create /opt/canopy-host/canopy-runtime.tmpfiles.conf');
 assert.ok(pre>0,'every gateway start repairs ownership as root first');
 assert.ok(pre<unit.indexOf('ExecStart=/usr/bin/node'));
 assert.match(unit,/^User=canopy-host$/m);
 const install=await read('install.sh');
 assert.ok(install.indexOf('canopy-runtime.tmpfiles.conf')>0&&install.indexOf('canopy-runtime.tmpfiles.conf')<install.indexOf('systemctl restart canopy-host'));
 assert.match(await read('package-host-release.sh'),/canopy-runtime\.tmpfiles\.conf/);
});

test('no runtime code creates the admission lock; opening a missing or unreachable lock fails clearly and creates nothing',async t=>{
 for(const name of (await readdir(here)).filter(n=>n.endsWith('.mjs')&&!n.endsWith('.test.mjs'))){
  const source=await read(name);
  for(const line of source.split('\n').filter(l=>l.includes('resource-admission.lock')))assert.doesNotMatch(line,/writeFile|O_CREAT|'w[x+]?'|install -|touch /,`${name} must not create the lock`);
 }
 const source=await read('resource-admission.mjs');
 assert.doesNotMatch(source,/constants\.O_CREAT|flag:\s*'w/);
 const dir=await mkdtemp(join(tmpdir(),'canopy-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(acquireResourceAdmission(join(dir,'resource-admission.lock')),/lock is missing; expected root:canopy-host 0660/);
 await assert.rejects(stat(join(dir,'resource-admission.lock')),{code:'ENOENT'});
});

test('root-side status files are published world-readable even under the bootstrap umask',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'canopy-run-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const runtime=join(dir,'canopy');const previous=process.umask(0o077);
 try{await publishRuntimeFile(join(runtime,'warmup.json'),{version:1});}finally{process.umask(previous);}
 assert.equal((await stat(runtime)).mode&0o777,0o755);
 assert.equal((await stat(join(runtime,'warmup.json'))).mode&0o777,0o644);
 for(const name of ['warmup.mjs','storage-prep.mjs'])assert.doesNotMatch(await read(name),/mkdir\('\/run\/canopy'/,`${name} publishes through runtime-dir.mjs`);
});

// Real cross-privilege check: root prepares the files exactly as the old
// bootstrap did, an unprivileged uid/gid (the gateway's) opens the lock.
// Needs root on Linux with setpriv and systemd-tmpfiles (CI host gate, or
// `docker run --rm -v "$PWD":/w -w /w node:22 ...` as root); skipped elsewhere.
const crossUser=process.platform==='linux'&&process.getuid?.()===0&&spawnSync('setpriv',['--version']).status===0&&spawnSync('systemd-tmpfiles',['--version']).status===0;
test('gateway uid opens the lock only after tmpfiles ownership; the old umask-077 mkdir fails with EACCES',{skip:!crossUser&&'needs root, setpriv and systemd-tmpfiles on Linux'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'canopy-xuser-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await chmod(root,0o755);
 const gatewayUid=65534,gatewayGid=46001;
 const runtime=join(root,'run','canopy'),lock=join(runtime,'resource-admission.lock');
 const asGateway=()=>spawnSync('setpriv',[`--reuid=${gatewayUid}`,`--regid=${gatewayGid}`,'--clear-groups',process.execPath,'--input-type=module','-e',`import {acquireResourceAdmission} from ${JSON.stringify(join(here,'resource-admission.mjs'))};try{const release=await acquireResourceAdmission(${JSON.stringify(lock)},{timeoutMs:2000});await release();console.log('ADMITTED');}catch(error){console.log(error.message);process.exit(3);}`],{encoding:'utf8'});
 // Old bootstrap: umask 077, `mkdir -p /run/canopy`, `install -m 0660 -o root -g canopy-host`.
 const old=spawnSync('bash',['-c',`umask 077; mkdir -p "$1"; install -m 0660 -o root -g ${gatewayGid} /dev/null "$2"`,'old',runtime,lock]);assert.equal(old.status,0);
 await chmod(join(root,'run'),0o755); // like the real /run tmpfs
 assert.equal((await stat(runtime)).mode&0o777,0o700);
 const denied=asGateway();assert.equal(denied.status,3);assert.match(denied.stdout,/not accessible to this service/);
 // Single owner: the shipped tmpfiles declaration, rooted at the fixture.
 const conf=join(root,'canopy.conf');
 await writeFile(conf,(await read('canopy-runtime.tmpfiles.conf')).split('\n').filter(line=>line&&!line.startsWith('#')).join('\n').replaceAll('/run/canopy',runtime).replaceAll(' canopy-host ',` ${gatewayGid} `)+'\n');
 const applied=spawnSync('systemd-tmpfiles',['--create',conf],{encoding:'utf8'});assert.equal(applied.status,0,applied.stderr);
 assert.equal((await stat(runtime)).mode&0o777,0o755);
 const info=await stat(lock);assert.equal(info.uid,0);assert.equal(info.gid,gatewayGid);assert.equal(info.mode&0o777,0o660);
 const admitted=asGateway();assert.equal(admitted.status,0,admitted.stdout+admitted.stderr);assert.match(admitted.stdout,/ADMITTED/);
 // A root tool that runs first cannot take ownership away: it only opens.
 const rootRelease=await acquireResourceAdmission(lock,{timeoutMs:2000});await rootRelease();
 assert.equal((await stat(lock)).uid,0);assert.equal((await stat(lock)).gid,gatewayGid);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serviceBinaryManifest,verifyServiceBinaries} from './service-release.mjs';
const read=name=>readFile(new URL('./'+name,import.meta.url),'utf8');
const directives=text=>text.split('\n').filter(line=>/^[A-Za-z]+=/.test(line));

test('canopy-service runs as its own user in group canopy-host, hardened, ready before the gateway',async()=>{
 const unit=await read('canopy-service.service'),lines=directives(unit);
 for(const line of ['User=canopy-service','Group=canopy-host','Before=canopy-host.service','StateDirectory=canopy-service','StateDirectoryMode=0700','RuntimeDirectory=canopy-service','RuntimeDirectoryMode=0755','RuntimeDirectoryPreserve=yes','NoNewPrivileges=true','ProtectSystem=strict','ProtectHome=true','PrivateTmp=true','CapabilityBoundingSet=','ExecStart=/usr/local/lib/canopy-service/canopy-serviced'])assert.ok(lines.includes(line),line);
 assert.ok(lines.some(line=>line.startsWith('ExecStartPost=')&&line.includes('--unix-socket /run/canopy-service/admin.sock')&&line.includes('/admin/health')),'readiness waits for the admin API, not just a file');
 assert.ok(unit.indexOf('ExecStartPre=+/bin/rm -f /run/canopy-service/admin.sock')<unit.indexOf('ExecStartPost='),'a stale socket cannot satisfy readiness');
 assert.ok(lines.includes('ExecStartPre=+/usr/bin/systemd-tmpfiles --create canopy-service.conf'),'root runs only the root-owned /etc/tmpfiles.d copy');
 assert.doesNotMatch(lines.join('\n'),/\/opt\/canopy-host/,'nothing root-executed comes from the gateway-owned tree');
 const host=directives(await read('canopy-host.service'));
 assert.ok(host.includes('Wants=canopy-service.service'));assert.ok(!host.some(l=>l.startsWith('Requires=')&&l.includes('canopy-service')),'the gateway never requires the harness');
 assert.ok(host.includes('ReadWritePaths=/var/lib/canopy-host -/run/canopy-relay'));
 const tmpfiles=(await read('canopy-service.tmpfiles.conf')).split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(/\s+/));
 assert.deepEqual(tmpfiles,[['d','/run/canopy-service','0755','canopy-service','canopy-host','-','-'],['d','/run/canopy-service/ws','0755','canopy-service','canopy-host','-','-']]);
});

test('installers install the service before the gateway restarts, with verified root-owned code',async()=>{
 execFileSync('bash',['-n',new URL('./install-service.sh',import.meta.url).pathname]);
 const install=await read('install.sh');
 assert.ok(install.indexOf('install-service.sh')>0&&install.indexOf('install-service.sh')<install.indexOf('systemctl restart canopy-host'));
 const service=await read('install-service.sh');
 for(const needle of ['useradd --system --no-create-home --home-dir /var/lib/canopy-service --gid canopy-host','sha256sum "$binary"','serviceBinaries','/usr/local/lib/canopy-service/canopy-serviced','/etc/tmpfiles.d/canopy-service.conf','BindPaths=%s:/var/lib/canopy-service','access-keys.json','/etc/canopy-service/env'])assert.ok(service.includes(needle),needle);
 assert.ok(service.indexOf('[[ $actual == "$expected" ]]')<service.indexOf('install -m 0755 -o root -g root "$binary"'),'checksum before install');
 const deploy=await read('deploy.sh');for(const file of ['canopy-service.service','canopy-service.tmpfiles.conf','canopy-runtime.tmpfiles.conf'])assert.ok(deploy.includes(file),file);
});

test('service binary manifests bind each architecture and refuse anything else',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canopy-service-bin-'));
 try{
  const elf=tag=>Buffer.concat([Buffer.from('\x7fELF','latin1'),Buffer.alloc(2000,tag)]);
  await writeFile(join(dir,'canopy-serviced-linux-amd64'),elf('a'));
  assert.deepEqual(Object.keys(serviceBinaryManifest(dir,{all:false})),['linux-amd64']);
  assert.throws(()=>serviceBinaryManifest(dir),/ENOENT/);
  await writeFile(join(dir,'canopy-serviced-linux-arm64'),elf('b'));
  const manifest={serviceBinaries:serviceBinaryManifest(dir)};
  assert.equal(verifyServiceBinaries(manifest,dir),true);
  await writeFile(join(dir,'canopy-serviced-linux-arm64'),elf('c'));
  assert.throws(()=>verifyServiceBinaries(manifest,dir),/does not match/);
  await writeFile(join(dir,'canopy-serviced-linux-arm64'),'#!/bin/sh\n'.padEnd(2000,'x'));
  assert.throws(()=>serviceBinaryManifest(dir),/not a Linux executable/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

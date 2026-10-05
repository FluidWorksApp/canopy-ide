import test from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
test('generated firewall grants HTTPS facade only and preserves metadata, private peer and management denial',async()=>{
 const script=await readFile(new URL('./network-isolation.sh',import.meta.url),'utf8'),root=await mkdtemp(path.join(tmpdir(),'canopy-firewall-'));
 try{
  for(const binary of ['iptables','ip6tables'])await writeFile(path.join(root,binary),'#!/bin/sh\ncase "$*" in *" -C "*) exit 1;; esac\nprintf "%s %s\\n" "'+binary+'" "$*" >> "$CANOPY_FIREWALL_TRACE"\n',{mode:0o700});
  // Exercise actual shell rule-generation with dummy binaries, never host rules.
  const simulated=script.replace('[[ $EUID == 0 ]]','[[ 1 == 1 ]]'),file=path.join(root,'isolate.sh'),trace=path.join(root,'trace');await writeFile(file,simulated);
  await exec('bash',[file],{env:{...process.env,PATH:root+':'+process.env.PATH,CANOPY_FIREWALL_TRACE:trace}});
  const lines=(await readFile(trace,'utf8')).trim().split('\n');
  assert.ok(lines.includes('iptables -w -I CANOPY-INPUT 1 -p tcp --dport 443 -j ACCEPT'));
  assert.ok(lines.includes('iptables -w -I CANOPY-INPUT 1 -j DROP'));assert.ok(lines.includes('ip6tables -w -I CANOPY-INPUT 1 -j DROP'));
  assert.equal(lines.filter(l=>l.includes('CANOPY-INPUT')&&l.includes('--dport')).length,1);
  for(const range of ['169.254.0.0/16','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','127.0.0.0/8'])assert.ok(lines.some(l=>l.includes('CANOPY-EGRESS 1 -d '+range+' -j DROP')));
  assert.ok(!lines.some(l=>/--dport (80|8080|8081|8787)\b/.test(l)));
 }finally{await rm(root,{recursive:true,force:true});}
});

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
  for(const binary of ['iptables','ip6tables']){
   const create=lines.indexOf(`${binary} -w -N DOCKER-USER`),route=lines.indexOf(`${binary} -w -I DOCKER-USER 1 -i cnp+ -j CANOPY-EGRESS`),publish=lines.indexOf(`${binary} -w -I FORWARD 1 -j DOCKER-USER`);
   assert.ok(create>=0&&route>create&&publish>route,'Docker user chain is populated before it can carry restored-container traffic');
  }
  assert.ok(lines.includes('iptables -w -I DOCKER-USER 1 -d 169.254.0.0/16 -j DROP'));
  assert.ok(lines.includes('ip6tables -w -I DOCKER-USER 1 -d fd00:ec2::254/128 -j DROP'));
  // Interpret the generated insertions with Docker's eventual accept rule
  // placed afterwards. A daemon-start jump must not admit metadata or peers.
  const chains=new Map();for(const line of lines){const parts=line.split(' '),index=parts.indexOf('-I');if(parts[0]!=='iptables'||index<0)continue;const name=parts[index+1],rules=chains.get(name)??[];rules.unshift(parts.slice(index+3));chains.set(name,rules);}
  const matches=(rule,packet)=>{const iface=rule.indexOf('-i');if(iface>=0&&!packet.iface.startsWith(rule[iface+1].replace('+','')))return false;const dest=rule.indexOf('-d');if(dest>=0){const [network,bits]=rule[dest+1].split('/'),toInt=ip=>ip.split('.').reduce((n,part)=>(n<<8)|Number(part),0),mask=-1<<(32-Number(bits));if((toInt(packet.dest)&mask)!==(toInt(network)&mask))return false;}return true;};
  const evaluate=(name,packet)=>{for(const rule of chains.get(name)??[]){if(!matches(rule,packet))continue;const target=rule[rule.indexOf('-j')+1];if(target==='DROP')return 'DROP';if(target==='CANOPY-EGRESS'){const verdict=evaluate(target,packet);if(verdict)return verdict;}}return null;};
  assert.equal(evaluate('DOCKER-USER',{iface:'docker0',dest:'169.254.169.254'}),'DROP','legacy owner cannot read instance userdata');
  assert.equal(evaluate('DOCKER-USER',{iface:'cnp-member',dest:'169.254.169.254'}),'DROP');
  assert.equal(evaluate('DOCKER-USER',{iface:'cnp-member',dest:'10.0.0.4'}),'DROP','member private peer access is blocked before Docker accept');
  assert.equal(evaluate('DOCKER-USER',{iface:'cnp-member',dest:'8.8.8.8'}),null,'public egress can continue to Docker forwarding');
 }finally{await rm(root,{recursive:true,force:true});}
});

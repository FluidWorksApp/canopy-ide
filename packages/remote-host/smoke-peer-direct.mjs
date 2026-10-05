// Fresh contexts; default-route private topology with scoped firewall isolation.
import {peerSmokeArguments,peerSmokeBridge,peerSmokeFirewallRules} from './peer-smoke-inputs.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import path from 'node:path';import {randomBytes} from 'node:crypto';import {createServer} from 'node:http';
const exec=promisify(execFile),image=process.env.CANOPY_WORKSPACE_IMAGE;if(!image||!/^[a-zA-Z0-9][\w./:@-]*$/.test(image))throw Error('CANOPY_WORKSPACE_IMAGE is required');
const name='canopy-peer-smoke-'+randomBytes(5).toString('hex'),network=name+'-net',canary=name+'-canary',canaryNetwork=name+'-canary-net',root=path.resolve(import.meta.dirname,'../..'),installed=[],ownedNetworks=[];
const hostCanary=createServer((_req,res)=>res.end('synthetic-canary'));await new Promise(resolve=>hostCanary.listen(0,'0.0.0.0',resolve));
try{
 // Fail closed if scoped host firewall setup is unavailable; no global flush.
 await exec('sudo',['-n','iptables','-w','-S','DOCKER-USER'],{timeout:10000});
 await exec('docker',['network','create','--ipv6=false','--label','canopy.synthetic-peer-proof='+name,'--opt','com.docker.network.bridge.name='+peerSmokeBridge(name),network],{timeout:10000});ownedNetworks.push(network);
 await exec('docker',['network','create','--internal','--ipv6=false','--label','canopy.synthetic-peer-proof='+name,canaryNetwork],{timeout:10000});ownedNetworks.push(canaryNetwork);
 for(const rule of peerSmokeFirewallRules(name)){await exec('sudo',['-n','iptables','-w','-I',rule[0],'1',...rule.slice(1)],{timeout:10000});installed.push(rule);await exec('sudo',['-n','iptables','-w','-C',...rule],{timeout:10000});}
 await exec('docker',['run','--rm','-d','--name',canary,'--label','canopy.synthetic-peer-proof='+name,'--network',canaryNetwork,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--memory','64m','--cpus','0.25',image,'node','-e','require("node:http").createServer((q,r)=>r.end("synthetic-canary")).listen(32345,"0.0.0.0")'],{timeout:10000});
 const networkInfo=JSON.parse((await exec('docker',['network','inspect',network],{timeout:10000})).stdout)[0],canaryInfo=JSON.parse((await exec('docker',['inspect',canary],{timeout:10000})).stdout)[0];
 if(networkInfo.Name!==network||networkInfo.Labels?.['canopy.synthetic-peer-proof']!==name||networkInfo.Options?.['com.docker.network.bridge.name']!==peerSmokeBridge(name)||networkInfo.EnableIPv6!==false||canaryInfo.Name!=='/'+canary||canaryInfo.Config?.Labels?.['canopy.synthetic-peer-proof']!==name)throw Error('Synthetic network ownership differs');
 const probes={hostIp:networkInfo.IPAM.Config[0].Gateway,hostPort:hostCanary.address().port,externalIp:canaryInfo.NetworkSettings.Networks[canaryNetwork].IPAddress,externalPort:32345};
 // These two endpoints are created by this script, never real host services.
 for(const url of ['http://127.0.0.1:'+probes.hostPort,'http://'+probes.externalIp+':'+probes.externalPort]){let ready=false;for(let n=0;n<20;n++){try{const response=await fetch(url,{signal:AbortSignal.timeout(500)});if(await response.text()==='synthetic-canary'){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}if(!ready)throw Error('Synthetic canary unavailable');}
 const result=await exec('docker',peerSmokeArguments({root,image,name,network,probes}),{timeout:90000,maxBuffer:131072});process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
}finally{
 for(const container of [name,canary]){try{const current=JSON.parse((await exec('docker',['inspect',container],{timeout:10000})).stdout)[0];if(current.Name==='/'+container&&current.Config?.Labels?.['canopy.synthetic-peer-proof']===name)await exec('docker',['rm','--force',container],{timeout:10000});}catch{}}
 for(const rule of installed.reverse())await exec('sudo',['-n','iptables','-w','-D',...rule],{timeout:10000}).catch(()=>{});
 for(const target of ownedNetworks){try{const current=JSON.parse((await exec('docker',['network','inspect',target],{timeout:10000})).stdout)[0];if(current.Name===target&&current.Labels?.['canopy.synthetic-peer-proof']===name)await exec('docker',['network','rm',target],{timeout:10000});}catch{}}hostCanary.closeAllConnections();await new Promise(resolve=>hostCanary.close(resolve));
}

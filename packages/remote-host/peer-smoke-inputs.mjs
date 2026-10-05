import path from 'node:path';
export const peerSmokeSources=['src/teamMessaging/client.ts','src/teamMessaging/crypto.ts','src/teamMessaging/store.ts','src/teamMessaging/history.ts','src/teamMessaging/messageSchema.ts'];
export function peerSmokeArguments({root,image,name,network}){
 if(typeof root!=='string'||!path.isAbsolute(root)||root.includes(',')||! /^[a-zA-Z0-9][\w./:@-]*$/.test(image??'')||! /^canopy-peer-smoke-[a-f0-9]{10}$/.test(name??'')||network!==name+'-net')throw Error('Invalid isolated peer smoke configuration');
 const mounts=peerSmokeSources.map(file=>[file,'/smoke/source/'+path.basename(file)]).concat([['packages/control-plane/lib/peer-messaging.mjs','/smoke/peer-messaging.mjs'],['packages/remote-host/smoke-peer-direct-fixture.mjs','/opt/canopy/smoke-peer-direct-fixture.mjs']]);
 return ['run','--rm','--name',name,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','512','--memory','1536m','--cpus','2','--user','1000:1000','--shm-size','256m','--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777','--tmpfs','/home/agent:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700',...mounts.flatMap(([file,target])=>['--mount','type=bind,source='+path.join(root,file)+',target='+target+',readonly']),image,'node','/opt/canopy/smoke-peer-direct-fixture.mjs'];
}

import test from 'node:test';import assert from 'node:assert/strict';import {memberRuntime} from './member-runtime.mjs';import {DockerWorkspaces} from './docker.mjs';import {projectMounts} from './project-mounts.mjs';
function engine(){const containers=new Map(),volumes=new Map(),calls=[];const missing=()=>{throw Object.assign(Error('missing'),{missingResource:true});};return {containers,volumes,calls,docker:async args=>{
 calls.push(args);const [op]=args;
 if(op==='ps'){const filter=args[args.indexOf('--filter')+1]?.replace(/^label=/,'');return {stdout:[...containers].filter(([,c])=>!filter||c.Config.Labels[filter.split('=')[0]]===filter.split('=')[1]).map(([name])=>name).join('\n')};}
 if(op==='inspect'){const c=containers.get(args[1]);if(!c)return missing();return {stdout:JSON.stringify([c])};}
 if(op==='volume'){const name=op&&args[2];if(args[1]==='create'){const labels={};for(let i=0;i<args.length;i++)if(args[i]==='--label'){const [key,value]=args[i+1].split('=');labels[key]=value;}volumes.set(args.at(-1),{Name:args.at(-1),Driver:'local',Options:{},Labels:labels});return {stdout:''};}if(!volumes.has(name))return missing();return {stdout:JSON.stringify([volumes.get(name)])};}
 if(op==='run'&&args.includes('-d')){const get=flag=>args[args.indexOf(flag)+1],labels={},mounts=[];for(let i=0;i<args.length;i++){if(args[i]==='--label'){const [key,value]=args[i+1].split('=');labels[key]=value;}if(args[i]==='--mount'){const parts=Object.fromEntries(args[i+1].split(',').map(p=>p.split('=')));mounts.push({Destination:parts.target,Name:parts.source,Type:'volume',RW:!Object.hasOwn(parts,'readonly')});if(!volumes.has(parts.source))volumes.set(parts.source,{Name:parts.source});}}
 const network=get('--network');containers.set(get('--name'),{Config:{Labels:labels,Image:args.at(-1),User:get('--user'),Env:args.flatMap((v,i)=>v==='--env'?[args[i+1]]:[])},Mounts:mounts,HostConfig:{Memory:parseInt(get('--memory'))*1048576,MemorySwap:parseInt(get('--memory-swap'))*1048576,NanoCpus:Number(get('--cpus'))*1e9,PidsLimit:1024,RestartPolicy:{Name:'on-failure',MaximumRetryCount:3},CgroupParent:get('--cgroup-parent'),NetworkMode:network,CapDrop:['ALL'],SecurityOpt:['no-new-privileges']},State:{Running:true},NetworkSettings:{Networks:{[network]:{IPAddress:'172.18.0.2'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'41000'}]}}});}
 if(op==='update'){const c=containers.get(args.at(-1));if(args.includes('--restart'))c.HostConfig.RestartPolicy={Name:'no',MaximumRetryCount:0};}
 if(op==='stop')containers.get(args.at(-1)).State.Running=false;
 if(op==='rm'){assert.ok(!args.includes('--volumes'));containers.delete(args.at(-1));}
 return {stdout:''};
 }};}
const parent={id:'shared',cgroupParent:'canopy-shared.slice',accounts:[],memoryMiB:1024,cpus:1,projectMounts:[{id:'one',writable:true},{id:'two',writable:true}]};
const access=ids=>({allRead:false,allWrite:false,selected:ids.map(id=>({id,writable:true}))});
const principal=(memberId,version,scope='drive')=>({memberId,workspaceId:'shared',accessVersion:version,scope});
test('grant replacement stops old processes before changing mounts and preserves only the same member private volumes',async()=>{
 const e=engine(),host=new DockerWorkspaces({secret:'synthetic',docker:e.docker,verifyCapacity:async()=>{}});
 const a=memberRuntime(parent,principal('alice',1),access(['one','two'])),b=memberRuntime(parent,principal('bob',1),access(['two']));
 await host.open(a,{resume:true});await host.open(b,{resume:true});
 const narrowed=memberRuntime(parent,principal('alice',2),access(['one']));assert.notEqual(a.id,narrowed.id);assert.equal(a.storageId,narrowed.storageId);assert.notEqual(narrowed.storageId,b.storageId);
 const start=e.calls.length;await host.open(narrowed,{resume:true});const update=e.calls.slice(start);
 assert.ok(update.findIndex(a=>a[0]==='stop')<update.findIndex(a=>a[0]==='run'&&a.includes('-d')));
 assert.equal(e.containers.has('canopy-ws-'+a.id),false);assert.equal(e.containers.get('canopy-ws-'+b.id).State.Running,true);
 const mounts=e.containers.get('canopy-ws-'+narrowed.id).Mounts;
 assert.ok(mounts.some(m=>m.Name==='canopy-home-'+a.storageId));assert.ok(mounts.some(m=>m.Name==='canopy-project-'+a.storageId));assert.ok(!mounts.some(m=>m.Name==='canopy-home-'+b.storageId));assert.ok(!mounts.some(m=>m.Destination==='/workspace/projects/two'));
 assert.ok(e.volumes.has('canopy-home-'+a.storageId));assert.ok(e.volumes.has('canopy-home-'+b.storageId));
 const viewer=memberRuntime(parent,principal('alice',3,'view'),access(['one']));await host.open(viewer,{resume:true});assert.equal(viewer.storageId,a.storageId);assert.equal(projectMounts(viewer)[0][2],false);
 assert.equal(e.containers.has('canopy-ws-'+narrowed.id),false);assert.equal(e.containers.get('canopy-ws-'+viewer.id).Mounts.find(m=>m.Destination==='/workspace/projects/one').RW,false);
});
test('a forged storage selector cannot mount or stop another member home',async()=>{
 const e=engine(),host=new DockerWorkspaces({secret:'synthetic',docker:e.docker,verifyCapacity:async()=>{}}),a=memberRuntime(parent,principal('alice',1),access(['one'])),b=memberRuntime(parent,principal('bob',1),access(['two']));await host.open(b,{resume:true});
 await assert.rejects(host.open({...a,storageId:b.storageId},{resume:true}),/storage ownership/);assert.equal(e.containers.get('canopy-ws-'+b.id).State.Running,true);
});

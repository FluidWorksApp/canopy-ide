import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerWorkspaces, safeDockerError } from './docker.mjs';
import {projectMounts} from './project-mounts.mjs';

test('Docker failures never expose secret-bearing command arguments', () => {
  const secret = 'synthetic-secret';
  const safe = safeDockerError({ message: `docker run --env TOKEN=${secret}`, stderr: `error with ${secret}` }, 'run');
  assert.ok(!safe.message.includes(secret));
  assert.equal(safe.stderr, undefined);
  assert.equal(safe.missingResource, false);
  assert.equal(safeDockerError({ stderr: 'error: no such object: synthetic' }, 'inspect').missingResource, true);
});

test('workspace start is single-flight and mandates cgroup limits, private volumes, loopback, and read-only pools', async () => {
  const calls = []; let inspections = 0;
  const docker = async args => {
    calls.push(args);
    if(args[0]==='volume')return {stdout:JSON.stringify([{Name:args[2],Driver:'local',Labels:{'canopy.workspace':'alice','canopy.project':'app'}}])};
    if (args[0] === 'inspect' && inspections++ === 0) throw Object.assign(new Error('missing'), { stderr: 'error: no such object' });
    if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('missing'), { stderr: 'Error response from daemon: network example not found' });
    if (args[0] === 'inspect') return { stdout: JSON.stringify([{ NetworkSettings: { Networks: {'canopy-net-alice': {IPAddress: '172.18.0.2'}}, Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '45000' }] } } }]) };
    return { stdout: '' };
  };
  const host = new DockerWorkspaces({ secret: 'test', docker });
  const workspace = { id: 'alice', memoryMiB: 2048, cpus: 2, accounts: ['private', 'shared'],projectMounts:[{id:'app',writable:false}] };
  const [a, b] = await Promise.all([host.open(workspace), host.open(workspace)]);
  assert.deepEqual(a, b);
  const run = calls.filter(args => args[0] === 'run' && args.includes('-d')); assert.equal(run.length, 1);
  const command = run[0];
  assert.equal(command[command.indexOf('--restart')+1],'on-failure:3');
  for (const flag of ['--memory', '--memory-swap', '--cpus', '--pids-limit', '--cap-drop', '--security-opt']) assert.ok(command.includes(flag));
  assert.equal(command[command.indexOf('--pids-limit')+1],'8192','a config without pidsLimit keeps the default');
  assert.ok(command.includes('127.0.0.1::8080'));
  assert.ok(command.includes('type=volume,source=canopy-account-shared,target=/accounts/shared,readonly'));
  assert.ok(!command.some(arg => arg.includes('docker.sock')));
  const [target,source]=projectMounts(workspace)[0];
  assert.ok(command.includes(`type=volume,source=${source},target=${target},readonly`));
});

test('container reuse rejects a changed project volume, network or added capability', async () => {
  const workspace = { id: 'alice', memoryMiB: 2048, cpus: 2, accounts: ['team'] };
  let current;
  const host = new DockerWorkspaces({ secret: 'test', docker: async () => ({ stdout: JSON.stringify([current]) }) });
  const original = {
    Config: { Labels: { 'canopy.workspace': 'alice' }, Image: 'canopy-workspace:0.1.0', User: '1000:1000',
      Env: [`CANOPY_RUNNER_TOKEN=${host.token('alice')}`, 'CANOPY_ACCOUNTS=team'] },
    HostConfig: { Memory: 2048 * 1024 * 1024, MemorySwap: 3584 * 1024 * 1024, NanoCpus: 2e9,
      RestartPolicy:{Name:'on-failure',MaximumRetryCount:3}, PidsLimit: 1024, CapDrop: ['ALL'], CapAdd: [], NetworkMode: 'canopy-net-alice', SecurityOpt: ['no-new-privileges:true'] },
    Mounts: [ { Type: 'volume', Destination: '/workspace', Name: 'canopy-project-alice', RW: true },
      { Type: 'volume', Destination: '/home/agent', Name: 'canopy-home-alice', RW: true },
      { Type: 'volume', Destination: '/accounts/team', Name: 'canopy-account-team', RW: false } ],
    State: { Running: true }, NetworkSettings: { Networks: {'canopy-net-alice': {IPAddress: '172.18.0.2'}}, Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '45000' }] } },
  };
  current = structuredClone(original); assert.ok((await host.ensure(workspace)).url);
  workspace.projectMounts=[{id:'app',writable:false}];
  await assert.rejects(host.ensure(workspace),/configuration differs/);
  const [Destination,Name,RW]=projectMounts(workspace)[0];
  current.Mounts.push({Type:'volume',Destination,Name,RW});
  assert.ok((await host.ensure(workspace)).url);
  workspace.projectMounts[0].writable=true;
  await assert.rejects(host.ensure(workspace),/configuration differs/);
  workspace.projectMounts=[];
  await assert.rejects(host.ensure(workspace),/configuration differs/);
  current=structuredClone(original);
  workspace.memoryMaxMiB=8192;current.HostConfig.Memory=4096*1048576;current.HostConfig.MemorySwap=current.HostConfig.Memory*1.75;
  assert.ok((await host.ensure(workspace)).url);
  for(const invalid of [undefined,1024*1048576,16384*1048576]){current.HostConfig.Memory=invalid;current.HostConfig.MemorySwap=invalid;await assert.rejects(host.ensure(workspace),/configuration differs/);}
  workspace.cpusMax=4;current=structuredClone(original);current.HostConfig.NanoCpus=3e9;
  assert.ok((await host.ensure(workspace)).url);
  for(const invalid of [undefined,1e9,5e9]){current.HostConfig.NanoCpus=invalid;await assert.rejects(host.ensure(workspace),/configuration differs/);}
  for(const valid of [1024,4096,8192]){current=structuredClone(original);current.HostConfig.PidsLimit=valid;assert.ok((await host.ensure(workspace)).url);}
  for(const invalid of [undefined,0,-1,512,8193,1024.5]){current=structuredClone(original);current.HostConfig.PidsLimit=invalid;await assert.rejects(host.ensure(workspace),/configuration differs/);}
  // The plan catalog's pidsLimit raises the ceiling; containers below it stay valid.
  workspace.pidsLimit=16384;
  for(const valid of [1024,8192,16384]){current=structuredClone(original);current.HostConfig.PidsLimit=valid;assert.ok((await host.ensure(workspace)).url);}
  current=structuredClone(original);current.HostConfig.PidsLimit=16385;await assert.rejects(host.ensure(workspace),/configuration differs/);
  delete workspace.pidsLimit;
  for (const change of [c => { c.Mounts[0].Name = 'canopy-project-bob'; }, c => { c.HostConfig.NetworkMode = 'host'; }, c => { c.HostConfig.CapAdd = ['SYS_ADMIN']; },...['PidMode','IpcMode','UTSMode'].flatMap(key=>['host','container:other','shareable','unknown'].map(value=>c=>{c.HostConfig[key]=value;})),...['no-new-privileges:false','no-new-privileges=false','no-new-privileges:1','no-new-privileges-not-enabled'].map(value=>c=>{c.HostConfig.SecurityOpt=[value];}),c=>{c.HostConfig.SecurityOpt=['no-new-privileges:true','no-new-privileges:false'];}]) {
    current = structuredClone(original); change(current);
    await assert.rejects(host.ensure(workspace), /configuration differs/);
  }
  for(const security of ['no-new-privileges','no-new-privileges:true','no-new-privileges=true']){
    current=structuredClone(original);current.HostConfig.PidMode='';current.HostConfig.IpcMode='private';current.HostConfig.UTSMode='';current.HostConfig.SecurityOpt=[security];
    assert.ok((await host.ensure(workspace)).url);
    current.State={Running:false,ExitCode:0};assert.ok((await host.ensure(workspace,{resume:true})).url);
  }
  current=structuredClone(original);current.State={Running:false,ExitCode:0};
  const calls=[];const inspect=host.docker;host.docker=async args=>{calls.push(args);return inspect(args);};
  await assert.rejects(host.ensure(workspace),/runtime is stopped/);
  assert.equal(calls.some(args=>args[0]==='start'),false);
  assert.ok((await host.ensure(workspace,{resume:true})).url);
  assert.equal(calls.filter(args=>args[0]==='start').length,1);
  current.HostConfig.RestartPolicy={Name:'unless-stopped'};
  await assert.rejects(host.ensure(workspace,{resume:true}),/configuration differs/);
  current=structuredClone(original);
  host.releaseChannel='ghcr.io/fluidworksapp/canopy-workspace:stable';
  current.Config.Labels['canopy.image-channel']=host.releaseChannel;
  current.Config.Image='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'a'.repeat(64);current.Image='sha256:'+'b'.repeat(64);
  host.resolveRelease=async()=>{throw Error('Running container must not consult releases');};
  assert.ok((await host.ensure(workspace,{resume:true})).url);
});
test('resource changes and workspace admission share one serial lock',async()=>{
 const host=new DockerWorkspaces({secret:'test'}),order=[];let release;
 const held=new Promise(resolve=>{release=resolve;});
 const first=host.withResourceLock(async()=>{order.push('first');await held;order.push('released');});
 const second=host.withResourceLock(async()=>{order.push('second');});
 await Promise.resolve();assert.deepEqual(order,['first']);release();await Promise.all([first,second]);assert.deepEqual(order,['first','released','second']);
});

test('CPU resizing validates bounds and confirms the Docker quota',async()=>{
 const calls=[];let confirmed=2e9;
 const host=new DockerWorkspaces({secret:'test',docker:async args=>{calls.push(args);return {stdout:JSON.stringify([{HostConfig:{NanoCpus:confirmed}}])};}});
 const w={id:'alice',cpus:1,cpusMax:4};await host.updateCpus(w,2);
 assert.deepEqual(calls[0],['update','--cpus','2','canopy-ws-alice']);
 for(const size of [0,5,NaN])await assert.rejects(host.updateCpus(w,size),/outside workspace bounds/);
 confirmed=1e9;await assert.rejects(host.updateCpus(w,2),/did not confirm/);
});

test('optional swap allowance is preserved during elastic memory updates',async()=>{
 const {memorySwapMiB}=await import('./docker.mjs');assert.equal(memorySwapMiB({},3072),5376);assert.equal(memorySwapMiB({swapRatio:0.75},3072),5376);
 const calls=[];const host=new DockerWorkspaces({secret:'test',docker:async args=>{calls.push(args);return {stdout:JSON.stringify([{HostConfig:{Memory:4096*1048576,MemorySwap:7168*1048576}}])};}});
 await host.updateMemory({id:'alice',memoryMiB:3072,memoryMaxMiB:16384,swapRatio:0.75},4096);
 assert.deepEqual(calls[0],['update','--memory','4096m','--memory-swap','7168m','canopy-ws-alice']);
});

test('helper cleanup does not clear owner migration recovery or allow a cached runtime through',async()=>{
 const workspace={id:'owner',memoryMiB:1024,cpus:1,accounts:[]};
 const host=new DockerWorkspaces({secret:'test',docker:async()=>({stdout:''})});
 host.runtimes.set('owner',{runtime:{url:'cached'},fingerprint:JSON.stringify(workspace),checkedAt:Date.now()});
 host.migrationCleanupRequired.add('owner');
 await host.recoverMigrations();
 assert.equal(host.migrationCleanupRequired.has('owner'),true);
 await assert.rejects(host.open(workspace),/requires recovery/);
});

test('quarantined workspaces cannot be resized while recovery is pending',async()=>{
 let calls=0;
 const host=new DockerWorkspaces({secret:'test',docker:async()=>{calls++;throw Error('Unexpected Docker call');}});
 host.migrationCleanupRequired.add('owner');
 for(const workspace of [{id:'owner'},{id:'member',parentWorkspaceId:'owner'}]){
  await assert.rejects(host.updateMemory(workspace,4096),/requires recovery/);
  await assert.rejects(host.updateCpus(workspace,2),/requires recovery/);
 }
 assert.equal(calls,0);
});

test('failed fresh release lookup cannot mutate a stopped workspace',async()=>{
 const calls=[];let lookups=0;
 const host=new DockerWorkspaces({secret:'test',releaseChannel:'ghcr.io/fluidworksapp/canopy-workspace:stable',resolveRelease:async()=>{lookups++;throw Error('Authority unavailable');},docker:async args=>{calls.push(args);return {stdout:JSON.stringify([{State:{Running:false}}])};}});
 const workspace={id:'alice',accounts:[],memoryMiB:2048,cpus:2};
 await assert.rejects(host.ensure(workspace,{resume:true}),/Authority unavailable/);
 assert.equal(lookups,1);assert.deepEqual(calls.map(c=>c[0]),['inspect']);
 await assert.rejects(host.ensure({...workspace,memberId:'member'},{resume:true}));
 assert.equal(lookups,2,'member resume also requires fresh base-image authority');
});

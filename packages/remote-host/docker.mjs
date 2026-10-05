import {pullWorkspaceImage} from './image-release.mjs';
import {imageUpgradeJournal,upgradeRuntimeImage} from './image-upgrade.mjs';
import {waitForRuntimeReady} from './runtime-readiness.mjs';
import {hostResources} from './host-resources.mjs';
import {verifyCapacityGroup} from './capacity-group.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createHmac } from 'node:crypto';
import { validId } from './policy.mjs';
import {memoryRange, hostMemory, growthCapacity} from './elastic-memory.mjs';
import {cpuRange} from './elastic-cpu.mjs';
import {projectMounts} from './project-mounts.mjs';
import {prepareProjectVolumes} from './project-volumes.mjs';
import {migrateProjectVolume} from './migrate-project-volume.mjs';
import {checkpointOwner} from './owner-checkpoint.mjs';
const exec = promisify(execFile);


export function safeDockerError(error, operation) {
  // execFile's message includes the complete argv, including runner secrets.
  // Retain only the classification needed for missing-resource handling.
  const safe = new Error(`Docker workspace ${operation} failed`);
  safe.missingResource = /no such|network .* not found/i.test(String(error.stderr));
  return safe;
}
async function dockerCommand(args) {
  try { return await exec('docker', args, { timeout: args[0]==='pull'?600_000:120_000, maxBuffer: 1024 * 1024 }); }
  catch (error) { throw safeDockerError(error, args[0]); }
}

export function memorySwapMiB(workspace,memoryMiB){return Math.round(memoryMiB*(1+(workspace.swapRatio??0.75)));}

export class DockerWorkspaces {
  pending = new Map();
  runtimes = new Map();
  migrationCleanupRequired = new Set();
  migrationHelperCleanupRequired = new Set();
  constructor({ secret, image = 'canopy-workspace:0.1.0', docker = dockerCommand, registry = [], readHost = hostMemory, verifyCapacity = verifyCapacityGroup, readResources = hostResources, releaseChannel, resolveRelease, upgradeDirectory }) {
    this.secret = secret; this.image = image; this.docker = docker; this.registry = registry; this.readHost = readHost; this.verifyCapacity = verifyCapacity; this.readResources = readResources;
    this.releaseChannel=releaseChannel;this.resolveRelease=resolveRelease;this.upgradeDirectory=upgradeDirectory;
    this.resourceTail = Promise.resolve();
  }
  withResourceLock(action) {
    const result = this.resourceTail.then(action);
    this.resourceTail = result.catch(() => {}); return result;
  }
  migrateProject(workspace,project){
    return this.withResourceLock(async()=>{
      if(this.migrationCleanupRequired.has(workspace.id))throw Error('Workspace migration requires recovery');
      try{return await migrateProjectVolume(workspace,project,{docker:this.docker,image:this.image});}
      catch(error){if(error.migrationCleanupRequired){this.migrationCleanupRequired.add(workspace.id);this.migrationHelperCleanupRequired.add(workspace.id);}throw error;}
    });
  }
  checkpointOwner(workspace){
    return this.withResourceLock(()=>checkpointOwner(workspace,{docker:this.docker}));
  }
  async recoverMigrations(){
    return this.withResourceLock(async()=>{
      const result=await this.docker(['ps','--all','--filter','label=canopy.migration=true','--format','{{.Names}}']);
      for(const name of result.stdout.trim().split('\n').filter(Boolean)){
        if(!/^canopy-migrate-[0-9a-f-]{36}$/.test(name))throw Error('Unexpected migration helper');
        let current;
        try{current=JSON.parse((await this.docker(['inspect',name])).stdout)[0];}
        catch(error){if(error.missingResource)continue;throw error;}
        const labels=current?.Config?.Labels;
        if(labels?.['canopy.migration']!=='true'||!this.registry.some(w=>w.id===labels['canopy.workspace']))throw Error('Migration helper ownership differs');
        await this.docker(['rm','--force',name]);
      }
      // Helper cleanup cannot resolve an interrupted owner-container replacement.
      for(const id of this.migrationHelperCleanupRequired)this.migrationCleanupRequired.delete(id);
      this.migrationHelperCleanupRequired.clear();
    });
  }
  async resourceSnapshot(registry, sample = true) {
    const result = [];
    for (const workspace of registry) {
      let inspected;
      try { inspected = JSON.parse((await this.docker(['inspect', `canopy-ws-${workspace.id}`])).stdout)[0]; }
      catch (error) { if (!error.missingResource) throw error; }
      if (inspected && inspected.Config.Labels?.['canopy.workspace'] !== workspace.id) throw Error('Workspace ownership differs');
      const entry = {id: workspace.id, minMiB: workspace.memoryMiB, memoryMiB: inspected?.HostConfig.Memory / 1048576 || workspace.memoryMiB, cpus: inspected ? inspected.HostConfig.NanoCpus / 1e9 : workspace.cpus, running: inspected?.State.Running ?? false};
      if (sample && entry.running && (memoryRange(workspace).max > workspace.memoryMiB || cpuRange(workspace).max > workspace.cpus)) {
        Object.assign(entry, await this.readResources(inspected));
      }
      result.push(entry);
    }
    return result;
  }
  async updateMemory(workspace, memoryMiB) {
    if(this.migrationCleanupRequired.has(workspace.parentWorkspaceId??workspace.id))throw Error('Workspace migration requires recovery');
    const {min,max} = memoryRange(workspace);
    if (!Number.isInteger(memoryMiB) || memoryMiB < min || memoryMiB > max) throw Error('Memory allocation outside workspace bounds');
    await this.docker(['update','--memory',`${memoryMiB}m`,'--memory-swap',`${memorySwapMiB(workspace,memoryMiB)}m`,`canopy-ws-${workspace.id}`]);
    const inspected = JSON.parse((await this.docker(['inspect', `canopy-ws-${workspace.id}`])).stdout)[0];
    if (inspected?.HostConfig.Memory !== memoryMiB * 1048576 || inspected?.HostConfig.MemorySwap !== memorySwapMiB(workspace,memoryMiB) * 1048576) throw Error('Docker did not confirm the memory allocation');
  }
  async updateCpus(workspace, cpus) {
    if(this.migrationCleanupRequired.has(workspace.parentWorkspaceId??workspace.id))throw Error('Workspace migration requires recovery');
    const {min,max} = cpuRange(workspace);
    if (!Number.isFinite(cpus) || cpus < min || cpus > max) throw Error('CPU allocation outside workspace bounds');
    await this.docker(['update', '--cpus', String(cpus), `canopy-ws-${workspace.id}`]);
    const inspected = JSON.parse((await this.docker(['inspect', `canopy-ws-${workspace.id}`])).stdout)[0];
    if (inspected?.HostConfig.NanoCpus !== Math.round(cpus * 1e9)) throw Error('Docker did not confirm the CPU allocation');
  }
  token(id) { return createHmac('sha256', this.secret).update(`workspace:${id}`).digest('hex'); }
  async suspendUnleasedMembers(){
    const result=await this.docker(['ps','--all','--filter','name=^/canopy-ws-member-','--format','{{.Names}}']);
    for(const name of result.stdout.trim().split('\n').filter(Boolean)){
      if(!/^canopy-ws-member-[a-f0-9]{40}$/.test(name))throw Error('Unexpected member runtime name');
      await this.suspendMember({id:name.slice('canopy-ws-'.length),parentWorkspaceId:'recovery'});
    }
  }
  async suspendMember(workspace) {
    if(!/^member-[a-f0-9]{40}$/.test(workspace.id)||!validId(workspace.parentWorkspaceId))throw Error('Invalid member runtime');
    return this.withResourceLock(async()=>{
      const name=`canopy-ws-${workspace.id}`;
      let current;
      try{current=JSON.parse((await this.docker(['inspect',name])).stdout)[0];}
      catch(error){if(error.missingResource)return;throw error;}
      if(current?.Config?.Labels?.['canopy.workspace']!==workspace.id)throw Error('Member runtime ownership differs');
      this.runtimes.delete(workspace.id);
      // Disable daemon recovery before checking/stopping, including when Docker
      // is between a crash and an automatic restart.
      await this.docker(['update','--restart','no',name]);
      if(current.State?.Running)await this.docker(['stop','--time','5',name]);
      const stopped=JSON.parse((await this.docker(['inspect',name])).stdout)[0];
      if(stopped?.State?.Running!==false)throw Error('Member runtime did not stop');
    });
  }
  async inspectRuntime(workspace){
    if(!validId(workspace.id))throw Error('Invalid runtime workspace');
    let current;
    try{current=JSON.parse((await this.docker(['inspect',`canopy-ws-${workspace.id}`])).stdout)[0];}
    catch(error){if(error.missingResource)return null;throw error;}
    if(current?.Config?.Labels?.['canopy.workspace']!==workspace.id)throw Error('Runtime ownership differs');
    if(!/^[a-f0-9]{64}$/.test(current.Id??''))throw Error('Runtime identity is unavailable');
    return current;
  }
  async recoverRuntime(workspace,containerId,{authorize,reserve}){
    return this.withResourceLock(async()=>{
      if(this.migrationCleanupRequired.has(workspace.parentWorkspaceId??workspace.id))throw Error('Workspace migration requires recovery');
      if(!await authorize())return false;
      const current=await this.inspectRuntime(workspace);
      if(!current||current.Id!==containerId||!current.State?.Running||current.State.Paused||current.State.Restarting)return false;
      if(current.HostConfig?.RestartPolicy?.Name!=='on-failure'||current.HostConfig.RestartPolicy.MaximumRetryCount!==3)throw Error('Runtime restart policy requires update');
      await reserve();
      // Kill refuses an already-exited container. Unlike `docker restart`, it
      // cannot resurrect an intentional exit racing the observation. The bounded
      // daemon policy performs recovery; this path never manually starts compute.
      await this.docker(['kill','--signal','SIGKILL',`canopy-ws-${workspace.id}`]);
      this.runtimes.delete(workspace.id);
      let after=await this.inspectRuntime(workspace);const deadline=Date.now()+10000;
      while(after?.Id===containerId&&!after.State?.Running&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,250));after=await this.inspectRuntime(workspace);}
      if(after?.Id!==containerId||after.State?.Running!==true)throw Error('Runtime recovery could not be confirmed');
      const runtime=await this.ensure(workspace);
      this.runtimes.set(workspace.id,{workspace,runtime,fingerprint:JSON.stringify([workspace,false]),checkedAt:Date.now()});
      return true;
    });
  }
  async open(workspace,{resume=false}={}) {
    if(this.migrationCleanupRequired.has(workspace.parentWorkspaceId??workspace.id))throw Error('Workspace migration requires recovery');
    // A changed grant must bypass both the short cache and an in-flight open.
    const fingerprint = JSON.stringify([workspace,resume]);
    const cached=this.runtimes.get(workspace.id);
    if(!resume&&cached&&cached.fingerprint===fingerprint&&Date.now()-cached.checkedAt<2000)return cached.runtime;
    const pending=this.pending.get(workspace.id);
    if(pending && pending.fingerprint!==fingerprint){await pending.promise.catch(()=>{});return this.open(workspace,{resume});}
    if (!this.pending.has(workspace.id)) {
      const opening = this.withResourceLock(() => this.ensure(workspace,{resume})).then(runtime=>{this.runtimes.set(workspace.id,{workspace,runtime,fingerprint,checkedAt:Date.now()});return runtime;}).finally(() => this.pending.delete(workspace.id));
      this.pending.set(workspace.id, {promise:opening,fingerprint});
    }
    return this.pending.get(workspace.id).promise;
  }
  async ensure(workspace,{resume=false,releaseImage}={}) {
    if(this.migrationCleanupRequired.has(workspace.parentWorkspaceId??workspace.id))throw Error('Workspace migration requires recovery');
    if (!validId(workspace.id) || !workspace.accounts.every(validId)) throw new Error('Invalid workspace');
    if(workspace.ownerImage!=null&&(workspace.memberId||!/^sha256:[a-f0-9]{64}$/.test(workspace.ownerImage)))throw Error('Invalid owner image checkpoint');
    let image=releaseImage??workspace.ownerImage??this.image;
    const projects=projectMounts(workspace);
    if(workspace.cgroupParent!=null&&!/^canopy-[a-z0-9]+\.slice$/.test(workspace.cgroupParent))throw Error('Invalid capacity group');
    if(workspace.cgroupParent)await this.verifyCapacity(workspace);
    const name = `canopy-ws-${workspace.id}`;
    let existing;
    try { existing = JSON.parse((await this.docker(['inspect', name])).stdout)[0]; }
    catch (error) { if (!error.missingResource && !/no such/i.test(String(error.stderr))) throw error; }
    let release;
    if(this.releaseChannel&&!releaseImage){
      if(!existing||(resume&&existing.State?.Running===false)){
        const reference=this.resolveRelease?await this.resolveRelease(workspace):this.releaseChannel;
        release=await pullWorkspaceImage(reference,{docker:this.docker});
        image=existing?existing.Config.Image:release.reference;
      }else if(existing.Config?.Labels?.['canopy.image-channel']===this.releaseChannel)image=existing.Config.Image;
    }
    if (existing) {
      if (existing.Config.Labels?.['canopy.workspace'] !== workspace.id ||
          existing.Config.Image !== image ||
          !existing.Config.Env?.includes(`CANOPY_RUNNER_TOKEN=${this.token(workspace.id)}`) ||
          !existing.Config.Env?.includes(`CANOPY_ACCOUNTS=${workspace.accounts.join(',')}`) ||
          !Number.isInteger(existing.HostConfig.Memory) ||
          existing.HostConfig.Memory < workspace.memoryMiB * 1024 * 1024 ||
          existing.HostConfig.Memory > memoryRange(workspace).max * 1024 * 1024 ||
          existing.HostConfig.MemorySwap !== memorySwapMiB(workspace,existing.HostConfig.Memory/1048576)*1048576 ||
          !Number.isInteger(existing.HostConfig.NanoCpus) ||
          existing.HostConfig.NanoCpus < workspace.cpus * 1_000_000_000 ||
          existing.HostConfig.NanoCpus > cpuRange(workspace).max * 1_000_000_000 ||
          existing.HostConfig.PidsLimit !== 1024 ||
          ((existing.HostConfig.RestartPolicy?.Name!=='on-failure'||existing.HostConfig.RestartPolicy?.MaximumRetryCount!==3)&&!(workspace.memberId&&resume&&existing.State?.Running===false&&existing.HostConfig.RestartPolicy?.Name==='no')) ||
          (workspace.cgroupParent!=null && existing.HostConfig.CgroupParent!==workspace.cgroupParent) ||
          existing.HostConfig.Privileged || existing.HostConfig.CapAdd?.length ||
          existing.HostConfig.NetworkMode !== `canopy-net-${workspace.id}` || existing.Config.User !== '1000:1000' ||
          !existing.HostConfig.CapDrop?.includes('ALL') ||
          !existing.HostConfig.SecurityOpt?.some(value => value.startsWith('no-new-privileges')) ||
          existing.Mounts?.some(mount => mount.Type !== 'volume') ||
          JSON.stringify(existing.Mounts?.map(m => [m.Destination, m.Name, m.RW]).sort()) !==
            JSON.stringify([['/workspace', `canopy-project-${workspace.id}`, true], ['/home/agent', `canopy-home-${workspace.id}`, true], ...workspace.accounts.map(id => [`/accounts/${id}`, `canopy-account-${id}`, false]), ...projects].sort())) throw new Error('Workspace container configuration differs; administrator action required');
      if(!existing.State.Running&&!resume)throw Error('Workspace runtime is stopped. Resume the workspace to continue');
      if(release&&existing.Image!==release.imageId){
        try{return await upgradeRuntimeImage(workspace,existing,release,{docker:this.docker,journal:imageUpgradeJournal(this.upgradeDirectory,workspace.id),launch:reference=>this.ensure(workspace,{releaseImage:reference}),verify:waitForRuntimeReady});}
        catch(error){this.runtimes.delete(workspace.id);if(!error.imageUpgradeRolledBack)this.migrationCleanupRequired.add(workspace.id);throw error;}
      }
      if(workspace.memberId&&resume&&existing.HostConfig.RestartPolicy?.Name==='no')await this.docker(['update','--restart','on-failure:3',name]);
      if (!existing.State.Running && existing.HostConfig.Memory !== workspace.memoryMiB * 1024 * 1024) {
        await this.updateMemory(workspace, workspace.memoryMiB); existing.HostConfig.Memory = workspace.memoryMiB * 1024 * 1024;
      }
      if (!existing.State.Running && existing.HostConfig.NanoCpus !== workspace.cpus * 1e9) {
        await this.updateCpus(workspace, workspace.cpus);
      }
      if (this.registry.length && !workspace.cgroupParent) {
        const samples = await this.resourceSnapshot(this.registry, false);
        const host = await this.readHost();
        // Existing ceilings have already been budgeted. Check total host
        // capacity, not transient MemAvailable, when attaching to live work.
        host.availableMiB = host.totalMiB;
        if (existing.HostConfig.Memory / 1048576 > growthCapacity(workspace, samples, host)) throw Error('Workspace exceeds available host capacity');
      }
      if (!existing.State.Running) await this.docker(['start', name]);
    } else {
      await prepareProjectVolumes(workspace,{docker:this.docker,image:this.image});
      if (this.registry.length && !workspace.cgroupParent && workspace.memoryMiB > growthCapacity(workspace, await this.resourceSnapshot(this.registry, false), await this.readHost())) throw Error('Workspace minimum exceeds available host capacity');
      const network = `canopy-net-${workspace.id}`;
      try { await this.docker(['network', 'inspect', network]); }
      catch (error) {
        if (!error.missingResource && !/no such|network .* not found/i.test(String(error.stderr))) throw error;
        await this.docker(['network', 'create', '--opt', `com.docker.network.bridge.name=cnp${createHash('sha256').update(workspace.id).digest('hex').slice(0,12)}`, '--label', `canopy.workspace=${workspace.id}`, network]);
      }
      const accounts = workspace.accounts.flatMap(account => ['--mount', `type=volume,source=canopy-account-${account},target=/accounts/${account},readonly`]);
      await this.docker(['run', '-d', '--name', name, '--label', `canopy.workspace=${workspace.id}`,
        ...(this.releaseChannel?['--label',`canopy.image-channel=${this.releaseChannel}`]:[]),
        ...(workspace.cgroupParent?['--cgroup-parent',workspace.cgroupParent]:[]),
        '--network', network, '--init', '--restart', 'on-failure:3', '--user', '1000:1000',
        '--memory', `${workspace.memoryMiB}m`, '--memory-swap', `${memorySwapMiB(workspace,workspace.memoryMiB)}m`,
        '--cpus', String(workspace.cpus), '--pids-limit', '1024', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--shm-size', '256m',
        '--publish', '127.0.0.1::8080', '--env', `CANOPY_RUNNER_TOKEN=${this.token(workspace.id)}`,
        '--env', `CANOPY_WORKSPACE_ID=${workspace.id}`, '--env', `CANOPY_ACCOUNTS=${workspace.accounts.join(',')}`,
        '--mount', `type=volume,source=canopy-project-${workspace.id},target=/workspace`,
        '--mount', `type=volume,source=canopy-home-${workspace.id},target=/home/agent`,
        ...accounts, ...projects.flatMap(([target,source,writable])=>['--mount',`type=volume,source=${source},target=${target}${writable?'':',readonly'}`]), image]);
    }
    const inspected = JSON.parse((await this.docker(['inspect', name])).stdout)[0];
    const port = inspected.NetworkSettings.Ports?.['8080/tcp']?.[0];
    if (port?.HostIp !== '127.0.0.1' || !/^\d+$/.test(port.HostPort)) throw new Error('Workspace endpoint is not private');
    const address = inspected.NetworkSettings.Networks?.[`canopy-net-${workspace.id}`]?.IPAddress;
    if (!address || !/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new Error('Workspace network unavailable');
    return { url: `http://127.0.0.1:${port.HostPort}`, nativeUrl: `http://${address}:8081`, token: this.token(workspace.id) };
  }
}

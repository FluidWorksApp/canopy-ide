import os from 'node:os';

export function cpuRange(workspace) {
  return {min: workspace.cpus, max: workspace.cpusMax ?? workspace.cpus};
}
export function hostCpus() { return os.availableParallelism(); }

// CPU quotas are ceilings, not exclusive core reservations. The scheduler
// shares cores between busy containers; never advertise more than the host has.
export function cpuDecision(workspace, sample, state, now, hostCapacity) {
  const {min,max} = cpuRange(workspace), current = sample.cpus;
  const counters = [sample.cpuUsageUsec, sample.cpuPeriods, sample.cpuThrottledPeriods];
  if (![current, now, hostCapacity, ...counters].every(Number.isFinite) ||
      current < min || current > max || hostCapacity <= 0 || counters.some(n => n < 0))
    throw Error('Invalid workspace CPU sample');
  const capacity = Math.min(max, Math.floor(hostCapacity * 4) / 4);
  const next = {...state, sampledAt:now, usage:sample.cpuUsageUsec,
    periods:sample.cpuPeriods, throttled:sample.cpuThrottledPeriods, cpus:current};
  const delta = now - state.sampledAt, usage = sample.cpuUsageUsec - state.usage;
  const periods = sample.cpuPeriods - state.periods, throttled = sample.cpuThrottledPeriods - state.throttled;
  // Prime after startup, counter resets, or external quota changes. Never grow
  // from cumulative counters without a measured interval.
  if (!Number.isFinite(delta) || delta < 1000 || usage < 0 || periods < 0 || throttled < 0 || state.cpus !== current)
    return {state:{...next, highSince:null, lowSince:null}, target:null, status:max === min ? 'fixed' : 'steady'};
  const utilization = usage / (delta * 1000) / current;
  const pressured = utilization >= .80 || (utilization >= .50 && periods > 0 && throttled / periods >= .20);
  next.highSince = pressured ? (state.highSince ?? now) : null;
  const quiet = sample.activeSessions === 0 && utilization <= .30;
  next.lowSince = quiet ? (state.lowSince ?? now) : null;
  const elapsed = state.lastResize == null ? Infinity : now - state.lastResize;
  if (pressured && now - next.highSince >= 10_000 && elapsed >= 30_000) {
    const target = Math.min(current + 1, max, capacity);
    if (target > current) return {state:next,target,status:'growing'};
    return {state:next,target:null,status:current >= max ? 'maximum' : 'host_capacity'};
  }
  if (quiet && now - next.lowSince >= 600_000 && elapsed >= 300_000 && current > min)
    return {state:next,target:Math.max(min,current - 1),status:'shrinking'};
  return {state:next,target:null,status:max === min ? 'fixed' : 'steady'};
}

export class ElasticCpu {
  constructor({registry,docker,readHost=hostCpus,now=Date.now}) {
    this.registry=registry; this.docker=docker; this.readHost=readHost; this.now=now;
    this.states=new Map(); this.statuses=new Map(); this.stopped=false;
  }
  status(id) { return this.statuses.get(id) ?? null; }
  async tick() {
    return this.docker.withResourceLock(async()=>{
      const capacity=await this.readHost();
      const snapshots=await this.docker.resourceSnapshot(this.registry);
      for (const workspace of this.registry) {
        if(this.docker.migrationCleanupRequired?.has(workspace.id))continue;
        const {min,max}=cpuRange(workspace);
        if (min===max) continue;
        const sample=snapshots.find(s=>s.id===workspace.id);
        if (!sample?.running) continue;
        const decision=cpuDecision(workspace,sample,this.states.get(workspace.id) ?? {},this.now(),capacity);
        this.states.set(workspace.id,decision.state);
        let status=decision.status;
        if (decision.target != null) {
          try {
            await this.docker.updateCpus(workspace,decision.target);
            sample.cpus=decision.target;
            this.states.set(workspace.id,{...decision.state,cpus:sample.cpus,lastResize:this.now(),highSince:null,lowSince:null});
            status='steady';
          } catch {
            this.statuses.set(workspace.id,{minCpus:min,maxCpus:max,currentCpus:null,
              availableMaxCpus:Math.min(max,capacity),status:'update_failed',sampledAt:this.now()});
            return; // Resample the pool after an unconfirmed update.
          }
        }
        this.statuses.set(workspace.id,{minCpus:min,maxCpus:max,currentCpus:sample.cpus,
          availableMaxCpus:Math.min(max,capacity),status,sampledAt:this.now()});
      }
    });
  }
  start() {
    const run=async()=>{
      try { await this.tick(); } catch { /* Missing measurements never grant CPU. */ }
      finally { if (!this.stopped) { this.timer=setTimeout(run,10_000); this.timer.unref?.(); } }
    };
    void run();
  }
  stop() { this.stopped=true; clearTimeout(this.timer); }
}

import os from 'node:os';
import {readFile} from 'node:fs/promises';

const MiB = 1024 * 1024;
export const HOST_RESERVE_MIB = 2048;
export function memoryRange(workspace) {
  return {min: workspace.memoryMiB, max: workspace.memoryMaxMiB ?? workspace.memoryMiB};
}
export async function hostMemory() {
  const text = await readFile('/proc/meminfo', 'utf8');
  const available = Number(text.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]);
  if (!Number.isFinite(available)) throw Error('Host memory capacity unavailable');
  return {totalMiB: Math.floor(os.totalmem() / MiB), availableMiB: Math.floor(available / 1024)};
}

// A hard limit is a ceiling, not preallocated RAM. Account for every workspace
// running ceiling nonetheless: parallel growth must not promise the same capacity.
// Stopped workspaces release their reservation. Starting one must pass the same
// capacity check under the Docker resource lock before it consumes RAM again.
export function growthCapacity(workspace, snapshots, host) {
  const others = snapshots.filter(s => s.id !== workspace.id).reduce((sum, s) =>
    sum + (s.running ? Math.max(s.minMiB, s.memoryMiB) : 0), 0);
  const current = snapshots.find(s => s.id === workspace.id)?.memoryMiB ?? workspace.memoryMiB;
  return Math.max(0, Math.floor(Math.min(
    host.totalMiB - HOST_RESERVE_MIB - others,
    current + Math.max(0, host.availableMiB - HOST_RESERVE_MIB),
  ) / 256) * 256);
}

export function memoryDecision(workspace, sample, state, now, capacity) {
  const {min, max} = memoryRange(workspace), current = sample.memoryMiB;
  const used = sample.usedMiB, working = sample.workingMiB;
  if (![current, used, working, capacity].every(Number.isFinite) || current < min || current > max)
    throw Error('Invalid workspace memory sample');
  const next = {...state};
  const pressured = working >= current * .80 || (state.events != null && sample.events > state.events);
  const urgent = working >= current * .90 || (state.events != null && sample.events > state.events);
  next.events = sample.events;
  next.highSince = pressured ? (state.highSince ?? now) : null;
  const quiet = sample.activeSessions === 0 && working <= current * .30;
  next.lowSince = quiet ? (state.lowSince ?? now) : null;
  const elapsed = state.lastResize == null ? Infinity : now - state.lastResize;
  if (pressured && (urgent || now - next.highSince >= 10_000) && elapsed >= (urgent ? 10_000 : 30_000)) {
    const wanted = Math.min(max, Math.ceil(Math.max(current + 512, current * 1.5) / 256) * 256);
    const target = Math.min(wanted, capacity);
    if (target > current) return {state: next, target, status: 'growing'};
    return {state: next, target: null, status: current >= max ? 'maximum' : 'host_capacity'};
  }
  // No live PTYs may be present when shrinking. Leave at least 35% measured
  // headroom, including page cache; do not rely on working-set estimates alone.
  if (quiet && now - next.lowSince >= 600_000 && elapsed >= 300_000 && current > min) {
    const target = Math.max(min, current - 512, Math.ceil(used / .65 / 256) * 256);
    if (target < current) return {state: next, target, status: 'shrinking'};
  }
  return {state: next, target: null, status: max === min ? 'fixed' : 'steady'};
}

export class ElasticMemory {
  constructor({registry, docker, readHost = hostMemory, now = Date.now}) {
    this.registry = registry; this.docker = docker; this.readHost = readHost; this.now = now;
    this.states = new Map(); this.statuses = new Map(); this.stopped = false;
  }
  status(id) { return this.statuses.get(id) ?? null; }
  async tick() {
    return this.docker.withResourceLock(async () => {
      const host = await this.readHost();
      const snapshots = await this.docker.resourceSnapshot(this.registry);
      for (const workspace of this.registry) {
        if(this.docker.migrationCleanupRequired?.has(workspace.id))continue;
        const {min,max} = memoryRange(workspace);
        if (max === min) continue;
        const sample = snapshots.find(s => s.id === workspace.id);
        if (!sample?.running) continue;
        const capacity = growthCapacity(workspace, snapshots, host);
        const decision = memoryDecision(workspace, sample, this.states.get(workspace.id) ?? {}, this.now(), capacity);
        this.states.set(workspace.id, decision.state);
        let status = decision.status;
        if (decision.target != null) {
          try {
            await this.docker.updateMemory(workspace, decision.target);
            // Commit accounting only after Docker confirms the new cgroup limit.
            host.availableMiB -= Math.max(0, decision.target - sample.memoryMiB);
            sample.memoryMiB = decision.target;
            this.states.set(workspace.id, {...decision.state, lastResize: this.now(), highSince: null, lowSince: null});
            status = 'steady';
          } catch {
            // A failed CLI/inspection may have partially changed the cgroup.
            // Resample the entire pool next tick before making another grant.
            this.statuses.set(workspace.id, {minMiB:min,maxMiB:max,currentMiB:null,availableMaxMiB:Math.min(max,capacity),status:'update_failed',sampledAt:this.now()});
            return;
          }
        }
        this.statuses.set(workspace.id, {minMiB:min,maxMiB:max,currentMiB:sample.memoryMiB,
          availableMaxMiB:Math.min(max, capacity),status,sampledAt:this.now()});
      }
    });
  }
  start() {
    const run = async () => {
      try { await this.tick(); } catch { /* Fail closed: stale/missing samples never grant memory. */ }
      finally { if (!this.stopped) { this.timer = setTimeout(run, 10_000); this.timer.unref?.(); } }
    };
    void run();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}

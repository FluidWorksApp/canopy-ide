const INACTIVE_DELAY_MS = 60_000;
const MAX_PENDING_VIEWERS = 128;

interface Candidate {
  bytes: number;
  eligibleAt: number;
  release: () => void;
}

export interface ViewerByteRetentionMetrics {
  pendingViewers: number;
  pendingBytes: number;
  pendingViewersHighWater: number;
  pendingBytesHighWater: number;
  scheduled: number;
  cancelled: number;
  released: number;
  releasedBytes: number;
  rejected: number;
  failures: number;
}

const candidates = new Map<string, Candidate>();
let timer: ReturnType<typeof setTimeout> | null = null;
let metrics = emptyMetrics();

function emptyMetrics(): ViewerByteRetentionMetrics {
  return {
    pendingViewers: 0,
    pendingBytes: 0,
    pendingViewersHighWater: 0,
    pendingBytesHighWater: 0,
    scheduled: 0,
    cancelled: 0,
    released: 0,
    releasedBytes: 0,
    rejected: 0,
    failures: 0,
  };
}

function syncGauges(): void {
  metrics.pendingViewers = candidates.size;
  metrics.pendingBytes = [...candidates.values()].reduce(
    (sum, candidate) => sum + candidate.bytes,
    0,
  );
  metrics.pendingViewersHighWater = Math.max(
    metrics.pendingViewersHighWater,
    metrics.pendingViewers,
  );
  metrics.pendingBytesHighWater = Math.max(
    metrics.pendingBytesHighWater,
    metrics.pendingBytes,
  );
}

function clearTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

function nextCandidate(): [string, Candidate] | null {
  let next: [string, Candidate] | null = null;
  for (const entry of candidates) {
    if (!next || entry[1].eligibleAt < next[1].eligibleAt) next = entry;
  }
  return next;
}

function scheduleDrain(): void {
  clearTimer();
  const next = nextCandidate();
  if (!next) return;
  timer = setTimeout(
    drainOne,
    Math.max(0, next[1].eligibleAt - Date.now()),
  );
}

function drainOne(): void {
  timer = null;
  const next = nextCandidate();
  if (!next) return;
  const [ownerId, candidate] = next;
  if (candidate.eligibleAt > Date.now()) {
    scheduleDrain();
    return;
  }
  candidates.delete(ownerId);
  try {
    candidate.release();
    metrics.released += 1;
    metrics.releasedBytes += candidate.bytes;
  } catch (error) {
    metrics.failures += 1;
    console.warn("inactive viewer byte release failed", error);
  }
  syncGauges();
  scheduleDrain();
}

export function scheduleInactiveViewerBytes(
  ownerId: string,
  bytes: number,
  release: () => void,
  delayMs = INACTIVE_DELAY_MS,
): boolean {
  cancelInactiveViewerBytes(ownerId);
  if (candidates.size >= MAX_PENDING_VIEWERS) {
    metrics.rejected += 1;
    return false;
  }
  candidates.set(ownerId, {
    bytes: Math.max(0, bytes),
    eligibleAt: Date.now() + delayMs,
    release,
  });
  metrics.scheduled += 1;
  syncGauges();
  scheduleDrain();
  return true;
}

export function cancelInactiveViewerBytes(ownerId: string): boolean {
  const deleted = candidates.delete(ownerId);
  if (deleted) metrics.cancelled += 1;
  syncGauges();
  scheduleDrain();
  return deleted;
}

export function shedInactiveViewerBytes(): { viewers: number; bytes: number } {
  const now = Date.now();
  for (const candidate of candidates.values()) candidate.eligibleAt = now;
  syncGauges();
  scheduleDrain();
  return { viewers: candidates.size, bytes: metrics.pendingBytes };
}

export function viewerByteRetentionMetrics(): ViewerByteRetentionMetrics {
  syncGauges();
  return { ...metrics };
}

export function resetViewerByteRetentionForTest(): void {
  clearTimer();
  candidates.clear();
  metrics = emptyMetrics();
}

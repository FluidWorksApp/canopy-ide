import type { editor } from "monaco-editor";

const INACTIVE_DELAY_MS = 60_000;
const MAX_PENDING_MODELS = 128;
const MAX_TRACKED_OWNERS = 256;
const MAX_RETAINED_MODELS = 32;
const MAX_MODEL_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;

interface Candidate {
  key: string;
  model: editor.ITextModel;
  eligibleAt: number;
}

interface RetainedModel {
  text: string;
  bytes: number;
}

interface ModelOwner {
  key: string;
  model: editor.ITextModel;
  active: boolean;
  protected: boolean;
}

interface ModelLease {
  count: number;
  model?: editor.ITextModel;
}

export interface EditorModelRetentionMetrics {
  pendingModels: number;
  pendingHighWater: number;
  retainedModels: number;
  retainedBytes: number;
  retainedModelsHighWater: number;
  retainedBytesHighWater: number;
  scheduled: number;
  cancelled: number;
  compacted: number;
  restored: number;
  forgotten: number;
  protectedSkipped: number;
  pendingRejected: number;
  admissionRejected: number;
  failures: number;
  trackedOwners: number;
  ownerRejected: number;
  activeLeases: number;
  leaseRejected: number;
  overflowLeases: number;
  compactionDisabled: boolean;
}

const candidates = new Map<string, Candidate>();
const retained = new Map<string, RetainedModel>();
const owners = new Map<string, ModelOwner>();
const leases = new Map<string, ModelLease>();
let timer: ReturnType<typeof setTimeout> | null = null;
let retainedBytes = 0;
let metrics: EditorModelRetentionMetrics = emptyMetrics();
let compactionDisabled = false;
let overflowLeases = 0;

function emptyMetrics(): EditorModelRetentionMetrics {
  return {
    pendingModels: 0,
    pendingHighWater: 0,
    retainedModels: 0,
    retainedBytes: 0,
    retainedModelsHighWater: 0,
    retainedBytesHighWater: 0,
    scheduled: 0,
    cancelled: 0,
    compacted: 0,
    restored: 0,
    forgotten: 0,
    protectedSkipped: 0,
    pendingRejected: 0,
    admissionRejected: 0,
    failures: 0,
    trackedOwners: 0,
    ownerRejected: 0,
    activeLeases: 0,
    leaseRejected: 0,
    overflowLeases: 0,
    compactionDisabled: false,
  };
}

/** Count the larger of UTF-8 and the JS engine's two-byte code-unit storage
 * without allocating an encoded copy of the model. The retained budget is a
 * memory budget, not merely a file-size budget. */
export function retainedTextBytes(text: string): number {
  let utf8 = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) utf8 += 1;
    else if (code < 0x800) utf8 += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        utf8 += 4;
        i += 1;
      } else utf8 += 3;
    } else utf8 += 3;
  }
  return Math.max(utf8, text.length * 2);
}

function syncGauges(): void {
  metrics.pendingModels = candidates.size;
  metrics.retainedModels = retained.size;
  metrics.retainedBytes = retainedBytes;
  metrics.trackedOwners = owners.size;
  metrics.activeLeases = leases.size;
  metrics.overflowLeases = overflowLeases;
  metrics.compactionDisabled = compactionDisabled;
  metrics.pendingHighWater = Math.max(metrics.pendingHighWater, candidates.size);
  metrics.retainedModelsHighWater = Math.max(
    metrics.retainedModelsHighWater,
    retained.size,
  );
  metrics.retainedBytesHighWater = Math.max(
    metrics.retainedBytesHighWater,
    retainedBytes,
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
  const [path, candidate] = next;
  const wait = candidate.eligibleAt - Date.now();
  if (wait > 0) {
    scheduleDrain();
    return;
  }
  candidates.delete(path);
  try {
    if (candidate.model.isDisposed()) {
      syncGauges();
      scheduleDrain();
      return;
    }
    const text = candidate.model.getValue();
    const bytes = retainedTextBytes(text);
    const previous = retained.get(path);
    const nextBytes = retainedBytes - (previous?.bytes ?? 0) + bytes;
    if (
      bytes > MAX_MODEL_BYTES ||
      (!previous && retained.size >= MAX_RETAINED_MODELS) ||
      nextBytes > MAX_RETAINED_BYTES
    ) {
      metrics.admissionRejected += 1;
    } else {
      retained.set(path, { text, bytes });
      retainedBytes = nextBytes;
      try {
        candidate.model.dispose();
        metrics.compacted += 1;
      } catch (error) {
        if (previous) retained.set(path, previous);
        else retained.delete(path);
        retainedBytes = retainedBytes - bytes + (previous?.bytes ?? 0);
        metrics.failures += 1;
        console.warn("editor model compaction failed", error);
      }
    }
  } catch (error) {
    metrics.failures += 1;
    console.warn("editor model compaction failed", error);
  }
  syncGauges();
  // One model per task keeps a pressure sweep from monopolising the renderer.
  scheduleDrain();
}

export function scheduleInactiveEditorModel(
  model: editor.ITextModel,
  options: { protected: boolean; delayMs?: number },
): boolean {
  const key = model.uri.toString();
  if (compactionDisabled || overflowLeases > 0) return false;
  const current = candidates.get(key);
  if (current?.model === model && !options.protected) return true;
  cancelInactiveEditorModel(key);
  if (options.protected) {
    metrics.protectedSkipped += 1;
    return false;
  }
  if (candidates.size >= MAX_PENDING_MODELS) {
    metrics.pendingRejected += 1;
    return false;
  }
  candidates.set(key, {
    key,
    model,
    eligibleAt: Date.now() + (options.delayMs ?? INACTIVE_DELAY_MS),
  });
  metrics.scheduled += 1;
  syncGauges();
  scheduleDrain();
  return true;
}

function reconcileOwnedKey(key: string): void {
  if (compactionDisabled || overflowLeases > 0) {
    cancelInactiveEditorModel(key);
    return;
  }
  if ((leases.get(key)?.count ?? 0) > 0) {
    cancelInactiveEditorModel(key);
    return;
  }
  const keyOwners = [...owners.values()].filter((owner) => owner.key === key);
  if (keyOwners.length === 0) {
    cancelInactiveEditorModel(key);
    return;
  }
  if (keyOwners.some((owner) => owner.active || owner.protected)) {
    cancelInactiveEditorModel(key);
    return;
  }
  const model = keyOwners[0]?.model;
  if (model && !model.isDisposed()) {
    scheduleInactiveEditorModel(model, { protected: false });
  }
}

/** Refresh references after a retained model is recreated. Owners continue to
 * describe visibility while leases describe short-lived agent/LSP use. */
export function refreshEditorModelInstance(model: editor.ITextModel): void {
  const key = model.uri.toString();
  let hasOwner = false;
  for (const owner of owners.values()) {
    if (owner.key !== key) continue;
    owner.model = model;
    hasOwner = true;
  }
  const lease = leases.get(key);
  if (lease) lease.model = model;
  if (hasOwner || lease) reconcileOwnedKey(key);
}

/** Prevent pressure compaction while an agent operation needs the model and
 * its markers. The returned release is idempotent. */
export function leaseEditorModel(key: string): () => void {
  const current = leases.get(key);
  if (current) current.count += 1;
  else if (leases.size >= MAX_PENDING_MODELS) {
    metrics.leaseRejected += 1;
    overflowLeases += 1;
    for (const candidateKey of [...candidates.keys()]) {
      cancelInactiveEditorModel(candidateKey);
    }
    let overflowReleased = false;
    return () => {
      if (overflowReleased) return;
      overflowReleased = true;
      overflowLeases = Math.max(0, overflowLeases - 1);
      if (overflowLeases === 0 && !compactionDisabled) {
        for (const owner of owners.values()) reconcileOwnedKey(owner.key);
      }
    };
  } else leases.set(key, { count: 1 });
  cancelInactiveEditorModel(key);
  syncGauges();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const lease = leases.get(key);
    if (!lease) return;
    lease.count -= 1;
    if (lease.count > 0) return;
    leases.delete(key);
    const hasOwner = [...owners.values()].some((owner) => owner.key === key);
    if (hasOwner) reconcileOwnedKey(key);
    else if (lease.model && !lease.model.isDisposed()) {
      // Agent-only models have no tab/backing owner. Dispose them at the end
      // of the operation; a later request recreates them from bounded input.
      lease.model.dispose();
    }
    syncGauges();
  };
}

/** Track every React owner of a path. A duplicate tab in another project may
 * still be visible, so one inactive owner is not sufficient permission to
 * dispose the shared Monaco model. */
export function updateEditorModelOwner(
  ownerId: string,
  model: editor.ITextModel,
  state: { active: boolean; protected: boolean },
): boolean {
  const previous = owners.get(ownerId);
  if (!previous && owners.size >= MAX_TRACKED_OWNERS) {
    metrics.ownerRejected += 1;
    // The untracked owner may be active for any existing shared model. Fail
    // closed for this renderer lifetime instead of guessing which key is safe.
    compactionDisabled = true;
    for (const key of [...candidates.keys()]) cancelInactiveEditorModel(key);
    return false;
  }
  owners.set(ownerId, {
    key: model.uri.toString(),
    model,
    active: state.active,
    protected: state.protected,
  });
  const key = model.uri.toString();
  if (previous && previous.key !== key) reconcileOwnedKey(previous.key);
  reconcileOwnedKey(key);
  syncGauges();
  return true;
}

export function removeEditorModelOwner(ownerId: string): void {
  const previous = owners.get(ownerId);
  if (!previous) return;
  owners.delete(ownerId);
  reconcileOwnedKey(previous.key);
  syncGauges();
}

/** Close one tab/project owner without tearing down a Monaco model that is
 * still shared by another mounted view.  `fallbackModel` covers React cleanup
 * ordering: FileView may have removed its registry row before ProjectView's
 * unmount boundary runs. */
export function closeEditorModelOwner(
  ownerId: string,
  key: string,
  fallbackModel?: editor.ITextModel,
): void {
  const previous = owners.get(ownerId);
  const matchedPrevious = previous?.key === key ? previous : undefined;
  if (matchedPrevious) owners.delete(ownerId);

  cancelInactiveEditorModel(key);
  if ([...owners.values()].some((owner) => owner.key === key)) {
    reconcileOwnedKey(key);
    syncGauges();
    return;
  }

  const entry = retained.get(key);
  if (entry) {
    retained.delete(key);
    retainedBytes -= entry.bytes;
    metrics.forgotten += 1;
  }

  const liveModel =
    fallbackModel && !fallbackModel.isDisposed()
      ? fallbackModel
      : matchedPrevious?.model && !matchedPrevious.model.isDisposed()
        ? matchedPrevious.model
        : undefined;
  const lease = leases.get(key);
  if (lease && liveModel) lease.model = liveModel;
  else if (liveModel) {
    try {
      liveModel.dispose();
    } catch (error) {
      metrics.failures += 1;
      console.warn("editor model close failed", error);
    }
  }
  syncGauges();
}

export function cancelInactiveEditorModel(key: string): boolean {
  const deleted = candidates.delete(key);
  if (deleted) metrics.cancelled += 1;
  syncGauges();
  scheduleDrain();
  return deleted;
}

/** Make all already-inactive candidates eligible. The drain remains
 * cooperative (one model per task) so a pressure event cannot itself create a
 * long renderer stall and trigger recovery. */
export function shedInactiveEditorModels(): number {
  if (compactionDisabled || overflowLeases > 0) return 0;
  const now = Date.now();
  for (const candidate of candidates.values()) candidate.eligibleAt = now;
  scheduleDrain();
  return candidates.size;
}

export function retainedEditorModelText(key: string): string | undefined {
  return retained.get(key)?.text;
}

/** Called only after Monaco successfully recreated the model. */
export function acknowledgeEditorModelRestore(key: string): void {
  const entry = retained.get(key);
  if (!entry) return;
  retained.delete(key);
  retainedBytes -= entry.bytes;
  metrics.restored += 1;
  syncGauges();
}

/** Tab close is the ownership boundary for both a live model and its compact
 * backing. No path/content is retained after the owning tab goes away. */
export function forgetEditorModel(key: string): void {
  cancelInactiveEditorModel(key);
  for (const [ownerId, owner] of owners) {
    if (owner.key === key) owners.delete(ownerId);
  }
  const entry = retained.get(key);
  if (!entry) {
    syncGauges();
    return;
  }
  retained.delete(key);
  retainedBytes -= entry.bytes;
  metrics.forgotten += 1;
  syncGauges();
}

export function editorModelRetentionMetrics(): EditorModelRetentionMetrics {
  syncGauges();
  return { ...metrics };
}

export function resetEditorModelRetentionForTest(): void {
  clearTimer();
  candidates.clear();
  retained.clear();
  owners.clear();
  leases.clear();
  retainedBytes = 0;
  metrics = emptyMetrics();
  compactionDisabled = false;
  overflowLeases = 0;
}

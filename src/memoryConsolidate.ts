// Tidying the memory review queue.
//
// The brain proposes after every few agent turns (memoryExtract.ts), so the
// "To review" list grows faster than anyone reviews it, much of it the same
// rule noticed in three sessions. Tidying hands the whole queue to the brain
// once: proposals that say the same thing become one, and the ones that were
// only a task's next step are set aside.
//
// Nothing here approves anything. A combined entry lands back in the queue for
// a person, and quarantined if any proposal it came from was: combining must
// not launder text an agent read from outside the team. Sources are marked
// superseded by the combined entry, set-aside ones rejected with the reason,
// and both stay under All for the usual month.

import { askBrain } from "./brainCall";
import { claimLease } from "./memoryLease";
import { ledgerRoot } from "./ledger";
import {
  appendMemory,
  buildConsolidationPrompt,
  listMemories,
  memoryStatus,
  needsReview,
  reviseMemory,
  tombstoneUntil,
  validateConsolidation,
  type MemoryEntry,
} from "./memoryLedger";

/** More than this many waiting proposals and the queue is tidied, in the
 *  background, with nothing for the user to press. */
export const TIDY_ABOVE = 10;
/** How often the background check looks at each project's queue. */
export const TIDY_CHECK_MS = 10 * 60 * 1000;
/** Proposals per brain call; the rest wait for the next tidy. */
const BATCH = 60;

export interface TidyResult {
  /** Proposals combined, and the entries they became. */
  combined: number;
  into: number;
  setAside: number;
}

export interface ConsolidateDeps {
  ask: typeof askBrain;
  list: typeof listMemories;
  append: typeof appendMemory;
  revise: typeof reviseMemory;
  lease: (root: string, key: string, ttlMs: number) => Promise<boolean>;
  now: () => number;
}

const realDeps: ConsolidateDeps = {
  ask: askBrain,
  list: listMemories,
  append: appendMemory,
  revise: reviseMemory,
  lease: (root, key, ttlMs) => claimLease(root, key, ttlMs),
  now: () => Date.now(),
};
let deps = realDeps;

/** Tests only. */
export function setConsolidateDepsForTests(next: Partial<ConsolidateDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
  lastSeen.clear();
}

/** The waiting ids each project's last tidy looked at: an unchanged queue is
 *  not sent to the brain again, it already said there was nothing to do. */
const lastSeen = new Map<string, string>();

/** Tidy `root`'s review queue. Null when there was nothing to tidy, another
 *  window is already tidying, or the brain couldn't answer. */
export async function tidyMemory(root: string, cwd: string = root): Promise<TidyResult | null> {
  const all = await deps.list(root);
  // Oldest first: they have waited longest and are likeliest to be repeated.
  const pending = all.filter(needsReview).reverse().slice(0, BATCH);
  if (pending.length < 2) return null;
  if (!(await deps.lease(root, "memory-tidy", 10 * 60 * 1000))) return null;
  const offered = pending.map((e) => e.data.memoryId);
  const approved = all.filter((e) => memoryStatus(e) === "approved").map((e) => e.data.text);
  const answer = await deps.ask({
    feature: "memory",
    tier: "background",
    json: true,
    cwd,
    prompt: buildConsolidationPrompt(pending, approved),
    validate: (v) => validateConsolidation(v, offered),
  });
  if (!answer.ok || !answer.value) return null;
  // The brain took a while: a proposal someone approved or rejected in the
  // meantime is theirs now, and is left alone.
  const still = new Set((await deps.list(root)).filter(needsReview).map((e) => e.data.memoryId));
  const byId = new Map(pending.filter((e) => still.has(e.data.memoryId)).map((e) => [e.data.memoryId, e]));
  const result: TidyResult = { combined: 0, into: 0, setAside: 0 };

  for (const m of answer.value.merges) {
    const sources = m.ids.map((id) => byId.get(id)).filter((e): e is MemoryEntry => !!e);
    if (sources.length < 2) continue;
    const untrusted = [
      ...new Set(
        sources.flatMap((e) =>
          e.data.untrusted?.length ? e.data.untrusted : memoryStatus(e) === "quarantined" ? ["read content from outside the team"] : [],
        ),
      ),
    ];
    const files = [...new Set(sources.flatMap((e) => e.data.provenance?.files ?? []))].slice(0, 50);
    // What the sources would replace or disagree with in approved memory, so
    // the combined entry still warns, and approving it still retires them.
    const contradicts = [...new Set(sources.flatMap((e) => e.data.contradicts ?? []))];
    const supersedes = [...new Set(sources.flatMap((e) => e.data.supersedes ?? []))];
    const merged = await deps.append(root, {
      type: m.type,
      text: m.text,
      why: m.why,
      scope: m.scope,
      confidence: Math.max(...sources.map((e) => e.data.confidence ?? 0.5)),
      source: "brain",
      author: { kind: "brain", name: "memory" },
      provenance: { files },
      consolidatedFrom: sources.map((e) => e.data.memoryId),
      ...(contradicts.length || supersedes.length ? { verdict: { contradicts, supersedes } } : {}),
      ...(untrusted.length ? { untrusted } : {}),
    });
    for (const e of sources) {
      await deps.revise(root, e.data.memoryId, {
        status: "superseded",
        expiresAt: tombstoneUntil(deps.now()),
        data: { supersededBy: merged.data.memoryId, retiredBy: "consolidation" },
      });
    }
    result.combined += sources.length;
    result.into += 1;
  }
  for (const d of answer.value.drops) {
    if (!byId.has(d.id)) continue;
    await deps.revise(root, d.id, {
      status: "rejected",
      expiresAt: tombstoneUntil(deps.now()),
      data: { retiredBy: "consolidation", retiredReason: d.reason },
    });
    result.setAside += 1;
  }
  return result;
}

/** Tidy `root`'s queue when more than TIDY_ABOVE proposals are waiting and
 *  the queue changed since its last tidy. Called after extraction adds to it
 *  and by the background check. */
export async function maybeTidyMemory(root: string, cwd: string): Promise<void> {
  const waiting = (await deps.list(root).catch(() => [] as MemoryEntry[])).filter(needsReview);
  if (waiting.length <= TIDY_ABOVE) return;
  const key = waiting.map((e) => e.data.memoryId).sort().join(" ");
  if (lastSeen.get(root) === key) return;
  lastSeen.set(root, key);
  await tidyMemory(root, cwd).catch(() => null);
}

/** The background check: every TIDY_CHECK_MS, each open project's ledger.
 *  `paths` is read at each tick, so projects opened later are included.
 *  Returns a stop function. */
export function startMemoryTidy(paths: () => readonly string[]): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const roots = new Set(await Promise.all(paths().map((p) => ledgerRoot(p).catch(() => p))));
      for (const root of roots) await maybeTidyMemory(root, root);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 60 * 1000);
  const every = setInterval(() => void tick(), TIDY_CHECK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

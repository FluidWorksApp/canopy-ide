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

/** Above this many waiting proposals, extraction tidies on its own. */
export const AUTO_TIDY_AT = 12;
/** At most one automatic tidy per project in this window. */
const AUTO_TIDY_EVERY_MS = 60 * 60 * 1000;
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
  lastAuto.clear();
}

const lastAuto = new Map<string, number>();

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
  const byId = new Map(pending.map((e) => [e.data.memoryId, e]));
  const result: TidyResult = { combined: 0, into: 0, setAside: 0 };

  for (const m of answer.value.merges) {
    const sources = m.ids.map((id) => byId.get(id)).filter((e): e is MemoryEntry => !!e);
    const untrusted = [
      ...new Set(
        sources.flatMap((e) =>
          e.data.untrusted?.length ? e.data.untrusted : memoryStatus(e) === "quarantined" ? ["read content from outside the team"] : [],
        ),
      ),
    ];
    const files = [...new Set(sources.flatMap((e) => e.data.provenance?.files ?? []))].slice(0, 50);
    const merged = await deps.append(root, {
      type: m.type,
      text: m.text,
      why: m.why,
      scope: m.scope,
      confidence: Math.max(...sources.map((e) => e.data.confidence ?? 0.5)),
      source: "brain",
      author: { kind: "brain", name: "memory" },
      provenance: { files },
      consolidatedFrom: m.ids,
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
    await deps.revise(root, d.id, {
      status: "rejected",
      expiresAt: tombstoneUntil(deps.now()),
      data: { retiredBy: "consolidation", retiredReason: d.reason },
    });
    result.setAside += 1;
  }
  return result;
}

/** Called after extraction adds proposals: tidy once the queue is long, at
 *  most once an hour per project. */
export async function maybeTidyMemory(root: string, cwd: string): Promise<void> {
  const last = lastAuto.get(root);
  if (last != null && deps.now() - last < AUTO_TIDY_EVERY_MS) return;
  const waiting = (await deps.list(root).catch(() => [] as MemoryEntry[])).filter(needsReview).length;
  if (waiting < AUTO_TIDY_AT) return;
  lastAuto.set(root, deps.now());
  await tidyMemory(root, cwd).catch(() => null);
}

/** "Combined 8 proposals into 3, set aside 12 …" for the panel. */
export function tidySummary(r: TidyResult): string {
  const parts: string[] = [];
  if (r.into) parts.push(`combined ${r.combined} proposals into ${r.into}`);
  if (r.setAside) parts.push(`set aside ${r.setAside} that were only one task's steps or repeats`);
  if (!parts.length) return "Nothing to tidy — each proposal says something different.";
  const text = parts.join(", and ");
  return `${text[0].toUpperCase()}${text.slice(1)}. Nothing was approved; set-aside ones are under All.`;
}

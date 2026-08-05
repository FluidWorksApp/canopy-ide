// The switcher's slow intelligence: the linked CLI names work items and homes
// loose tabs, off the gesture path entirely. The switcher reads the cache
// synchronously; refreshes happen in the background, debounced against tab
// churn and floored to a minimum interval. The transport is injected at wiring
// time — it is expected to resume one dedicated CLI session per app run, which
// is what keeps the model warm (its context and the provider cache both
// survive between turns). No CLI, no runner, no hints: items mode still works,
// just unnamed.

import {
  EMPTY_HINTS,
  parseHintsReply,
  type WorkItemHints,
} from "./workItemHints";

/** One turn against the warm session: prompt in, raw reply out. */
export type BrainRun = (prompt: string) => Promise<string>;

/** Emitted when the cached hints change, so open switch state re-reads. */
export const HINTS_EVENT = "canopy:workitem-hints";

export const BRAIN_DEBOUNCE_MS = 3_000;
export const BRAIN_MIN_INTERVAL_MS = 30_000;

const BRAIN_PROMPT = `You maintain labels for "work items" in an IDE tab switcher. A work item is a
group of tabs (an agent session, its workspace, its PR, its preview, files).
Given the current grouping, reply with ONLY a JSON object, no prose:
{"labels": {"<item key>": "<2-5 word name of what that work is about>"},
 "assign": [{"tabId": "<id of a single-tab item>", "key": "<item key it belongs with>", "confidence": <0..1>}]}
Name every multi-tab item from its members' titles (a PR title beats a branch
name beats a directory). Suggest "assign" only when a lone tab clearly belongs
to an existing item; when unsure, omit it — a wrong merge is worse than none.

Current grouping:
`;

interface BrainState {
  run: BrainRun | null;
  hints: WorkItemHints;
  /** Digest the cached hints answer for; identical digests never re-ask. */
  answered: string | null;
  pending: string | null;
  lastStartedAt: number;
  inflight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const state: BrainState = {
  run: null,
  hints: EMPTY_HINTS,
  answered: null,
  pending: null,
  lastStartedAt: -Infinity,
  inflight: false,
  timer: null,
};

const announce = () => window.dispatchEvent(new CustomEvent(HINTS_EVENT));

/** Wire (or unwire) the CLI transport. Unwiring keeps the last hints — stale
 *  names beat a panel that forgets them because the CLI restarted. */
export function configureBrainRunner(run: BrainRun | null): void {
  state.run = run;
  if (run && state.pending) schedule();
}

export function brainHints(): WorkItemHints {
  return state.hints;
}

/** The current grouping changed. Cheap to call on every tab change: identical
 *  digests short-circuit, the rest debounces into one refresh. */
export function noteWorkItems(digest: string): void {
  if (digest === state.answered || digest === state.pending) return;
  state.pending = digest;
  if (state.run) schedule();
}

function schedule(): void {
  if (state.timer !== null || state.inflight) return;
  const wait = Math.max(
    BRAIN_DEBOUNCE_MS,
    state.lastStartedAt + BRAIN_MIN_INTERVAL_MS - Date.now(),
  );
  state.timer = setTimeout(() => {
    state.timer = null;
    void refresh();
  }, wait);
}

async function refresh(): Promise<void> {
  const run = state.run;
  const digest = state.pending;
  if (!run || digest === null) return;
  state.pending = null;
  state.inflight = true;
  state.lastStartedAt = Date.now();
  try {
    const reply = await run(BRAIN_PROMPT + digest);
    const hints = parseHintsReply(reply);
    state.answered = digest;
    // An unusable reply keeps the hints we had: the grouping it described is
    // answered (re-asking with the same digest would loop), the names aren't.
    if (hints) {
      state.hints = hints;
      announce();
    }
  } catch {
    // The runner failed — leave the digest unanswered so the next change (or
    // reconfigure) retries, but never reschedule from here: no retry storms.
    if (state.pending === null) state.pending = digest;
  } finally {
    state.inflight = false;
    if (state.pending !== null && state.run) schedule();
  }
}

/** Test seam: back to cold. */
export function resetBrainForTest(): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.run = null;
  state.hints = EMPTY_HINTS;
  state.answered = null;
  state.pending = null;
  state.lastStartedAt = -Infinity;
  state.inflight = false;
  state.timer = null;
}

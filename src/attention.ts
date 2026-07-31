// One place attention arrives.
//
// Canopy grew an attention mechanism per surface: a single-slot toast that the
// next caller overwrote, native banners gated on `document.hasFocus()` at eight
// call sites with hand-written titles, per-panel rail badges with their own
// notion of urgent, and project-tab counts derived separately again. Each one
// was right for the surface that invented it and wrong as a system: two things
// reporting at once destroyed the first, nothing carried which project it came
// from, and a toast that faded was gone with no way to ask what you missed.
//
// The gap that forced the issue is a *question*. Every mechanism above is an
// FYI — it announces, and if you miss it, nothing is waiting. But a background
// project can need an answer before it continues: an armed review loop hits a
// refusal, the branch-switch funnel raises its dialog inside a `ProjectView`
// that is mounted but `display: none`, and the app looks idle while that
// project is stalled. Nothing was wrong; there was simply nowhere for a project
// you are not looking at to say "I need you over here."
//
// So an item is `fyi` or `question`, and the difference is not cosmetic:
//
//   fyi       announces, fades on a timer, can be missed without cost.
//   question  outstanding until answered. Never auto-dismissed, always counted,
//             always allowed to reach the OS. Dismissing its *toast* is not
//             answering it — the toast is a view, `resolve()` is the answer.
//
// Where a question is *asked* does not change: the branch-switch dialog stays
// scoped to its repo, `AskDialog` stays where it is. What changes is that the
// question also posts here, naming its project and carrying a `DeepLink` back
// to itself — so the answer is one click away instead of behind remembering
// which tab was waiting.
//
// localStorage, same call as taskHistory.ts: history that costs nothing if it
// is lost, is about how you work rather than any one project, and must not put
// a write on the path of anything real.

import { ashGlyph, ashMayInterrupt, type AshState } from "./ash";
import type { DeepLink } from "./deepLinks";
import type { NoticeKind } from "./types";

/** Where an item came from. Not decoration: it picks the native title, and
 *  `team` is the one source whose FYIs reach the OS regardless of urgency —
 *  a person sent you something and is waiting on a reply, which a "success"
 *  tone fails to capture. */
export type AttentionSource =
  | "app"
  | "team"
  | "task"
  | "agent"
  | "project";

/** The single urgency model, replacing `NoticeKind` + `rail-badge-urgent` +
 *  per-panel counts each deciding independently.
 *
 *  high    blocks someone or something. Never fades, always counted, reaches
 *          the OS when Canopy is not focused.
 *  normal  worth interrupting for, but nothing is waiting on you.
 *  low     an FYI. Fades, never reaches the OS on its own.  */
export type Urgency = "low" | "normal" | "high";

export type AttentionKind = "fyi" | "question";

/** How a question stopped being outstanding. `answered` is the user acting on
 *  it; `withdrawn` is the asker no longer needing it (the agent moved on, the
 *  session ended) — a distinction the history is worth keeping, because
 *  "you never answered this" and "it sorted itself out" read very differently
 *  a day later. */
export type Resolution = "answered" | "withdrawn" | "dismissed";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  /** The tone the old `Notify` signature carried. Kept because that signature
   *  is threaded through nearly every component and is the migration seam —
   *  urgency is derived from it, not stored twice. */
  tone: NoticeKind;
  title: string;
  body?: string;
  source: AttentionSource;
  /** Which project this is about. Absent only for genuinely app-wide items
   *  (an update, a relay that dropped) — everything else names one, because
   *  "which project was that?" is the question the toast could never answer. */
  projectId?: string;
  /** Recorded rather than looked up, like TaskRun.projectName: the history
   *  outlives the project being closed or renamed. */
  projectName?: string;
  /** Where clicking lands the user. A hint, never a guarantee — `followLink`
   *  degrades from the exact surface to its project to the window. */
  where?: DeepLink;
  ts: number;
  /** Set when the user has opened the list since this arrived. */
  readAt?: number;
  /** Questions only. While unset the question is outstanding. */
  resolvedAt?: number;
  resolution?: Resolution;
  /** Set when the user waves the toast away. Deliberately not `resolvedAt`:
   *  swatting a toast is not answering a question, and conflating the two is
   *  how a stall becomes invisible again. */
  toastDismissedAt?: number;
  /** Identity of the *thing* asking, not of the posting. Re-posting with a
   *  key that already has an outstanding item updates it in place instead of
   *  queueing a second one — which is what lets a derived source (an agent's
   *  pending state, recomputed on every hook event) post freely. */
  dedupeKey?: string;
}

/** What a caller supplies. Everything else is the store's to decide. */
export type AttentionInput = Omit<
  AttentionItem,
  "id" | "ts" | "readAt" | "resolvedAt" | "resolution" | "toastDismissedAt"
> & { ts?: number };

const TONE_URGENCY: Record<NoticeKind, Urgency> = {
  info: "low",
  success: "low",
  warn: "normal",
  error: "high",
};

/** The one derivation. A question is high by construction — something is
 *  waiting on the user, which is the definition of the top of the scale — and
 *  no tone can talk it down. */
export function urgencyOf(item: Pick<AttentionItem, "kind" | "tone">): Urgency {
  return item.kind === "question" ? "high" : TONE_URGENCY[item.tone];
}

/** Outstanding = a question nobody has resolved. This is the count the rail
 *  badge, the project tab and the notification bell all read, so that they
 *  cannot disagree about how many things are waiting. */
export const isOutstanding = (item: AttentionItem): boolean =>
  item.kind === "question" && item.resolvedAt == null;

/** How long an item's toast stays up, or null for "until dismissed".
 *
 *  The old rule was "errors wait, everything else gets 4.5s". Questions join
 *  the waiting side: a timer that can retire something the user has to answer
 *  is the bug this whole module exists to remove. */
export function toastMs(item: AttentionItem): number | null {
  return urgencyOf(item) === "high" ? null : 4500;
}

/** The face this item wears (ash.ts). One mapping, so the notification list,
 *  the toast and the native title cannot drift into three vocabularies.
 *
 *  A warn FYI gets `needs`, following what `main` already does for
 *  `canopy_notify`'s warn level (`ashGlyph(level === "error" ? "blocked" :
 *  "needs")`). `explaining` reads better in the abstract — a warning is not
 *  waiting on anyone — but `needs` is the only one of the two that may
 *  interrupt, and a warn that stopped raising a banner would be a silent
 *  regression. Worth revisiting together; it is one line here.
 *
 *  A withdrawn question gets `sleeping` rather than `done` — "it sorted itself
 *  out" and "you dealt with it" are the distinction `resolution` exists to
 *  record, and the list already says "No longer needed" underneath. */
export function ashStateFor(item: AttentionItem): AshState {
  if (item.kind === "question")
    return item.resolvedAt == null
      ? item.tone === "error"
        ? "blocked"
        : "needs"
      : item.resolution === "withdrawn"
        ? "sleeping"
        : "done";
  switch (item.tone) {
    case "error":
      return "blocked";
    case "warn":
      return "needs";
    default:
      return "done";
  }
}

/** Whether this item should leave the app for the OS.
 *
 *  One rule in one place, replacing `if (document.hasFocus()) return;` copied
 *  into every call site that happened to want a banner. Focus is passed in
 *  rather than read here so the rule stays a pure function and the test suite
 *  can state "not focused" without a DOM.
 *
 *  The state clause is `ashMayInterrupt` — the design's "only these may pull
 *  the user out of what they are doing" rule, called rather than restated, so
 *  there is one predicate and not two that agree until someone edits one.
 *
 *  It is OR'd with a source clause rather than replacing it, because
 *  `ashMayInterrupt` reads the face and this also has to read where the item
 *  came from. `team` and `task` reach the OS at any tone: a teammate's file
 *  lands as "success" and a micro-task's whole promise is that you tabbed away,
 *  so both wear `done` — and on `main` today both raise a banner. Dropping the
 *  source clause would silently stop shipping those. */
export function shouldReachOS(item: AttentionItem, focused: boolean): boolean {
  if (focused) return false;
  if (ashMayInterrupt(ashStateFor(item))) return true;
  return item.source === "team" || item.source === "task";
}

/** The native banner's title. Was hand-written per call site — `"Canopy — Team"`,
 *  `"Canopy — Task"` — which is how they drifted. */
const SOURCE_TITLE: Record<AttentionSource, string> = {
  app: "Canopy",
  team: "Canopy — Team",
  task: "Canopy — Task",
  agent: "Canopy — Agent",
  project: "Canopy — Project",
};

/** Title and body for the OS, project named where there is one. A banner read
 *  minutes later from another Space has no context but the two strings it
 *  carries, so the project goes in rather than being left for the user to
 *  guess at.
 *
 *  The `ashGlyph` prefix was two hand-written call sites on `main`
 *  (`Canopy — Task ${ashGlyph(...)}`). Deriving it here instead means every
 *  banner wears the face, including the ones those two sites never covered —
 *  a teammate's message, a file transfer, an agent's question — rather than
 *  the glyph being something each new caller has to remember. */
export function osPayload(item: AttentionItem): { title: string; body: string } {
  const base = SOURCE_TITLE[item.source];
  const named = item.projectName ? `${base} · ${item.projectName}` : base;
  return {
    title: `${named} ${ashGlyph(ashStateFor(item))}`,
    body: item.body ? `${item.title} — ${item.body}` : item.title,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const KEY = "canopy.attention";

/** How many items to keep. Outstanding questions are exempt — see `trim`. */
const MAX_ITEMS = 300;

/** Emitted on every change, so surfaces showing a count refresh without
 *  polling. Fired inside `write` rather than by each caller, so no write can
 *  forget it. */
export const ATTENTION_EVENT = "canopy:attention";

/** Parsed-items cache keyed on the raw string, so `getSnapshot` returns a
 *  stable reference — `useSyncExternalStore` tears if it does not. */
let cache: { raw: string | null; items: AttentionItem[] } | null = null;

function read(): AttentionItem[] {
  const raw = localStorage.getItem(KEY);
  if (cache && cache.raw === raw) return cache.items;
  let items: AttentionItem[];
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    items = Array.isArray(v) ? (v as AttentionItem[]) : [];
  } catch {
    items = [];
  }
  cache = { raw, items };
  return items;
}

/** Drop the oldest past the cap — but never an outstanding question. A stall
 *  that ages out of its own queue is the failure this module was built to
 *  prevent, and the cap exists for storage, not for correctness. */
function trim(items: AttentionItem[]): AttentionItem[] {
  if (items.length <= MAX_ITEMS) return items;
  const kept = items.slice(0, MAX_ITEMS);
  const spilled = items.slice(MAX_ITEMS).filter(isOutstanding);
  return spilled.length ? [...kept, ...spilled] : kept;
}

function write(items: AttentionItem[]) {
  const next = trim(items);
  try {
    const s = JSON.stringify(next);
    localStorage.setItem(KEY, s);
    cache = { raw: s, items: next };
  } catch {
    // Storage full or unavailable. The item still reached the user through the
    // toast and the OS; losing the history entry is not worth an interruption.
    cache = null;
  }
  window.dispatchEvent(new CustomEvent(ATTENTION_EVENT));
}

/** Whether a re-post actually changed anything. `where` is the one nested
 *  field, and it is a small flat bag of scalars, so JSON is an honest compare
 *  rather than a shortcut. */
function same(a: AttentionItem, b: AttentionItem): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.tone === b.tone &&
    a.kind === b.kind &&
    a.source === b.source &&
    a.projectId === b.projectId &&
    a.projectName === b.projectName &&
    JSON.stringify(a.where ?? null) === JSON.stringify(b.where ?? null)
  );
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Put something in the channel. Returns the item's id — a question's asker
 *  keeps it so it can resolve or withdraw the question later.
 *
 *  Queues; never replaces. Two things reporting at once produce two items,
 *  which is the single most-broken property of the toast this succeeds. The
 *  one exception is `dedupeKey`, which is not replacement but identity: the
 *  same question re-posted is still one question. */
export function postAttention(input: AttentionInput): string {
  const items = read();
  const ts = input.ts ?? Date.now();
  if (input.dedupeKey) {
    const i = items.findIndex(
      (x) => x.dedupeKey === input.dedupeKey && isOutstanding(x),
    );
    if (i !== -1) {
      // Keep the original id and arrival time: the asker is holding that id,
      // and "waiting since" is the useful timestamp, not "last re-derived".
      const merged = { ...items[i], ...input, id: items[i].id, ts: items[i].ts };
      // A derived source re-posts on every event it sees — an agent's pending
      // state is recomputed from the whole hook stream on each new line. Almost
      // every one of those is identical to what is already stored, and writing
      // it back would churn localStorage and hand every subscriber a new array
      // for no change at all.
      if (same(items[i], merged)) return items[i].id;
      const next = [...items];
      next[i] = merged;
      write(next);
      return merged.id;
    }
  }
  const id = newId();
  write([{ ...input, id, ts }, ...items]);
  return id;
}

/** Answer, withdraw or dismiss a question. A no-op for an unknown id and for
 *  one already resolved — the withdraw path (an agent moving on) and the
 *  answer path race by nature, and first writer wins. */
export function resolveAttention(id: string, resolution: Resolution): void {
  const items = read();
  const i = items.findIndex((x) => x.id === id);
  if (i === -1 || items[i].resolvedAt != null) return;
  const next = [...items];
  next[i] = { ...next[i], resolvedAt: Date.now(), resolution };
  write(next);
}

/** Resolve by asker identity rather than by item id, for the callers that
 *  derive their questions and so never held one: an agent's session ends, and
 *  every question that session had outstanding is withdrawn. */
export function resolveAttentionByKey(
  dedupeKey: string,
  resolution: Resolution,
): void {
  const items = read();
  if (!items.some((x) => x.dedupeKey === dedupeKey && isOutstanding(x))) return;
  write(
    items.map((x) =>
      x.dedupeKey === dedupeKey && isOutstanding(x)
        ? { ...x, resolvedAt: Date.now(), resolution }
        : x,
    ),
  );
}

/** Wave a toast away without answering anything it asked. */
export function dismissToast(id: string): void {
  const items = read();
  const i = items.findIndex((x) => x.id === id);
  if (i === -1 || items[i].toastDismissedAt != null) return;
  const next = [...items];
  next[i] = { ...next[i], toastDismissedAt: Date.now() };
  write(next);
}

/** Mark everything currently unread as read — what opening the list does.
 *  Reading is not resolving: an outstanding question stays outstanding and
 *  stays counted after you have looked at it. */
export function markAllRead(): void {
  const items = read();
  if (!items.some((x) => x.readAt == null)) return;
  const now = Date.now();
  write(items.map((x) => (x.readAt == null ? { ...x, readAt: now } : x)));
}

/** Everything, newest first. Callers must not mutate. */
export function attentionItems(): AttentionItem[] {
  return read();
}

export function clearAttentionHistory(): void {
  // Outstanding questions survive "clear": they are not history, they are work
  // still waiting, and a list that can silently discard them is the old toast
  // with more steps.
  write(read().filter(isOutstanding));
}

export function subscribeAttention(cb: () => void): () => void {
  window.addEventListener(ATTENTION_EVENT, cb);
  return () => window.removeEventListener(ATTENTION_EVENT, cb);
}

// ---------------------------------------------------------------------------
// Selectors — every surface's count comes from here, so none can disagree
// ---------------------------------------------------------------------------

/** Toasts still on screen: not dismissed, and either high urgency (no timer)
 *  or still inside their window. `now` is passed in so the caller's tick drives
 *  the fade and the function stays pure. */
export function liveToasts(items: AttentionItem[], now: number): AttentionItem[] {
  return items.filter((x) => {
    if (x.toastDismissedAt != null) return false;
    if (isResolvedQuestion(x)) return false;
    const ms = toastMs(x);
    return ms == null || now - x.ts < ms;
  });
}

const isResolvedQuestion = (x: AttentionItem) =>
  x.kind === "question" && x.resolvedAt != null;

/** Questions still waiting on the user, oldest first — the thing that has been
 *  waiting longest is the one most worth surfacing. */
export const outstandingQuestions = (items: AttentionItem[]): AttentionItem[] =>
  items.filter(isOutstanding).sort((a, b) => a.ts - b.ts);

export const unreadCount = (items: AttentionItem[]): number =>
  items.filter((x) => x.readAt == null).length;

/** What the bell shows. Outstanding questions when there are any — a number
 *  that means "waiting on you" outranks one that means "arrived" — otherwise
 *  the unread count. Returning the urgency too lets the badge style itself
 *  from the same decision rather than making its own. */
export function badgeFor(items: AttentionItem[]): {
  count: number;
  urgency: Urgency;
} {
  const waiting = items.filter(isOutstanding).length;
  if (waiting > 0) return { count: waiting, urgency: "high" };
  const unread = items.filter((x) => x.readAt == null);
  const urgency: Urgency = unread.some((x) => urgencyOf(x) === "high")
    ? "high"
    : unread.some((x) => urgencyOf(x) === "normal")
      ? "normal"
      : "low";
  return { count: unread.length, urgency };
}

/** The same badge, for one project. What a project tab shows: its own waiting
 *  work, not the workspace's. */
export const forProject = (
  items: AttentionItem[],
  projectId: string,
): AttentionItem[] => items.filter((x) => x.projectId === projectId);

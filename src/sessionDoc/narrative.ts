// The brain's reading of a session: what happened, what was decided and why,
// what is still open. The session document's facts (turns, files, receipts)
// come from Canopy's stores; this is the part only judgment can write.
//
// One background-tier call per session *state*: the answer is cached against
// the document's `lastTurnKey`, so reopening a document costs nothing, a new
// turn makes the cached reading stale (shown, marked stale, refreshable), and
// "Refresh" is the only way to spend again on an unchanged session. The cache
// is localStorage — per machine, per person, like the session itself.

import { askBrain, type BrainAnswer } from "../brainCall";
import { transcriptTail, turnLines, type SessionDocument } from "./assemble";

export interface Decision {
  decision: string;
  why: string;
  alternativesRejected: string[];
}

export interface SessionNarrative {
  summary: string;
  decisions: Decision[];
  openQuestions: string[];
  nextSteps: string[];
  risks: string[];
}

export interface CachedNarrative {
  narrative: SessionNarrative;
  turnKey: string;
  at: number;
  /** How many turns the session had when this was written — what a live
   *  document counts against to decide whether it is time to re-ask. */
  turns?: number;
}

/** A running session's document re-reads its facts after every turn, but
 *  asks the brain for a fresh summary at most once per this many turns… */
export const LIVE_NARRATIVE_EVERY_TURNS = 3;
/** …or once a turn has ended this long after the last summary. */
export const LIVE_NARRATIVE_EVERY_MS = 10 * 60 * 1000;

/** Whether `hit` should be replaced by a fresh brain reading of `doc`. A
 *  past session's summary is due whenever a newer turn exists. A running
 *  session's moves on every turn, so it is due only every few turns or
 *  minutes; in between the cached one shows, marked as written earlier. */
export function narrativeDue(
  hit: CachedNarrative | null,
  doc: Pick<SessionDocument, "lastTurnKey" | "turns">,
  opts: { live?: boolean; now?: number } = {},
): boolean {
  if (!hit) return true;
  if (hit.turnKey === doc.lastTurnKey) return false;
  if (!opts.live) return true;
  const since = hit.turns == null ? LIVE_NARRATIVE_EVERY_TURNS : doc.turns.length - hit.turns;
  const age = (opts.now ?? Date.now()) - hit.at;
  return since >= LIVE_NARRATIVE_EVERY_TURNS || age >= LIVE_NARRATIVE_EVERY_MS;
}

// ------------------------------------------------------------ validation

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const strings = (v: unknown, max = 12, chars = 400): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  return v
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => clip(s.trim(), chars))
    .slice(0, max);
};

/** The brain's JSON as a SessionNarrative, or null. Strict about the shape
 *  that matters (a summary, decisions with a why) and lenient about the rest:
 *  a missing list is an empty one, extra fields are dropped, long text is
 *  clipped so a rambling answer cannot flood the view. */
export function validateNarrative(v: unknown): SessionNarrative | null {
  if (!isObj(v)) return null;
  const summary = typeof v.summary === "string" ? v.summary.trim() : "";
  if (!summary) return null;
  const rawDecisions = v.decisions ?? [];
  if (!Array.isArray(rawDecisions)) return null;
  const decisions: Decision[] = [];
  for (const d of rawDecisions.slice(0, 12)) {
    if (!isObj(d)) continue;
    const decision = typeof d.decision === "string" ? d.decision.trim() : "";
    const why = typeof d.why === "string" ? d.why.trim() : "";
    if (!decision || !why) continue;
    decisions.push({
      decision: clip(decision, 300),
      why: clip(why, 600),
      alternativesRejected: strings(d.alternativesRejected, 6, 300) ?? [],
    });
  }
  const openQuestions = strings(v.openQuestions);
  const nextSteps = strings(v.nextSteps);
  const risks = strings(v.risks);
  if (!openQuestions || !nextSteps || !risks) return null;
  return { summary: clip(summary, 2000), decisions, openQuestions, nextSteps, risks };
}

// ------------------------------------------------------------ prompt

/** What the brain is shown. Everything it needs is in here: brain calls have
 *  no Canopy tools, and the session it reads may be in a checkout that is
 *  gone. */
export function narrativePrompt(doc: SessionDocument): string {
  const files = doc.files
    .slice(0, 40)
    .map((f) => `- ${f.path}${f.edits ? ` (${f.edits} edit${f.edits === 1 ? "" : "s"}, ${f.present} still in the tree)` : ""}`)
    .join("\n");
  const plan = doc.goal.steps.length ? `\nPlan steps:\n${doc.goal.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "";
  const notes = doc.notes.length ? `\nNotes other tools filed about this session:\n${doc.notes.map((n) => `- (${n.kind}) ${n.text}`).join("\n")}` : "";
  return [
    "You are reading a finished or in-progress coding-agent session so that someone else can understand it without replaying it.",
    "Write for a teammate who was not there, in plain language. Only state what the material below supports; if something is unclear, put it under openQuestions rather than guessing.",
    "",
    `Goal (${doc.goal.source === "plan" ? "from the session's plan" : doc.goal.source === "first-prompt" ? "the first thing the human asked" : "unknown"}):`,
    doc.goal.text || "(none captured)",
    plan,
    "",
    "Turns (prompt — files changed — proof receipt):",
    turnLines(doc) || "(no turns recorded)",
    "",
    "Files changed:",
    files || "(none recorded)",
    notes,
    "",
    "End of the conversation transcript (oldest first, may be cut at the start):",
    transcriptTail(doc.transcript) || "(transcript not available)",
    "",
    "Reply with ONE JSON object and nothing else, of this shape:",
    '{"summary": "3-6 sentences: what the session set out to do, what it actually did, where it stands now",',
    ' "decisions": [{"decision": "what was chosen", "why": "the reason given or evident", "alternativesRejected": ["option considered and not taken"]}],',
    ' "openQuestions": ["something unresolved a successor must decide or find out"],',
    ' "nextSteps": ["the concrete next action"],',
    ' "risks": ["something that could be wrong or break"]}',
    "Use empty arrays where there is nothing to say. At most 8 items per list.",
  ].join("\n");
}

// ------------------------------------------------------------ cache

const KEY = "canopy.sessionDoc.narratives.v1";
const MAX_CACHED = 60;

function readAll(): Record<string, CachedNarrative> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return isObj(parsed) ? (parsed as Record<string, CachedNarrative>) : {};
  } catch {
    return {};
  }
}

/** The last narrative written for this session, whatever turn it was for —
 *  the caller compares `turnKey` to say whether it is current. */
export function cachedNarrative(sessionId: string): CachedNarrative | null {
  const hit = readAll()[sessionId];
  if (!hit || typeof hit.turnKey !== "string") return null;
  const narrative = validateNarrative(hit.narrative);
  return narrative
    ? {
        narrative,
        turnKey: hit.turnKey,
        at: Number(hit.at) || 0,
        ...(typeof hit.turns === "number" ? { turns: hit.turns } : {}),
      }
    : null;
}

export function storeNarrative(sessionId: string, entry: CachedNarrative): void {
  try {
    const all = readAll();
    all[sessionId] = entry;
    // Keep the newest few dozen; this is a convenience cache, not an archive.
    const keep = Object.entries(all)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_CACHED);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // Storage full or blocked: the narrative still shows, it just isn't kept.
  }
}

// ------------------------------------------------------------ the call

/** askBrain in the session's directory, falling back to no directory when
 *  that is gone (a deleted worktree, a cloud workspace's path that does not
 *  exist on this computer). Every brain prompt here carries what it needs, so
 *  the directory is a convenience, never a requirement. */
export async function askInSession<T>(
  ask: typeof askBrain,
  req: Parameters<typeof askBrain<T>>[0],
): Promise<BrainAnswer<T>> {
  const first = await ask<T>(req);
  if (!first.ok && first.reason === "failed" && req.cwd && /cwd does not exist/i.test(first.message)) {
    return ask<T>({ ...req, cwd: "" });
  }
  return first;
}

/** In-flight calls by session+turn, so two views (or a double click) share
 *  one brain call instead of paying twice. */
const inflight = new Map<string, Promise<BrainAnswer<SessionNarrative>>>();

/** Ask the brain for the session's narrative (background tier — the person
 *  opened a document, they did not ask a question) and cache a good answer. */
export function writeNarrative(
  doc: SessionDocument,
  opts: { cwd: string; signal?: AbortSignal; ask?: typeof askBrain } = { cwd: "" },
): Promise<BrainAnswer<SessionNarrative>> {
  const key = `${doc.sessionId}@${doc.lastTurnKey}`;
  const running = inflight.get(key);
  if (running) return running;
  const ask = opts.ask ?? askBrain;
  const call = askInSession<SessionNarrative>(ask, {
    feature: "handoff",
    tier: "background",
    json: true,
    cwd: opts.cwd,
    prompt: narrativePrompt(doc),
    validate: validateNarrative,
    signal: opts.signal,
    timeoutMs: 180_000,
  })
    .then((answer) => {
      if (answer.ok && answer.value) {
        storeNarrative(doc.sessionId, {
          narrative: answer.value,
          turnKey: doc.lastTurnKey,
          at: Date.now(),
          turns: doc.turns.length,
        });
      }
      return answer;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, call);
  return call;
}

/** One line for why there is no narrative, for each way askBrain declines. */
export function brainDeclined(reason: string, message?: string): string {
  switch (reason) {
    case "no-brain":
      return "No brain connected — connect an agent CLI in Settings to get a written summary.";
    case "signed-out":
      return "The brain CLI is signed out — sign in to get a written summary.";
    case "over-budget":
      return "Today's brain budget is used up — the summary will be written when it resets.";
    case "rate-limited":
      return "The brain is rate-limited right now — try Refresh in a little while.";
    case "timeout":
      return "The brain took too long to answer — try Refresh.";
    case "invalid-output":
      return "The brain's answer couldn't be read — try Refresh.";
    default:
      return `The brain couldn't write a summary${message ? `: ${message.slice(0, 160)}` : "."}`;
  }
}

/** Tests only. */
export function resetNarrativesForTests(): void {
  inflight.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

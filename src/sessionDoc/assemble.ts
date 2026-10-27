// A session as a readable document, assembled from what Canopy already keeps.
//
// Nothing here is new evidence. Every section is a join over stores that
// existed before this file: the hook digest (first prompt, recent prompts,
// files it reported), the turn-rollback timeline (one point per turn, with the
// prompt and the times it started and ended), the agent's change journal
// (which file each edit tool touched, and whether that text is still in the
// tree), the session->PR provenance edges, the ledger entries other features
// filed against the session (plans, receipts, memories, awareness notes,
// handoffs), and the tail of the CLI's own transcript.
//
// This module is pure: `assembleSessionDoc` takes those inputs and returns the
// document, so the shape is tested from fixtures without a backend. `load.ts`
// does the fetching, and every fetch there is allowed to fail — a hookless CLI
// has no journal, a remote workspace has no turn timeline, a past session's
// checkout may be gone — so every input here is optional and every section has
// an honest empty state.
//
// Ledger entries come from sibling features that own their own `data` shapes
// (receipt, plan, memory, awareness). They are read defensively: a field that
// is missing or of the wrong type is skipped, never trusted.

import type { AgentEdit, ProvenanceEdge, SessionDigest, TurnList } from "../ipc";
import type { LedgerEntry } from "../ledger";
import { filesInWindow } from "../agentTurns";

/** One message from the CLI's transcript, as `session_transcript_tail` reads
 *  it. `message` is a store that does not say who wrote the line. */
export interface TranscriptMessage {
  role: "user" | "assistant" | "message";
  text: string;
}

export type ReceiptVerdict = "pass" | "fail" | "partial" | "unknown";

/** The proof-of-work badge a turn shows, from a sibling's `receipt` entry. */
export interface ReceiptBadge {
  id: string;
  verdict: ReceiptVerdict;
  /** One line: the receipt's own summary when it has one. */
  label: string;
  ts: number;
}

export interface DocTurn {
  n: number;
  prompt: string;
  /** ms; null when the timeline could not say (digest-only sessions). */
  startedAt: number | null;
  endedAt: number | null;
  files: string[];
  receipt?: ReceiptBadge;
}

export interface DocFile {
  path: string;
  /** Edits the agent's journal recorded for this file. */
  edits: number;
  /** Of those, how many are still in the file as the agent left them — the
   *  "lines from this session" that survive. */
  present: number;
}

export interface DocGoal {
  text: string;
  source: "plan" | "first-prompt" | "none";
  steps: string[];
}

export interface DocNote {
  id: string;
  kind: string;
  ts: number;
  text: string;
}

export interface SessionDocument {
  sessionId: string;
  agent: string;
  cwd: string;
  /** Short, recognisable label: the goal's first line. */
  title: string;
  goal: DocGoal;
  turns: DocTurn[];
  files: DocFile[];
  /** Pull requests this session raised (provenance.rs). */
  prs: { number: number; url: string }[];
  /** Hunks this session wrote that are still in the tree. */
  survivingEdits: number;
  latestReceipt?: ReceiptBadge;
  /** Memories and awareness notes other features filed about this session. */
  notes: DocNote[];
  /** Earlier handoffs of this session, newest first. */
  handoffs: LedgerEntry[];
  transcript: TranscriptMessage[];
  /** Identifies "the session as of its last turn": the brain's narrative is
   *  cached against it, so a new turn invalidates the cache and nothing else
   *  does. */
  lastTurnKey: string;
  live: boolean;
}

export interface SessionDocInputs {
  sessionId: string;
  agent: string;
  cwd: string;
  digest?: SessionDigest;
  turns?: TurnList | null;
  edits?: AgentEdit[];
  ledger?: LedgerEntry[];
  provenance?: ProvenanceEdge[];
  transcript?: TranscriptMessage[];
  live?: boolean;
}

// ------------------------------------------------------------ defensive reads

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const firstStr = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const s = str(o[k]);
    if (s) return s;
  }
  return undefined;
};

/** Text an injected payload (`<task-notification>…`) is not. */
const human = (p?: string | null) => !!p && p.trim().length > 0 && !p.trimStart().startsWith("<");

const firstLine = (text: string, max = 120) => {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A receipt's verdict, whatever its writer called the field. */
export function receiptVerdict(entry: LedgerEntry): ReceiptVerdict {
  const d = isObj(entry.data) ? entry.data : {};
  const raw = (firstStr(d, ["verdict", "outcome", "result", "status"]) ?? entry.status ?? "").toLowerCase();
  if (typeof d.passed === "boolean") return d.passed ? "pass" : "fail";
  if (/^(pass|passed|ok|done|verified|success|green|proven)$/.test(raw)) return "pass";
  if (/^(fail|failed|failure|red|broken|refuted|error)$/.test(raw)) return "fail";
  if (/^(partial|mixed|unverified|incomplete|warn|warning)$/.test(raw)) return "partial";
  return "unknown";
}

function receiptBadge(entry: LedgerEntry): ReceiptBadge {
  const d = isObj(entry.data) ? entry.data : {};
  const verdict = receiptVerdict(entry);
  const said = firstStr(d, ["summary", "headline", "why", "title"]) ?? entry.subject;
  return {
    id: entry.id,
    verdict,
    label: said ? firstLine(said, 160) : VERDICT_LABEL[verdict],
    ts: entry.ts,
  };
}

export const VERDICT_LABEL: Record<ReceiptVerdict, string> = {
  pass: "Checked: did what was asked",
  fail: "Checked: did not do what was asked",
  partial: "Checked: partly done",
  unknown: "Receipt filed",
};

/** When the turn a receipt is about started, if its writer said: a `turnId`
 *  (`<sessionId>:<startedAt>`, agentTurns.ts) in data or in `ref`. */
function receiptTurnStart(entry: LedgerEntry, sessionId: string): number | null {
  const d = isObj(entry.data) ? entry.data : {};
  const ids = [str(d.turnId), entry.ref?.kind === "turn" ? entry.ref.id : undefined];
  for (const id of ids) {
    if (!id || !id.startsWith(`${sessionId}:`)) continue;
    const at = Number(id.slice(sessionId.length + 1));
    if (Number.isFinite(at) && at > 0) return at;
  }
  return null;
}

/** Whether a ledger entry is about this session: filed against it, against
 *  one of its turns, or written by it. */
export function aboutSession(entry: LedgerEntry, sessionId: string): boolean {
  if (entry.ref?.kind === "session" && entry.ref.id === sessionId) return true;
  if (entry.ref?.kind === "turn" && entry.ref.id.startsWith(`${sessionId}:`)) return true;
  if (entry.author?.sessionId === sessionId) return true;
  const d = isObj(entry.data) ? entry.data : {};
  return d.sessionId === sessionId || (typeof d.turnId === "string" && d.turnId.startsWith(`${sessionId}:`));
}

/** The plan's goal and steps, whatever shape the plan feature settled on. */
function planGoal(entry: LedgerEntry): DocGoal | null {
  const d = isObj(entry.data) ? entry.data : {};
  const text = firstStr(d, ["goal", "title", "summary", "intent"]) ?? entry.subject;
  const rawSteps = Array.isArray(d.steps) ? d.steps : [];
  const steps = rawSteps
    .map((s) => (typeof s === "string" ? s : isObj(s) ? firstStr(s, ["title", "text", "step", "description"]) : undefined))
    .filter((s): s is string => !!s && !!s.trim())
    .slice(0, 30);
  if (!text && !steps.length) return null;
  return { text: text ?? steps[0], source: "plan", steps };
}

function noteText(entry: LedgerEntry): string | undefined {
  const d = isObj(entry.data) ? entry.data : typeof entry.data === "string" ? { text: entry.data } : {};
  return firstStr(d, ["text", "summary", "note", "fact", "body", "message"]) ?? entry.subject;
}

// ------------------------------------------------------------ assembly

export function assembleSessionDoc(input: SessionDocInputs): SessionDocument {
  const { sessionId, agent, cwd, digest } = input;
  const ledger = (input.ledger ?? []).filter((e) => aboutSession(e, sessionId));
  const edits = input.edits ?? [];

  // ---- goal: the plan if a plan was filed, else what the human first asked.
  const plan = ledger
    .filter((e) => e.kind === "plan")
    .sort((a, b) => b.ts - a.ts)
    .map(planGoal)
    .find((g): g is DocGoal => !!g);
  const timelinePrompts = (input.turns?.turns ?? []).map((t) => t.prompt).filter(human) as string[];
  const first =
    [digest?.first_prompt, ...(digest?.prompts ?? []), ...timelinePrompts].find(human) ??
    input.transcript?.find((m) => m.role === "user" && human(m.text))?.text;
  const goal: DocGoal =
    plan ?? (first ? { text: first.trim(), source: "first-prompt", steps: [] } : { text: "", source: "none", steps: [] });

  // ---- turns: the rollback timeline when there is one, else the digest's
  // prompts (no times, so no per-turn files).
  const points = input.turns?.turns ?? [];
  const turns: DocTurn[] = points.length
    ? points.map((p, i) => {
        const startedAt = p.start?.ts_ms ?? null;
        const endedAt = p.end?.ts_ms ?? points[i + 1]?.start?.ts_ms ?? null;
        const files =
          startedAt != null ? filesInWindow(edits, startedAt, endedAt ?? Date.now()) : [];
        return { n: p.n, prompt: (p.prompt ?? "").trim(), startedAt, endedAt, files };
      })
    : (digest?.prompts ?? []).filter(human).map((p, i) => ({
        n: i + 1,
        prompt: p.trim(),
        startedAt: null,
        endedAt: null,
        files: [],
      }));

  // ---- receipts onto turns: by the turn id the receipt names, else by when
  // it was filed (a receipt is written as its turn ends, so it belongs to the
  // last turn that had started by then).
  const receipts = ledger.filter((e) => e.kind === "receipt").sort((a, b) => a.ts - b.ts);
  for (const r of receipts) {
    const at = receiptTurnStart(r, sessionId) ?? r.ts;
    let target: DocTurn | undefined;
    for (const t of turns) {
      if (t.startedAt != null && t.startedAt <= at + 2000) target = t;
    }
    target ??= turns.length && turns.every((t) => t.startedAt == null) ? turns[turns.length - 1] : undefined;
    // Later receipts for the same turn replace earlier ones (a re-check).
    if (target) target.receipt = receiptBadge(r);
  }
  const latestReceipt = receipts.length ? receiptBadge(receipts[receipts.length - 1]) : undefined;

  // ---- files: the journal is authoritative (attributed even on a shared
  // checkout); the digest's own report fills in for hookless journals.
  const byPath = new Map<string, DocFile>();
  for (const e of edits) {
    if (!e.path) continue;
    const f = byPath.get(e.path) ?? { path: e.path, edits: 0, present: 0 };
    f.edits += 1;
    if (e.present) f.present += 1;
    byPath.set(e.path, f);
  }
  for (const p of digest?.files ?? []) {
    if (p && !byPath.has(p)) byPath.set(p, { path: p, edits: 0, present: 0 });
  }
  const files = [...byPath.values()].sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));

  const prs = new Map<number, string>();
  for (const e of input.provenance ?? []) if (e.session_id === sessionId) prs.set(e.pr_number, e.pr_url);

  const notes: DocNote[] = ledger
    .filter((e) => e.kind === "memory" || e.kind === "awareness")
    .flatMap((e) => {
      const text = noteText(e);
      return text ? [{ id: e.id, kind: e.kind, ts: e.ts, text: firstLine(text, 400) }] : [];
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);

  const handoffs = ledger.filter((e) => e.kind === "handoff").sort((a, b) => b.ts - a.ts);

  const lastPoint = points[points.length - 1];
  const lastTurnKey = lastPoint
    ? `t${lastPoint.n}:${lastPoint.end?.ts_ms ?? lastPoint.start?.ts_ms ?? 0}`
    : `d${digest?.updated ?? 0}:${digest?.prompts?.length ?? 0}:${input.transcript?.length ?? 0}`;

  const label = goal.text || [...(digest?.prompts ?? [])].reverse().find(human) || "Agent session";
  return {
    sessionId,
    agent,
    cwd,
    title: firstLine(label, 90),
    goal,
    turns,
    files,
    prs: [...prs].map(([number, url]) => ({ number, url })).sort((a, b) => a.number - b.number),
    survivingEdits: edits.filter((e) => e.present).length,
    latestReceipt,
    notes,
    handoffs,
    transcript: input.transcript ?? [],
    lastTurnKey,
    live: !!input.live,
  };
}

// ------------------------------------------------------------ prompt material

/** Bounded text of the transcript's end, newest kept, for a brain prompt. */
export function transcriptTail(messages: readonly TranscriptMessage[], maxChars = 24_000): string {
  const out: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const who = m.role === "user" ? "HUMAN" : m.role === "assistant" ? "AGENT" : "MESSAGE";
    const body = m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text;
    const block = `[${who}]\n${body}`;
    if (used + block.length > maxChars) break;
    out.unshift(block);
    used += block.length + 2;
  }
  return out.join("\n\n");
}

/** The turn list as plain lines, for a brain prompt. */
export function turnLines(doc: SessionDocument, maxTurns = 40): string {
  const turns = doc.turns.slice(-maxTurns);
  return turns
    .map((t) => {
      const files = t.files.length ? ` — changed ${t.files.slice(0, 8).join(", ")}${t.files.length > 8 ? ` (+${t.files.length - 8})` : ""}` : "";
      const receipt = t.receipt ? ` — receipt: ${t.receipt.verdict} (${t.receipt.label})` : "";
      return `${t.n}. ${firstLine(t.prompt || "(no prompt captured)", 300)}${files}${receipt}`;
    })
    .join("\n");
}

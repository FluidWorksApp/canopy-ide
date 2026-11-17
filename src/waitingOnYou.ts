// What an agent is waiting on the person for, as a list per agent session.
//
// In a long conversation the questions are what gets lost: the agent asks three
// things in the middle of a long reply, the person answers one and carries on,
// and the other two are never seen again. This keeps them, next to the task
// list, until each is answered, dropped by the agent, or dismissed.
//
// It runs the same two-step flow as the task list (requestTasks.ts):
//
//   a reply   -> System One: "does this reply ask the person for anything?"
//                (and, of every open question, "does this reply show it no
//                longer needs an answer?"). Only a reply it flags goes to
//                System 2, which writes the questions out, each with the kind
//                of answer it takes.
//   a prompt  -> System One asks, of every open question, "does this message
//                answer it?". Anything plausible goes to System 2 in ONE call;
//                only what it confirms is marked answered.
//
// Cost: at most one System 2 call per reply and one per prompt, and none while
// nothing is open and nothing is asked. With System One off, not installed or
// silent, nothing is written (the list simply stays empty).
//
// An answer given on the card is typed to the agent as the person would, and
// marks its questions answered here without asking any model.

import { askBrain } from "./brainCall";
import { decide, systemOneOn, ESCALATE_AT, type Answer, type Decision, type Question } from "./systemOne";
import { onAgentTurnEnd, onAgentTurnStart } from "./agentTurns";
import * as ipc from "./ipc";

/** The kind of answer a question takes. Any of them may also take words of the
 *  person's own (`freeText`): "one of these, or something else", "yes, but…". */
export type AskType = "yes_no" | "single" | "multiple" | "text";

export interface Ask {
  id: string;
  question: string;
  type: AskType;
  /** The choices, in the agent's order. "Yes" and "No" for a yes/no; empty for
   *  a question answered only in words. */
  options: string[];
  /** The answer may carry the person's own words beside any choice. Always
   *  true for `text`. */
  freeText: boolean;
  status: "open" | "answered" | "dropped";
  addedAt: number;
}

// -- limits, sized for the model's 8192-token window -------------------------------
/** The whole of what a turn end carries of a reply (its start and its end). */
const REPLY_CHARS = 10_500;
const PROMPT_CHARS = 4000;
const QUESTION_MAX = 200;
const OPTION_MAX = 80;
const MAX_OPTIONS = 8;
/** Questions taken from one reply, and kept open for one session. A reply
 *  with more than this is a questionnaire the person should read whole. */
const MAX_PER_REPLY = 8;
export const MAX_OPEN_ASKS = 12;

export interface Deps {
  decide: (state: string, questions: Record<string, Question>) => Promise<Decision>;
  askBrain: typeof askBrain;
  enabled: () => boolean;
  now: () => number;
  /** Where a job stopped, as a code: never a question's text. */
  trace: (stage: string) => void;
}

const defaults: Deps = {
  decide: (state, questions) => decide(state, questions),
  askBrain,
  enabled: systemOneOn,
  now: Date.now,
  trace: (stage) => void ipc.jsLog("boot", `asks-stage:${stage}`),
};
let deps: Deps = defaults;
export const setWaitingDepsForTests = (next: Partial<Deps> | null) => {
  deps = next ? { ...defaults, ...next } : defaults;
};

// -- store -------------------------------------------------------------------------

const asks = new Map<string, Ask[]>();
const queues = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let seq = 0;

const NONE: readonly Ask[] = [];
/** Every question recorded for a session, oldest first. */
export const asksFor = (sessionId: string): readonly Ask[] => asks.get(sessionId) ?? NONE;
export const subscribeAsks = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const emit = () => listeners.forEach((l) => l());
export const clearAsks = () => {
  asks.clear();
  queues.clear();
  seq = 0;
  emit();
};

/** The questions still waiting, oldest first. Stable while nothing changes,
 *  so it can back a `useSyncExternalStore`. */
const openCache = new WeakMap<readonly Ask[], readonly Ask[]>();
export function openAsksFor(sessionId: string): readonly Ask[] {
  const all = asksFor(sessionId);
  if (all === NONE) return NONE;
  let open = openCache.get(all);
  if (!open) {
    open = all.filter((a) => a.status === "open");
    if (!open.length) open = NONE;
    openCache.set(all, open);
  }
  return open;
}

const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function add(sessionId: string, found: NewAsk[]) {
  const list = [...asksFor(sessionId)];
  const have = new Set(list.filter((a) => a.status === "open").map((a) => fold(a.question)));
  let open = have.size;
  for (const ask of found) {
    const key = fold(ask.question);
    if (!key || have.has(key) || open >= MAX_OPEN_ASKS) continue;
    have.add(key);
    open++;
    list.push({ ...ask, id: `${sessionId}:ask:${++seq}`, status: "open", addedAt: deps.now() });
  }
  asks.set(sessionId, list);
  emit();
}

function settle(sessionId: string, ids: readonly string[], status: "answered" | "dropped") {
  const set = new Set(ids);
  const list = asksFor(sessionId);
  if (!list.some((a) => set.has(a.id) && a.status === "open")) return;
  asks.set(
    sessionId,
    list.map((a) => (set.has(a.id) && a.status === "open" ? { ...a, status } : a)),
  );
  emit();
}

/** The person answered these (on the card, where no model is needed to know). */
export const markAsksAnswered = (sessionId: string, ids: readonly string[]) => settle(sessionId, ids, "answered");
/** The person took this off the list without answering it. */
export const dismissAsk = (sessionId: string, id: string) => settle(sessionId, [id], "dropped");

/** Run `job` after whatever this session already has queued. */
function enqueue(sessionId: string, job: () => Promise<void>) {
  const next = (queues.get(sessionId) ?? Promise.resolve()).then(job, job).catch(() => {});
  queues.set(sessionId, next);
  return next;
}

// -- what System 2 writes ----------------------------------------------------------

type NewAsk = Pick<Ask, "question" | "type" | "options" | "freeText">;

const YES_NO = ["Yes", "No"];
const TYPES: readonly AskType[] = ["yes_no", "single", "multiple", "text"];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** One question as the brain wrote it, made safe to draw: a known type, short
 *  strings, and options that match the type (a "choice" with nothing to choose
 *  from is a question answered in words). Null when there is no question. */
export function normalizeAsk(raw: unknown): NewAsk | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const question = typeof r.question === "string" ? clip(r.question.replace(/\s+/g, " ").trim(), QUESTION_MAX) : "";
  if (!question) return null;
  const seen = new Set<string>();
  const options: string[] = [];
  for (const o of Array.isArray(r.options) ? r.options : []) {
    if (typeof o !== "string") continue;
    const text = clip(o.replace(/\s+/g, " ").trim(), OPTION_MAX);
    if (!text || seen.has(text.toLowerCase()) || options.length >= MAX_OPTIONS) continue;
    seen.add(text.toLowerCase());
    options.push(text);
  }
  let type: AskType = TYPES.includes(r.type as AskType) ? (r.type as AskType) : options.length ? "single" : "text";
  let freeText = r.free_text === true || r.freeText === true;
  if (type === "yes_no") return { question, type, options: [...YES_NO], freeText };
  // Nothing (or only one thing) to choose from: it is answered in words. The
  // lone option is kept as a suggestion the person can still pick.
  if ((type === "single" || type === "multiple") && options.length < 2) {
    freeText = true;
    type = options.length ? "single" : "text";
  }
  if (type === "text") return { question, type, options: [], freeText: true };
  return { question, type, options, freeText };
}

interface AsksAnswer {
  asks: NewAsk[];
  settled: number[];
}

const validateAsks = (v: unknown): AsksAnswer | null => {
  if (!v || typeof v !== "object") return null;
  const r = v as { asks?: unknown; settled?: unknown };
  if (!Array.isArray(r.asks)) return null;
  const settled = Array.isArray(r.settled) ? r.settled.filter((x): x is number => Number.isInteger(x)) : [];
  return { asks: r.asks.map(normalizeAsk).filter((a): a is NewAsk => !!a).slice(0, MAX_PER_REPLY), settled };
};

interface AnsweredAnswer {
  answered: number[];
}

const validateAnswered = (v: unknown): AnsweredAnswer | null => {
  if (!v || typeof v !== "object") return null;
  const a = (v as { answered?: unknown }).answered;
  return Array.isArray(a) && a.every((x) => Number.isInteger(x)) ? { answered: a as number[] } : null;
};

// -- reply -------------------------------------------------------------------------

export const ASKS = "asks";

/** Of a reply: does it ask the person for anything, and does it show any open
 *  question no longer needs them? */
export function replyAskQuestions(open: string[]): Record<string, Question> {
  const q: Record<string, Question> = {
    [ASKS]: {
      type: "noul",
      instructions:
        "Does this reply ask the person a question, offer them a choice, or need their decision, confirmation or information?",
    },
  };
  open.forEach((t, i) => {
    q[`settled_${i}`] = { type: "noul", instructions: `Does this reply show that this question no longer needs the person's answer: ${t}` };
  });
  return q;
}

/** A missed question is the failure this list exists to prevent; a false alarm
 *  costs one System 2 call that finds nothing. So anything this far above "no"
 *  is sent on (the same bar the task list uses). */
const flagged = (a: Answer | undefined) => a?.type === "noul" && a.noul >= ESCALATE_AT;

const numbered = (items: string[]) => (items.length ? items.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(none)");

export function asksPrompt(reply: string, open: string[]): string {
  return (
    "A coding agent just wrote the reply below to the person it works for. List every question in it that is waiting " +
    "on the person: a decision to make, an option to pick, a confirmation, information only they have, or an offer of " +
    'further work that needs a yes or no ("Want me to also…?").\n' +
    'Leave out rhetorical questions, questions the agent answers itself, and closing pleasantries ("let me know if you have questions").\n\n' +
    "For each question give:\n" +
    '- "question": the question in one short sentence that stands on its own (name the thing it is about)\n' +
    '- "type": "yes_no" (answered yes or no), "single" (pick exactly one of the options), "multiple" (pick any number of the options) ' +
    'or "text" (answered in the person\'s own words: a name, a value, an explanation)\n' +
    '- "options": the choices the agent offered, each a few words, in the agent\'s order; [] for yes_no and text\n' +
    '- "free_text": true when the answer may also need the person\'s own words beside the choice (an "other" option, ' +
    "a detail to add, a reason); otherwise false\n\n" +
    `Already listed (do not repeat these):\n${numbered(open)}\n\n` +
    'Also give, in "settled", the numbers of the already-listed questions this reply shows no longer need the person\'s ' +
    "answer (the agent got the answer, decided itself, or dropped the matter).\n\n" +
    `Reply:\n${reply}\n\n` +
    'Reply as JSON: {"asks": [{"question": "...", "type": "yes_no", "options": [], "free_text": false}], "settled": []} ' +
    "with empty lists when nothing is asked and nothing is settled."
  );
}

export async function handleReply(sessionId: string, reply: string): Promise<void> {
  if (!deps.enabled() || !reply.trim()) return;
  const open = openAsksFor(sessionId);
  const titles = open.map((a) => a.question);
  const state = reply.length > REPLY_CHARS ? `...${reply.slice(-REPLY_CHARS)}` : reply;
  const d = await deps.decide(state, replyAskQuestions(titles));
  if (!d.ok) return deps.trace(`reply-s1-${d.reason}`);
  const asking = flagged(d.answers[ASKS]);
  const settling = open.some((_, i) => flagged(d.answers[`settled_${i}`]));
  if (!asking && !settling) return deps.trace("reply-s1-none");
  const ask = await deps.askBrain<AsksAnswer>({
    feature: "asks",
    tier: "background",
    cwd: "",
    prompt: asksPrompt(state, titles),
    json: true,
    validate: validateAsks,
    timeoutMs: 60_000,
  });
  if (!ask.ok || !ask.value) return deps.trace("reply-s2-failed"); // over budget, no brain, bad output: nothing written
  // Listed questions are numbered from 1 in the prompt.
  const settled = ask.value.settled.filter((k) => k >= 1 && k <= open.length).map((k) => open[k - 1].id);
  if (settled.length) settle(sessionId, settled, "dropped");
  if (ask.value.asks.length) add(sessionId, ask.value.asks);
  deps.trace(ask.value.asks.length ? "reply-added" : settled.length ? "reply-settled" : "reply-s2-none");
}

// -- prompt ------------------------------------------------------------------------

/** Of a message from the person: which open questions does it answer? */
export function promptAskQuestions(open: string[]): Record<string, Question> {
  const q: Record<string, Question> = {};
  open.forEach((t, i) => {
    q[`answered_${i}`] = { type: "noul", instructions: `Does the person's message answer this question: ${t}` };
  });
  return q;
}

/** Background-task reports arrive as prompts but are never the person. */
const isNotification = (prompt: string) => /^\s*<task-notification>/.test(prompt);

export async function handlePrompt(sessionId: string, prompt: string): Promise<void> {
  if (!deps.enabled() || !prompt.trim() || isNotification(prompt)) return;
  const open = openAsksFor(sessionId);
  if (!open.length) return;
  const state = `The person's message: ${prompt.slice(0, PROMPT_CHARS)}`;
  const d = await deps.decide(state, promptAskQuestions(open.map((a) => a.question)));
  if (!d.ok) return deps.trace(`prompt-s1-${d.reason}`);
  const candidates = open.map((_, i) => i).filter((i) => flagged(d.answers[`answered_${i}`]));
  if (!candidates.length) return deps.trace("prompt-s1-none");
  const ask = await deps.askBrain<AnsweredAnswer>({
    feature: "asks",
    tier: "background",
    cwd: "",
    prompt:
      "A coding agent asked the person the questions below, and the person has now sent the message that follows. " +
      "Say which questions the message answers: directly, or by telling the agent what to do instead. " +
      "A message that says nothing about a question does not answer it.\n\n" +
      `Questions:\n${numbered(candidates.map((i) => open[i].question))}\n\n${state}\n\n` +
      'Reply as JSON: {"answered": [numbers of the questions the message answers]}.',
    json: true,
    validate: validateAnswered,
    timeoutMs: 60_000,
  });
  if (!ask.ok || !ask.value) return deps.trace("prompt-s2-failed");
  const ids = ask.value.answered.filter((k) => k >= 1 && k <= candidates.length).map((k) => open[candidates[k - 1]].id);
  if (!ids.length) return deps.trace("prompt-s2-none");
  settle(sessionId, ids, "answered");
  deps.trace("prompt-marked");
}

// -- answering on the card ---------------------------------------------------------

/** What the person has filled in for one question. */
export interface Draft {
  /** The options picked: at most one unless the question takes several. */
  picked: string[];
  /** Their own words. */
  text: string;
}

export const EMPTY_DRAFT: Draft = { picked: [], text: "" };

/** Pick or unpick an option, the way the question's type allows. */
export function togglePick(ask: Ask, draft: Draft, option: string): Draft {
  const has = draft.picked.includes(option);
  if (ask.type === "multiple") {
    // Kept in the question's own order, so the answer reads as the list did.
    const next = has ? draft.picked.filter((o) => o !== option) : [...draft.picked, option];
    return { ...draft, picked: ask.options.filter((o) => next.includes(o)) };
  }
  return { ...draft, picked: has ? [] : [option] };
}

/** The answer as words, or "" while there is none to send. */
export function answerText(ask: Ask, draft: Draft | undefined): string {
  const picked = (draft?.picked ?? []).filter((o) => ask.options.includes(o));
  const text = ask.freeText || ask.type === "text" ? (draft?.text ?? "").replace(/\s+/g, " ").trim() : "";
  const choice = picked.join(", ");
  if (choice && text) return `${choice} (${text})`;
  return choice || text;
}

/** One message carrying every answer given, on one line: it is typed into the
 *  agent's terminal, where a line break would send it half written. */
export function composeAnswers(answers: Array<{ ask: Ask; draft: Draft | undefined }>): string {
  const given = answers.map(({ ask, draft }) => ({ ask, text: answerText(ask, draft) })).filter((a) => a.text);
  if (!given.length) return "";
  const strip = (q: string) => q.replace(/\s*\?+\s*$/, "");
  if (given.length === 1) return `Answering your question "${strip(given[0].ask.question)}": ${given[0].text}`;
  return `Answering your questions. ${given.map((a, i) => `(${i + 1}) ${strip(a.ask.question)}: ${a.text}`).join("; ")}`;
}

// -- wiring ------------------------------------------------------------------------

/** As much of a reply as its turn end carries. A long reply arrives as its
 *  first characters (`lastMessage`) and its last (`closing`, marked with a
 *  leading "…"); a question is as likely in the opening "before I go on" as in
 *  the closing summary, so both are read, joined where they overlap. */
export function replyOf(lastMessage: string | undefined, closing: string | undefined): string {
  if (!closing) return lastMessage ?? "";
  if (!lastMessage || !closing.startsWith("…")) return closing;
  const tail = closing.slice(1);
  const seam = lastMessage.slice(-120);
  const at = seam.length === 120 ? tail.indexOf(seam) : -1;
  return at >= 0 ? lastMessage + tail.slice(at + seam.length) : `${lastMessage}\n[…]\n${tail}`;
}

/** Follow every agent's turns. Prompts and closing messages exist only for the
 *  CLIs whose hooks carry them; a CLI that does not simply feeds nothing in. */
export function startWaitingOnYou(): () => void {
  const off1 = onAgentTurnStart((s) => {
    if (s.prompt) void enqueue(s.sessionId, () => handlePrompt(s.sessionId, s.prompt!));
  });
  const off2 = onAgentTurnEnd((e) => {
    const reply = replyOf(e.lastMessage, e.closing);
    if (reply) void enqueue(e.sessionId, () => handleReply(e.sessionId, reply));
  });
  return () => {
    off1();
    off2();
  };
}

export { enqueue as enqueueForTests };

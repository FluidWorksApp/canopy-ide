// The local "System 1" layer: a client for the `/v1/systemone` wire that TypeSafe's
// Jev defined and that many open models (Kev, decider, WaterSheep, Quyet, …)
// also serve. A System One model writes no text. It is handed some state and a
// few typed questions and answers each with a choice, a yes/no probability or a
// score, in one forward pass, so it is cheap enough to sit in front of every
// event Canopy sees (a prompt, a reply, a PR) and decide what it is.
//
// Canopy talks to the wire, not to a model, so the model behind it is a swap.
// The model is Laya, served by llama.cpp, downloaded after install and run by the
// Rust side (src-tauri/src/system_one.rs) on a private port behind a key, so the
// webview never holds the address: it asks the backend (`system_one_decide`).
// Nothing here is a setting: the layer is used when the model is installed and
// skipped when it is not (`decide` never throws, and says why it gave no
// answer), and everything stays on this machine.
//
// The agent CLI brain (brainCall.ts `askBrain`) is System 2: a feature asks System
// One first and sends only what it flags to System 2 to confirm. With no answer
// from System One (off, still downloading, unsupported) a feature does nothing;
// it does not fall back to asking the CLI about everything.

import { invoke } from "@tauri-apps/api/core";
import * as ipc from "./ipc";
import { getSettings, subscribeSettings } from "./settings";

// The first call of a session starts the model (about a second).
const DEFAULT_TIMEOUT_MS = 5000;

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number };

export interface SystemOneRequest {
  state: string;
  model: string;
  questions: Record<string, Question>;
}

export type Decision =
  | { ok: true; answers: Record<string, Answer>; latencyMs: number }
  | { ok: false; reason: "unavailable" | "timeout" | "http" | "invalid" };

export function buildRequest(state: string, questions: Record<string, Question>): SystemOneRequest {
  return { state, model: "kev-latest", questions };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The wire's answers, checked: anything that is not what was asked for is
 *  refused as a whole, so a half-read reply never drives a decision. */
export function parseAnswers(
  body: unknown,
  questions: Record<string, Question>,
): Record<string, Answer> | null {
  if (!isObj(body) || !isObj(body.answers)) return null;
  const out: Record<string, Answer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = (body.answers as Record<string, unknown>)[name];
    if (!isObj(a) || a.type !== q.type) return null;
    if (q.type === "noul") {
      if (!isNum(a.noul) || a.noul < 0 || a.noul > 1) return null;
      out[name] = { type: "noul", noul: a.noul };
    } else if (q.type === "choice") {
      const probs = a.probabilities;
      if (typeof a.choice !== "string" || !(a.choice in q.criteria) || !isNum(a.confidence) || !isObj(probs)) {
        return null;
      }
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(probs)) if (isNum(v)) clean[k] = v;
      out[name] = { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: clean };
    } else {
      if (!isNum(a.score) || !isNum(a.confidence)) return null;
      out[name] = { type: "score", score: a.score, confidence: a.confidence };
    }
  }
  return out;
}

/** After the server has been missing or slow, skip it for a while: with no model
 *  installed (the usual state) every prompt and reply would otherwise pay a
 *  connect attempt. */
const BACKOFF_MS = 60_000;
let downUntil = 0;
export const resetBackoff = () => {
  downUntil = 0;
};

export interface DecideOptions {
  timeoutMs?: number;
  /** Test seam. Defaults to the Rust-side proxy. */
  fetchImpl?: typeof fetch;
}

/** The backend proxy dressed as a fetch, so `decide` has one code path. */
const viaBackend = (async (_url: string, init: RequestInit) => {
  const json = await invoke("system_one_decide", { request: JSON.parse(String(init.body)) });
  return { ok: true, json: async () => json };
}) as unknown as typeof fetch;

/** `viaBackend` cannot be aborted, so the timeout races it. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
    p.then(resolve, reject);
  });
}

/** One call. Never throws: a model that is not running, is slow, or answers
 *  badly gives `{ok:false}` and the caller carries on without it. */
export async function decide(
  state: string,
  questions: Record<string, Question>,
  opts: DecideOptions = {},
): Promise<Decision> {
  if (Date.now() < downUntil) return { ok: false, reason: "unavailable" };
  const doFetch = opts.fetchImpl ?? viaBackend;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await raceAbort(doFetch("system_one", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRequest(state, questions)),
      signal: ctl.signal,
    }), ctl.signal);
    if (!res.ok) return { ok: false, reason: "http" };
    const answers = parseAnswers(await res.json(), questions);
    if (!answers) return { ok: false, reason: "invalid" };
    return { ok: true, answers, latencyMs: Date.now() - started };
  } catch {
    // A slow answer (a cold start, a long input) is not a missing model: only
    // a model that is not there backs off.
    if (ctl.signal.aborted) return { ok: false, reason: "timeout" };
    downUntil = Date.now() + BACKOFF_MS;
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Sure enough to act on without the second opinion. */
export function confident(a: Answer | undefined, min = 0.6): boolean {
  if (!a) return false;
  if (a.type === "noul") return a.noul >= min || a.noul <= 1 - min;
  return a.confidence >= min;
}

/** A yes/no as a boolean, or null when the model is not sure. */
export function yes(a: Answer | undefined, min = 0.6): boolean | null {
  if (!a || a.type !== "noul") return null;
  if (a.noul >= min) return true;
  if (a.noul <= 1 - min) return false;
  return null;
}

// ---- the events Canopy classifies --------------------------------------------

export type PromptKind = "request" | "question" | "approval" | "chatter";
export const NEW_REQUEST = "new_request";

const PROMPT_KINDS: Record<PromptKind, string> = {
  request: "Asks for work to be done: a change, a fix, a feature, an investigation",
  question: "Asks something to be explained or answered, with no work requested",
  approval: "Agrees, approves, confirms or says to go on (ok, yes, do it, build it)",
  chatter: "Frustration, thanks, or remarks that ask for nothing",
};

/** What a message the person just sent is. `existing` are the open tasks, so a
 *  message that repeats or follows one is matched to it instead of becoming a
 *  second task. Ten tasks at most: the question is a pick, not a search. */
export function promptQuestions(existing: string[]): Record<string, Question> {
  const tasks: Record<string, string | null> = { [NEW_REQUEST]: "None of the listed tasks: this is a new request" };
  existing.slice(0, 10).forEach((t, i) => {
    tasks[`task_${i}`] = t;
  });
  return {
    kind: {
      type: "choice",
      instructions: "What kind of message is this?",
      criteria: { ...PROMPT_KINDS },
    },
    task: {
      type: "choice",
      instructions: "Which task is this message about?",
      criteria: tasks,
    },
    several: { type: "noul", instructions: "Does this message ask for more than one separate thing?" },
  };
}

export type PromptVerdict =
  | { is: "new-task"; several: boolean }
  | { is: "follow-up"; taskIndex: number }
  | { is: "not-a-task"; kind: PromptKind }
  | { is: "unsure" };

export function readPrompt(answers: Record<string, Answer>, existing: string[]): PromptVerdict {
  const kind = answers.kind;
  const task = answers.task;
  if (kind?.type !== "choice" || task?.type !== "choice" || !confident(kind)) return { is: "unsure" };
  if (kind.choice !== "request") return { is: "not-a-task", kind: kind.choice as PromptKind };
  if (!confident(task)) return { is: "unsure" };
  if (task.choice === NEW_REQUEST) return { is: "new-task", several: yes(answers.several) === true };
  const index = Number(task.choice.replace("task_", ""));
  return Number.isInteger(index) && index < existing.length ? { is: "follow-up", taskIndex: index } : { is: "unsure" };
}

/** Open tasks checked against one reply, each its own yes/no. A task list is
 *  short and the model is local, so every task is asked about every reply. */
export const MAX_OPEN_CHECKED = 20;

/** What a reply from the agent shows: a PR raised, a file or page made, the
 *  agent blocked, and for each open task whether this reply finishes it. */
export function replyQuestions(open: string[]): Record<string, Question> {
  const q: Record<string, Question> = {
    raised_pr: { type: "noul", instructions: "Does this reply say a pull request was raised or opened?" },
    made_asset: { type: "noul", instructions: "Does this reply say a file, page, image or server was produced?" },
    blocked: { type: "noul", instructions: "Does this reply say the agent is blocked or needs the person?" },
  };
  open.slice(0, MAX_OPEN_CHECKED).forEach((t, i) => {
    q[`done_${i}`] = { type: "noul", instructions: `Does this reply show that this task is finished: ${t}` };
  });
  return q;
}

/** A missed finished task is silently lost; a false alarm only costs one check
 *  by System 2. So anything this far above "no" goes to System 2 to confirm. */
export const ESCALATE_AT = 0.15;

export interface ReplyVerdict {
  raisedPr: boolean | null;
  madeAsset: boolean | null;
  blocked: boolean | null;
  /** indices into `open` that System 2 must confirm; never marked done on this alone */
  doneCandidates: number[];
}

export function readReply(answers: Record<string, Answer>): ReplyVerdict {
  const doneCandidates: number[] = [];
  for (let i = 0; i < MAX_OPEN_CHECKED; i++) {
    const a = answers[`done_${i}`];
    if (a?.type === "noul" && a.noul >= ESCALATE_AT) doneCandidates.push(i);
  }
  return {
    raisedPr: yes(answers.raised_pr),
    madeAsset: yes(answers.made_asset),
    blocked: yes(answers.blocked),
    doneCandidates,
  };
}

// ---- the switch ----------------------------------------------------------------

/** Keep the backend in step with the `systemOne` setting: on starts the
 *  after-install download, off stops the server and deletes the files. Called
 *  once at startup; returns the unsubscribe. */
export function startSystemOneSync(): () => void {
  let last: boolean | null = null;
  const sync = () => {
    const on = getSettings().systemOne;
    if (on === last) return;
    last = on;
    void ipc.systemOneEnable(on).catch(() => {});
  };
  sync();
  return subscribeSettings(sync);
}

/** Whether features may use System One at all. */
export const systemOneOn = () => getSettings().systemOne;

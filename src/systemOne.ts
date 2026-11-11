// The local "System 1" layer: a client for the `/v1/systemone` wire that TypeSafe's
// Jev defined and that many open models (Kev, decider, WaterSheep, Quyet, …)
// also serve. A System One model writes no text. It is handed some state and a
// few typed questions and answers each with a choice, a yes/no probability or a
// score, in one forward pass, so it is cheap enough to sit in front of every
// event Canopy sees (a prompt, a reply, a PR) and decide what it is.
//
// Canopy talks to the wire, not to a model, so the model behind it is a swap.
// Nothing here is a setting: the layer is used when a server answers on the
// local port and skipped when it does not (`decide` never throws, and says why
// it gave no answer), and everything stays on this machine.
//
// The agent CLI brain (brainCall.ts `askBrain`) stays the second opinion: a
// feature calls `decide` first and escalates only when the local answer is
// absent or not confident (`confident`). Nothing in this file calls the CLI.

export const SYSTEM_ONE_URL = "http://127.0.0.1:8009";
const DEFAULT_TIMEOUT_MS = 2500;

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

export interface DecideOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** One call. Never throws: a model that is not running, is slow, or answers
 *  badly gives `{ok:false}` and the caller carries on without it. */
export async function decide(
  state: string,
  questions: Record<string, Question>,
  opts: DecideOptions = {},
): Promise<Decision> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await doFetch(`${opts.baseUrl ?? SYSTEM_ONE_URL}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRequest(state, questions)),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, reason: "http" };
    const answers = parseAnswers(await res.json(), questions);
    if (!answers) return { ok: false, reason: "invalid" };
    return { ok: true, answers, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, reason: ctl.signal.aborted ? "timeout" : "unavailable" };
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

/** What a reply from the agent shows: a PR raised, a file or page made, a task
 *  finished. `open` are the tasks not yet done. */
export function replyQuestions(open: string[]): Record<string, Question> {
  const tasks: Record<string, string | null> = { none: "No listed task was finished in this reply" };
  open.slice(0, 10).forEach((t, i) => {
    tasks[`task_${i}`] = t;
  });
  return {
    raised_pr: { type: "noul", instructions: "Does this reply say a pull request was raised or opened?" },
    made_asset: { type: "noul", instructions: "Does this reply say a file, page, image or server was produced?" },
    finished: { type: "choice", instructions: "Which task does this reply say is now finished?", criteria: tasks },
    blocked: { type: "noul", instructions: "Does this reply say the agent is blocked or needs the person?" },
  };
}

export interface ReplyVerdict {
  raisedPr: boolean | null;
  madeAsset: boolean | null;
  blocked: boolean | null;
  /** index into `open`, or null when none / not sure */
  finished: number | null;
}

export function readReply(answers: Record<string, Answer>): ReplyVerdict {
  const f = answers.finished;
  let finished: number | null = null;
  if (f?.type === "choice" && confident(f) && f.choice !== "none") {
    const i = Number(f.choice.replace("task_", ""));
    finished = Number.isInteger(i) ? i : null;
  }
  return {
    raisedPr: yes(answers.raised_pr),
    madeAsset: yes(answers.made_asset),
    blocked: yes(answers.blocked),
    finished,
  };
}

// The person's requests as a task list per agent session, kept up by System One
// (fast, local) with System 2 (the CLI brain) confirming before anything changes.
//
//   a prompt  -> System One: a question or chatter stops here; a repeat or
//                follow-up of an open task stops here; anything that might be a
//                new request (including a bare "wire it") goes to System 2, which
//                writes the short title(s). Raw prompt text is never a task.
//   a reply   -> System One asks, of every open task, "does this reply finish
//                it?". Anything plausible goes to System 2 in ONE call; only what
//                it confirms is marked done.
//
// Cost: at most one System 2 call per prompt and one per reply, and none at all
// when System One is off, not installed yet, or has no answer (then nothing is
// written: the layer does not turn into "ask the CLI about everything").
//
// Work for one session runs in order, so a reply is checked against the tasks
// its own prompt added. This file stores and decides; it draws nothing.

import { askBrain } from "./brainCall";
import {
  decide,
  promptQuestions,
  readPrompt,
  readReply,
  replyQuestions,
  systemOneOn,
  MAX_OPEN_CHECKED,
  type Answer,
  type Decision,
  type Question,
} from "./systemOne";
import { onAgentTurnEnd, onAgentTurnStart } from "./agentTurns";

export interface RequestTask {
  id: string;
  title: string;
  status: "open" | "done";
  addedAt: number;
}

// -- limits, sized for the model's 8192-token window -------------------------------
const PROMPT_CHARS = 4000;
const REPLY_TAIL_CHARS = 6000; // the closing summary is at the end
const PREVIOUS_REPLY_CHARS = 600;
const TITLE_MAX = 80;

export interface Deps {
  decide: (state: string, questions: Record<string, Question>) => Promise<Decision>;
  askBrain: typeof askBrain;
  enabled: () => boolean;
  now: () => number;
}

const defaults: Deps = {
  decide: (state, questions) => decide(state, questions),
  askBrain,
  enabled: systemOneOn,
  now: Date.now,
};
let deps: Deps = defaults;
export const setRequestTaskDepsForTests = (next: Partial<Deps> | null) => {
  deps = next ? { ...defaults, ...next } : defaults;
};

// -- store -------------------------------------------------------------------------

const tasks = new Map<string, RequestTask[]>();
const lastReply = new Map<string, string>();
const queues = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let seq = 0;

export const requestTasksFor = (sessionId: string): readonly RequestTask[] => tasks.get(sessionId) ?? [];
export const subscribeRequestTasks = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const emit = () => listeners.forEach((l) => l());
export const clearRequestTasks = () => {
  tasks.clear();
  lastReply.clear();
  queues.clear();
  seq = 0;
  emit();
};

const openOf = (sessionId: string) => requestTasksFor(sessionId).filter((t) => t.status === "open");

function add(sessionId: string, titles: string[]) {
  const list = [...requestTasksFor(sessionId)];
  const have = new Set(list.map((t) => t.title.toLowerCase()));
  for (const raw of titles) {
    const title = raw.trim().slice(0, TITLE_MAX);
    if (!title || have.has(title.toLowerCase())) continue;
    have.add(title.toLowerCase());
    list.push({ id: `${sessionId}:${++seq}`, title, status: "open", addedAt: deps.now() });
  }
  tasks.set(sessionId, list);
  emit();
}

function markDone(sessionId: string, ids: string[]) {
  const set = new Set(ids);
  tasks.set(
    sessionId,
    requestTasksFor(sessionId).map((t) => (set.has(t.id) ? { ...t, status: "done" as const } : t)),
  );
  emit();
}

/** Run `job` after whatever this session already has queued. */
function enqueue(sessionId: string, job: () => Promise<void>) {
  const next = (queues.get(sessionId) ?? Promise.resolve()).then(job, job).catch(() => {});
  queues.set(sessionId, next);
  return next;
}

// -- prompt ------------------------------------------------------------------------

export function promptState(prompt: string, previousReply: string | undefined): string {
  const before = previousReply ? `The assistant's last reply ended: ${previousReply.slice(-PREVIOUS_REPLY_CHARS)}\n\n` : "";
  return `${before}The person's message: ${prompt.slice(0, PROMPT_CHARS)}`;
}

interface TitlesAnswer {
  tasks: string[];
}

const validateTitles = (v: unknown): TitlesAnswer | null => {
  if (!v || typeof v !== "object") return null;
  const t = (v as { tasks?: unknown }).tasks;
  if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) return null;
  return { tasks: t as string[] };
};

function titlesPrompt(state: string, open: string[]): string {
  return (
    "A person is working with a coding agent. Decide whether their latest message asks for NEW work, " +
    "and if so write each separate piece of work as a short task title (3-8 words, imperative, no quotes).\n" +
    "Rules: a question, thanks, an approval of work already listed, or a repeat or follow-up of a listed task " +
    "adds nothing. A bare approval such as \"do it\" or \"wire it\" means the work the assistant just proposed in its last reply: title that work.\n\n" +
    `Open tasks:\n${open.length ? open.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(none)"}\n\n` +
    `${state}\n\nReply as JSON: {"tasks": ["title", ...]} with an empty list when nothing new is asked.`
  );
}

export async function handlePrompt(sessionId: string, prompt: string): Promise<void> {
  if (!deps.enabled() || !prompt.trim()) return;
  const open = openOf(sessionId);
  const state = promptState(prompt, lastReply.get(sessionId));
  const d = await deps.decide(state, promptQuestions(open.map((t) => t.title)));
  if (!d.ok) return; // no System One: write nothing
  const v = readPrompt(d.answers, open.map((t) => t.title));
  const kind = d.answers.kind;
  const approval = kind?.type === "choice" && kind.choice === "approval";
  if (v.is === "follow-up") return;
  if (v.is === "not-a-task" && !approval) return;
  const ask = await deps.askBrain<TitlesAnswer>({
    feature: "tasks",
    tier: "background",
    cwd: "",
    prompt: titlesPrompt(state, open.map((t) => t.title)),
    json: true,
    validate: validateTitles,
    timeoutMs: 60_000,
  });
  if (!ask.ok || !ask.value) return; // over budget, no brain, bad output: nothing written
  add(sessionId, ask.value.tasks);
}

// -- reply -------------------------------------------------------------------------

export function replyState(reply: string): string {
  return reply.length > REPLY_TAIL_CHARS ? `...${reply.slice(-REPLY_TAIL_CHARS)}` : reply;
}

interface DoneAnswer {
  done: number[];
}

const validateDone = (v: unknown): DoneAnswer | null => {
  if (!v || typeof v !== "object") return null;
  const d = (v as { done?: unknown }).done;
  return Array.isArray(d) && d.every((x) => Number.isInteger(x)) ? { done: d as number[] } : null;
};

export async function handleReply(sessionId: string, reply: string): Promise<void> {
  if (!deps.enabled() || !reply.trim()) return;
  lastReply.set(sessionId, reply);
  const open = openOf(sessionId).slice(0, MAX_OPEN_CHECKED);
  if (!open.length) return;
  const state = replyState(reply);
  const d = await deps.decide(state, replyQuestions(open.map((t) => t.title)));
  if (!d.ok) return;
  const candidates = readReply(d.answers as Record<string, Answer>).doneCandidates.filter((i) => i < open.length);
  if (!candidates.length) return;
  const ask = await deps.askBrain<DoneAnswer>({
    feature: "tasks",
    tier: "background",
    cwd: "",
    prompt:
      "A coding agent just wrote the reply below. For each candidate task, say whether the reply shows it is " +
      "actually finished (done and working, not merely started, planned or partly done).\n\n" +
      `Candidates:\n${candidates.map((i) => `${i}. ${open[i].title}`).join("\n")}\n\nReply:\n${state}\n\n` +
      'Reply as JSON: {"done": [numbers of the candidates that are finished]}.',
    json: true,
    validate: validateDone,
    timeoutMs: 60_000,
  });
  if (!ask.ok || !ask.value) return;
  const ids = ask.value.done.filter((i) => candidates.includes(i)).map((i) => open[i].id);
  if (ids.length) markDone(sessionId, ids);
}

// -- wiring ------------------------------------------------------------------------

/** Follow every agent's turns. Prompts and closing messages exist only for the
 *  CLIs whose hooks carry them; a CLI that does not simply feeds nothing in. */
export function startRequestTasks(): () => void {
  const off1 = onAgentTurnStart((s) => {
    if (s.prompt) void enqueue(s.sessionId, () => handlePrompt(s.sessionId, s.prompt!));
  });
  const off2 = onAgentTurnEnd((e) => {
    if (e.lastMessage) void enqueue(e.sessionId, () => handleReply(e.sessionId, e.lastMessage!));
  });
  return () => {
    off1();
    off2();
  };
}

export { enqueue as enqueueForTests };

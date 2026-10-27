// The brain names a session: a short tab title and a one-line summary, from the
// prompt that opened it.
//
// Until now an agent that never called `canopy_name_task` was named after the
// first forty-eight characters of whatever the person typed first ("ok so the
// thing i mentioned yesterday about the…"), and the Agents views summarised it
// as the latest message ("yes do it"). Both are the prompt standing in for a
// judgment. This asks the brain for the judgment once per opening prompt.
//
// Automatic, so it is careful with the person's plan: background tier, one call
// per distinct opening prompt (cached by its text, in memory and on disk, and
// deduplicated while in flight), a grace period so an agent that names itself
// costs nothing, and a setting (`brainSessionTitles`) that turns it off. With no
// brain, over budget or signed out it does nothing and the prompt's own words
// stay, exactly as before.

import { askBrain } from "./brainCall";
import { getSettings } from "./settings";
import { brainMayName, namePatch, type NamedTab, type TabNames } from "./tabName";

export interface SessionTitle {
  /** A tab-sized name for the work, 2–6 words. */
  title: string;
  /** One sentence: what the session is for. */
  summary: string;
}

export const SESSION_TITLE_MAX = 48;
export const SESSION_SUMMARY_MAX = 120;
/** Prompt characters sent. The opening of a long brief says what it is for;
 *  the rest is detail the title can't carry anyway. */
const PROMPT_BUDGET = 4_000;
/** How long an agent gets to name its own run before the brain is asked. */
export const BRAIN_NAME_GRACE_MS = 20_000;

const STORE_KEY = "canopy.brainSessionTitles";
const STORE_MAX = 400;
export const BRAIN_SESSION_TITLES_EVENT = "canopy:brain-session-titles";

/** Whitespace-flattened, so a re-sent prompt with different line endings is
 *  the same session to the cache. */
const normalise = (prompt: string) => prompt.replace(/\s+/g, " ").trim();

/** FNV-1a, hex. A cache key, not a security boundary. */
export function promptKey(prompt: string): string {
  let h = 0x811c9dc5;
  const s = normalise(prompt);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}-${s.length}`;
}

/** Whether a prompt is worth a brain call: a person's words, long enough to
 *  summarise. Hook-injected payloads (`<task-notification>…`) name nothing,
 *  and "hi" is already its own best title. */
export function worthTitling(prompt: string | undefined): prompt is string {
  if (typeof prompt !== "string") return false;
  const s = normalise(prompt);
  return s.length >= 24 && !s.startsWith("<");
}

export function buildSessionTitlePrompt(prompt: string): string {
  const body = normalise(prompt);
  const clipped = body.length > PROMPT_BUDGET ? `${body.slice(0, PROMPT_BUDGET)} […]` : body;
  return [
    "A person opened a coding-agent session in their IDE with the message below.",
    "Name the session for its tab, and summarise what it is for.",
    "",
    `- "title": 2 to 6 words, at most ${SESSION_TITLE_MAX} characters, sentence case, no quotes or trailing period. Name the work ("Fix login redirect loop"), not the person or the agent.`,
    `- "summary": one plain sentence, at most ${SESSION_SUMMARY_MAX} characters, saying what the session is trying to get done.`,
    "",
    'Reply as JSON: {"title": "...", "summary": "..."}',
    "",
    "The opening message:",
    "<<<",
    clipped,
    ">>>",
  ].join("\n");
}

/** The brain's reply as a SessionTitle, or null when it isn't a usable one. */
export function validateSessionTitle(v: unknown): SessionTitle | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const flat = (x: unknown) =>
    typeof x === "string" ? x.replace(/\s+/g, " ").trim().replace(/^["'`]|["'`]$/g, "") : "";
  const title = flat(o.title).replace(/\.$/, "");
  const summary = flat(o.summary);
  if (title.length < 2 || title.length > SESSION_TITLE_MAX + 12) return null;
  if (title.split(" ").length > 10) return null;
  if (/^(?:untitled|session|new session|coding session|n\/a)$/i.test(title)) return null;
  const clip = (s: string, max: number) =>
    s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
  return {
    title: clip(title, SESSION_TITLE_MAX),
    summary: clip(summary, SESSION_SUMMARY_MAX),
  };
}

// ------------------------------------------------------------------ cache

type Store = Record<string, SessionTitle & { at: number }>;
let memory: Store | null = null;

function load(): Store {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as unknown;
    memory = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    memory = {};
  }
  return memory;
}

function save(key: string, value: SessionTitle): void {
  const store = { ...load(), [key]: { ...value, at: Date.now() } };
  const keys = Object.keys(store);
  if (keys.length > STORE_MAX) {
    keys
      .sort((a, b) => store[a].at - store[b].at)
      .slice(0, keys.length - STORE_MAX)
      .forEach((k) => delete store[k]);
  }
  memory = store;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Quota or blocked storage: the in-memory copy still saves the calls.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BRAIN_SESSION_TITLES_EVENT));
}

/** What the brain already said about this opening prompt, if anything. Sync
 *  and free, for render paths. */
export function cachedSessionTitle(prompt: string | undefined): SessionTitle | undefined {
  if (!worthTitling(prompt)) return undefined;
  const hit = load()[promptKey(prompt)];
  return hit ? { title: hit.title, summary: hit.summary } : undefined;
}

/** Hear that a new title landed. Returns an unsubscribe. */
export function subscribeBrainSessionTitles(cb: () => void): () => void {
  window.addEventListener(BRAIN_SESSION_TITLES_EVENT, cb);
  return () => window.removeEventListener(BRAIN_SESSION_TITLES_EVENT, cb);
}

const inflight = new Map<string, Promise<SessionTitle | null>>();
/** Prompts the brain could not title this run — not retried until restart,
 *  so a reply that keeps failing validation is not paid for on every render. */
const failed = new Set<string>();

/** The brain's title for a session opened with `prompt`: cached, deduplicated,
 *  background tier. Null when off, not worth it, or the brain didn't answer. */
export function brainSessionTitle(prompt: string | undefined): Promise<SessionTitle | null> {
  if (!getSettings().brainSessionTitles || !worthTitling(prompt)) return Promise.resolve(null);
  const key = promptKey(prompt);
  const hit = cachedSessionTitle(prompt);
  if (hit) return Promise.resolve(hit);
  if (failed.has(key)) return Promise.resolve(null);
  const running = inflight.get(key);
  if (running) return running;
  const job = askBrain<SessionTitle>({
    feature: "session-title",
    tier: "background",
    // About no project: everything is in the prompt, and an empty cwd keeps
    // it working from a cloud workspace whose paths the desktop doesn't have.
    cwd: "",
    prompt: buildSessionTitlePrompt(prompt),
    json: true,
    validate: validateSessionTitle,
    timeoutMs: 60_000,
  })
    .then((answer) => {
      if (answer.ok && answer.value) {
        save(key, answer.value);
        return answer.value;
      }
      // Connection trouble may clear; a bad reply to this prompt won't.
      if (!answer.ok && answer.reason === "invalid-output") failed.add(key);
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/**
 * Title a terminal tab with the brain once its agent has had time to name the
 * work itself. `tab` reads the tab fresh (it may have closed, been renamed or
 * been named by its agent meanwhile); `apply` writes the patch.
 */
export function requestBrainTabName(opts: {
  prompt: string | undefined;
  tab: () => NamedTab | undefined;
  apply: (patch: Partial<TabNames>) => void;
  graceMs?: number;
}): void {
  const { prompt } = opts;
  if (!getSettings().brainSessionTitles || !worthTitling(prompt)) return;
  const attempt = async () => {
    const before = opts.tab();
    if (!before || !brainMayName(before)) return;
    const title = await brainSessionTitle(prompt);
    const now = opts.tab();
    if (!title || !now) return;
    const patch = namePatch(now, "brain", title.title);
    if (patch) opts.apply(patch);
  };
  // A title already known costs nothing, so it lands now; a new one waits for
  // the agent to get the first word.
  if (cachedSessionTitle(prompt)) void attempt();
  else setTimeout(() => void attempt(), opts.graceMs ?? BRAIN_NAME_GRACE_MS);
}

/** Tests only. */
export function resetBrainSessionTitlesForTests(): void {
  memory = null;
  inflight.clear();
  failed.clear();
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing to clear.
  }
}

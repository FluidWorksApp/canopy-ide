// Ask the brain a question, headlessly, and get a judgment back.
//
// brain.ts answers WHICH CLI is the brain. This answers the next question
// every intelligent feature has: "ask it this, read-only, and tell me what it
// said and what it cost". One function, so that
//
//   * every call is metered under its feature tag (brainMeter.ts) and refused
//     up front when that feature is over budget;
//   * every call runs read-only, one-shot, with no session left behind in the
//     person's resume list and no Canopy hooks firing for it (brain.rs);
//   * background features share a small concurrency cap and cannot stampede
//     the person's plan;
//   * the vendor-specific parts — argv, the cheap model alias, the wire
//     format — stay in the runner manifest (structuredRunners.ts) and the
//     protocol adapter (structuredEvents.ts), never in feature code;
//   * connection state (brainStatus.ts) learns from every outcome.
//
// Feature code calls `askBrain` and nothing below it.

import * as ipc from "./ipc";
import { chosenBrainId, installedBrain } from "./brain";
import { brainLaunchEnv } from "./profiles";
import { overBudget, recordBrainCall } from "./brainMeter";
import { noteBrainOutcome } from "./brainStatus";
import {
  AGENT_CLIS_CHANGED_EVENT,
  agentCliFor,
  CLI_INSTALLS_CHANGED_EVENT,
  checkDesktopClis,
  streamsStructured,
  structuredRunnerFor,
  type AgentCli,
} from "./projects";
import { getSettings } from "./settings";
import { StructuredRunCollector, type StructuredDialect } from "./structuredEvents";
import { noteContextWindows } from "./contextWindow";
import { BRAIN_DISALLOWED_TOOLS, brainArgs } from "./structuredRunners";

/** Which feature is asking. Open-ended (`string & {}`) so a new feature needs
 *  no edit here, but the known tags autocomplete and read the same everywhere
 *  — the meter and budgets are keyed on this string. */
export type BrainFeature =
  | "connect-probe"
  | "receipt"
  | "plan"
  | "review"
  | "awareness"
  | "handoff"
  | "lens"
  | "gates"
  | "memory"
  | "outcomes"
  | (string & {});

/** `main` — someone is waiting on the answer; the CLI's default model (or
 *  the `brainModel` setting). `background` — nobody is; the cheaper model and
 *  the shared concurrency cap. */
export type BrainTier = "main" | "background";

export interface BrainRequest<T> {
  feature: BrainFeature;
  prompt: string;
  /** Directory the CLI runs in (and may read). Empty = home, for questions
   *  that are about no project. */
  cwd: string;
  tier?: BrainTier;
  /** ask for one JSON object and parse it */
  json?: boolean;
  /** Turn the parsed JSON (or, without `json`, the reply text) into a T, or
   *  null to reject it (→ invalid-output). */
  validate?: (v: unknown) => T | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type BrainAnswer<T> =
  | {
      ok: true;
      text: string;
      value?: T;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      durationMs: number;
      model: string | null;
    }
  | {
      ok: false;
      reason:
        | "no-brain"
        | "over-budget"
        | "rate-limited"
        | "signed-out"
        | "failed"
        | "timeout"
        | "invalid-output";
      message: string;
    };

type BrainFailure = Extract<BrainAnswer<unknown>, { ok: false }>;

export const BRAIN_DEFAULT_TIMEOUT_MS = 120_000;
/** Background calls in flight at once. Two keeps a burst of turn-end features
 *  (receipt + awareness + memory) moving without turning one finished agent
 *  turn into a wall of concurrent requests against the person's plan. */
export const BRAIN_BACKGROUND_CONCURRENCY = 2;

/** What every brain call is told before the question. Read-only is enforced
 *  by the runner flags; saying it too keeps the model from planning edits it
 *  will then be refused. */
const BRAIN_BRIEF =
  "You are answering one question for Canopy, an IDE, on behalf of one of its features. " +
  "Answer directly and concisely. Do not modify files or run commands; read files in the " +
  "working directory only if the question needs them.";

const JSON_INSTRUCTION =
  "\n\nReply with exactly one JSON object and nothing else — no prose before or after it.";

// ------------------------------------------------------------ installed CLIs

const INSTALLED_TTL_MS = 5 * 60 * 1000;
let installedCache: { at: number; found: Record<string, boolean> } | null = null;
let installedOverride: ((bin: string) => boolean) | null = null;

/** Let a host that already knows what is installed (App.tsx holds the same
 *  `whichCheck` answer) skip the lookup, or let a test pin it. Null restores
 *  the built-in, cached lookup. */
export function setBrainInstalledPredicate(pred: ((bin: string) => boolean) | null): void {
  installedOverride = pred;
}

/** Forget what was detected, so the next call looks again. */
export function invalidateBrainInstalled(): void {
  installedCache = null;
}

if (typeof window !== "undefined") {
  // An install, an uninstall or an edited binary override changes the answer.
  window.addEventListener(CLI_INSTALLS_CHANGED_EVENT, invalidateBrainInstalled);
  window.addEventListener(AGENT_CLIS_CHANGED_EVENT, invalidateBrainInstalled);
}

async function installedPredicate(now: number): Promise<(bin: string) => boolean> {
  if (installedOverride) return installedOverride;
  if (!installedCache || now - installedCache.at > INSTALLED_TTL_MS) {
    // The desktop's CLIs: brain calls run on the computer showing the IDE in
    // every mode (NativeWorkspaceHost routes brain_* there), so a CLI that
    // exists only inside a cloud workspace cannot be the brain.
    const found = await checkDesktopClis();
    installedCache = { at: now, found };
  }
  const found = installedCache.found;
  return (bin) => Boolean(found[bin]);
}

// ---------------------------------------------------------------- the queue

let backgroundActive = 0;
const backgroundWaiters: Array<() => void> = [];

/** Wait for a background slot. Rejects (and leaves the queue) on abort. */
function acquireBackground(signal?: AbortSignal): Promise<void> {
  if (backgroundActive < BRAIN_BACKGROUND_CONCURRENCY) {
    backgroundActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      const at = backgroundWaiters.indexOf(grant);
      if (at >= 0) backgroundWaiters.splice(at, 1);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    backgroundWaiters.push(grant);
  });
}

function releaseBackground(): void {
  // Hand the slot straight to the next waiter rather than freeing it, so a
  // fresh caller cannot jump the queue between release and wake-up.
  const next = backgroundWaiters.shift();
  if (next) next();
  else backgroundActive = Math.max(0, backgroundActive - 1);
}

// ------------------------------------------------------------ pure helpers

const RATE_LIMITED =
  /rate[ _-]?limit|usage limit|limit reached|quota|too many requests|\b429\b|resets? at/i;
const SIGNED_OUT =
  /not logged in|please (?:run )?\/?login|\/login|log ?in again|invalid api key|invalid x-api-key|authentication[_ ]error|unauthori[sz]ed|\b401\b|oauth token (?:has )?expired|token (?:has )?expired|not authenticated/i;

/** Whether failure text means the account is throttled or signed out. Matched
 *  on wording because no CLI gives these a machine-readable code on stdout —
 *  the one exception (Claude's `rate_limit_event`) is read separately. */
export function classifyBrainFailure(text: string): "rate-limited" | "signed-out" | null {
  if (SIGNED_OUT.test(text)) return "signed-out";
  if (RATE_LIMITED.test(text)) return "rate-limited";
  return null;
}

/** The first balanced `{...}` in `text` that parses, or undefined.
 *
 *  Tolerates what models actually send back when asked for "only JSON": a
 *  ```json fence, a sentence before it, a trailing remark after it. Braces
 *  inside strings are skipped, so `{"a":"}"}` is one object, not a fragment. */
export function extractJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const source of [...fenced, text]) {
    for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
      const end = balancedEnd(source, start);
      if (end < 0) break;
      try {
        const value = JSON.parse(source.slice(start, end + 1)) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      } catch {
        // Not JSON from this brace; try the next one.
      }
    }
  }
  return undefined;
}

function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

const callId = () =>
  `brain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// ------------------------------------------------------------------ askBrain

/** Ask the brain one read-only question. Never throws: every way it can go
 *  wrong is a `reason` a feature can branch on (and most should simply skip
 *  their work quietly — an intelligence feature that nags is worse than one
 *  that is absent). */
export async function askBrain<T = unknown>(req: BrainRequest<T>): Promise<BrainAnswer<T>> {
  const started = Date.now();
  if (overBudget(req.feature, started)) {
    return { ok: false, reason: "over-budget", message: `The ${req.feature} feature has reached today's brain budget.` };
  }
  let installed = await installedPredicate(started);
  let cli = installedBrain(installed);
  if (!cli && installedCache) {
    // The chosen CLI may have been installed since the last look; check again
    // once before telling the person it is missing.
    invalidateBrainInstalled();
    installed = await installedPredicate(started);
    cli = installedBrain(installed);
  }
  const chosen = agentCliFor(chosenBrainId());
  const runner = cli ? structuredRunnerFor(cli.id) : undefined;
  if (!cli || !runner || !streamsStructured(cli.id)) {
    const answer: BrainFailure = {
      ok: false,
      reason: "no-brain",
      message: cli
        ? `${cli.name} has no verified headless runner, so it cannot answer for Canopy's features yet.`
        : chosen
          ? `${chosen.name} is your brain but isn't installed on this computer.`
          : "No agent CLI is installed to act as Canopy's brain.",
    };
    noteBrainOutcome(answer, cli ? { id: cli.id, name: cli.name } : null, { probe: isProbe(req) });
    return answer;
  }

  const settings = getSettings();
  const tier = req.tier ?? "main";
  const model = tier === "background"
    ? settings.brainBackgroundModel.trim() || runner.backgroundModel || ""
    : settings.brainModel.trim();
  const prompt = req.json ? `${req.prompt}${JSON_INSTRUCTION}` : req.prompt;
  const args = brainArgs(
    runner,
    {
      bin: cli.bin,
      policy: {
        systemPromptAppend: BRAIN_BRIEF,
        // Claude's no-edits mode; ignored by runners without permission flags,
        // whose read-only authority (an OS sandbox on Codex) does the job.
        permissionMode: "plan",
        disallowedTools: BRAIN_DISALLOWED_TOOLS,
        model,
        sessionId: "",
        cwd: req.cwd || undefined,
        authority: "read-only",
      },
    },
    prompt,
  );
  if (!args) {
    const answer: BrainFailure = {
      ok: false,
      reason: "no-brain",
      message: `${cli.name} has no verified one-shot mode, so it cannot answer for Canopy's features yet.`,
    };
    noteBrainOutcome(answer, cli, { probe: isProbe(req) });
    return answer;
  }

  if (tier === "background") {
    try {
      await acquireBackground(req.signal);
    } catch {
      return { ok: false, reason: "failed", message: "Cancelled before it started." };
    }
  }
  let answer: BrainAnswer<T>;
  let collector: StructuredRunCollector | null = null;
  let cwdMissing = false;
  try {
    const run = await runOnce(cli, runner.dialect, args, req, await brainLaunchEnv(cli.id));
    collector = run.collector;
    cwdMissing = run.end === "spawn-failed" && !!req.cwd && /cwd does not exist/i.test(run.spawnError ?? "");
    answer = interpret<T>(run, req, started);
  } finally {
    if (tier === "background") releaseBackground();
  }
  // In a cloud workspace the project path names a directory in the VM, but the
  // brain is the CLI on this computer, where that path doesn't exist. Features
  // put what the brain needs in the prompt, so ask again from home rather than
  // fail — once, and without metering a call that never started.
  if (cwdMissing) return askBrain<T>({ ...req, cwd: "" });
  const s = collector?.summary;
  noteContextWindows(s?.contextWindows);
  recordBrainCall({
    feature: req.feature,
    ts: started,
    costUsd: s?.costUsd ?? null,
    inputTokens: s?.inputTokens ?? null,
    outputTokens: s?.outputTokens ?? null,
    ok: answer.ok,
    ...(answer.ok ? {} : { reason: answer.reason }),
    ...(req.cwd ? { cwd: req.cwd } : {}),
  });
  noteBrainOutcome(answer, cli, { probe: isProbe(req) });
  return answer;
}

const isProbe = (req: BrainRequest<unknown>) => req.feature === "connect-probe";

interface RunResult {
  collector: StructuredRunCollector | null;
  stderr: string[];
  exitCode: number | null;
  /** How the run ended, from askBrain's side. */
  end: "done" | "exit" | "timeout" | "aborted" | "spawn-failed";
  spawnError?: string;
}

/** Spawn the CLI and collect until its answer (or its exit, a timeout, or an
 *  abort). Resolves on the answer line rather than on exit: a CLI that keeps
 *  winding down after answering must not hold a background slot. */
function runOnce(
  cli: AgentCli,
  dialect: StructuredDialect,
  args: string[],
  req: BrainRequest<unknown>,
  env: [string, string][],
): Promise<RunResult> {
  const id = callId();
  const collector = new StructuredRunCollector(dialect);
  const stderr: string[] = [];
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (end: RunResult["end"], exitCode: number | null = null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      // Reap whatever is left. Idempotent on the Rust side.
      if (end !== "exit" && end !== "spawn-failed") void ipc.brainKill(id).catch(() => {});
      resolve({ collector, stderr, exitCode, end, spawnError });
    };
    const onAbort = () => finish("aborted");
    if (req.signal?.aborted) {
      resolve({ collector, stderr, exitCode: null, end: "aborted" });
      return;
    }
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = req.timeoutMs ?? BRAIN_DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    ipc
      .brainCallSpawn(
        id,
        // A little past our own deadline, so Rust's ceiling is the backstop
        // for a renderer that went away, never the normal path.
        {
          command: cli.bin,
          args,
          cwd: req.cwd,
          // The active account (Settings → Accounts) when this computer has
          // it. Without it the brain ran on the CLI's default login and
          // config — a different account and model than the person's
          // sessions use.
          env,
          timeoutMs: timeoutMs + 5_000,
        },
        (out) => {
          if (out.kind === "line") {
            collector.handleLine(out.text);
            if (collector.summary.done) finish("done");
          } else if (out.kind === "stderr") {
            stderr.push(out.text);
          } else {
            finish("exit", out.code);
          }
        },
      )
      .catch((err: unknown) => finish("spawn-failed", null, String(err)));
  });
}

function interpret<T>(run: RunResult, req: BrainRequest<T>, started: number): BrainAnswer<T> {
  const s = run.collector?.summary;
  if (run.end === "spawn-failed") {
    const message = run.spawnError ?? "The brain CLI could not be started.";
    // The binary vanished since detection: look again next time.
    if (/could not find it|not found|No such file/i.test(message)) {
      invalidateBrainInstalled();
      return { ok: false, reason: "no-brain", message };
    }
    return { ok: false, reason: "failed", message };
  }
  if (run.end === "aborted") return { ok: false, reason: "failed", message: "Cancelled." };
  if (run.end === "timeout") {
    return {
      ok: false,
      reason: "timeout",
      message: `The brain did not answer within ${Math.round((req.timeoutMs ?? BRAIN_DEFAULT_TIMEOUT_MS) / 1000)}s.`,
    };
  }
  const stderrText = run.stderr.join("\n");
  if (!s || !s.done || s.isError) {
    const detail = [s?.errorMessage, s?.text, stderrText].filter(Boolean).join("\n").trim();
    if (s?.rateLimited) return { ok: false, reason: "rate-limited", message: detail || "The brain's plan is rate-limited." };
    const kind = classifyBrainFailure(detail);
    if (kind) return { ok: false, reason: kind, message: detail };
    return {
      ok: false,
      reason: "failed",
      message: detail || `The brain CLI exited (code ${run.exitCode ?? "unknown"}) without answering.`,
    };
  }
  const base = {
    ok: true as const,
    text: s.text,
    costUsd: s.costUsd,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    durationMs: s.durationMs ?? Date.now() - started,
    model: s.model,
  };
  if (!req.json) {
    if (req.validate) {
      const value = req.validate(s.text);
      if (value === null) return { ok: false, reason: "invalid-output", message: s.text };
      return { ...base, value };
    }
    return base;
  }
  const parsed = extractJsonObject(s.text);
  if (parsed === undefined) return { ok: false, reason: "invalid-output", message: s.text };
  if (!req.validate) return { ...base, value: parsed as T };
  const value = req.validate(parsed);
  if (value === null) return { ok: false, reason: "invalid-output", message: s.text };
  return { ...base, value };
}

/** Tests only: drop the queue and caches. */
export function resetBrainCallForTests(): void {
  backgroundActive = 0;
  backgroundWaiters.length = 0;
  installedCache = null;
  installedOverride = null;
}

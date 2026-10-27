// The receipt engine: after an agent turn that changed files (or on "Verify
// now"), the workspace — not the agent — gathers its own evidence and files a
// receipt.
//
//  1. What changed: the agent's edit journal, plus the git diff against the
//     turn's start snapshot (turn rollback's hidden ref) when there is one —
//     that also catches files changed through Bash — else against HEAD.
//  2. Run the project's checks with `receipt_run_check`: a separate process,
//     not the agent's terminal, CANOPY* scrubbed (src-tauri/src/receipt.rs;
//     in a Linux workspace packages/remote-host/receipt-check.mjs, in the VM).
//  3. Tamper flags for test files the turn changed; registry lookups for new
//     dependencies.
//  4. The brain judges request vs evidence (background tier, deduped by
//     content hash). It can only lower the workspace's ceiling (status.ts).
//  5. Append a `receipt` ledger entry; the store tells every surface.
//
// One job per repository at a time (two test suites in one checkout fight over
// ports and build locks), and a session's turns that end while its job waits
// fold into one.

import * as ipc from "../ipc";
import { askBrain, type BrainAnswer } from "../brainCall";
import { appendLedger, type LedgerEntry } from "../ledger";
import { onAgentTurnEnd, type AgentTurnEnd } from "../agentTurns";
import { getSettings } from "../settings";
import { isWorkspaceHost } from "../host";
import { customChecks, detectChecksAt, forgetDetection, touchesManifest } from "./detect";
import { classify, parseOutput, tail } from "./parse";
import { detectTamper, parseUnifiedDiff } from "./tamper";
import { manifestKind, newDependencies, plausibleName, registryArgv, registryStatus } from "./packages";
import { combineStatus, workspaceCeiling } from "./status";
import { brainNote, buildVerdictPrompt, validateVerdict } from "./verdict";
import { followLedger, recordFromEntry, setReceipt, setReceiptError, setVerifying } from "./store";
import type { BrainVerdict, CheckResult, CheckSpec, PackageCheck, ReceiptData, ReceiptRecord } from "./types";

export interface VerifyTarget {
  sessionId: string;
  ptyId: number | null;
  cli: string;
  cwd: string;
  /** Ledger root (canonical main checkout). */
  root: string;
  prompt?: string;
  claim?: string;
  filesTouched?: string[];
  startedAt?: number;
  endedAt?: number;
  turnId?: string;
}

export interface EngineDeps {
  run: typeof ipc.receiptRunCheck;
  readText(path: string): Promise<string>;
  turnList: typeof ipc.turnList;
  askBrain: typeof askBrain;
  append(root: string, data: ReceiptData, sessionId: string, ptyId: number | null, cli: string): Promise<LedgerEntry<ReceiptData>>;
  platform(): "windows" | "unix";
  remote(): boolean;
  now(): number;
}

const defaultDeps: EngineDeps = {
  run: (cwd, argv, opts) => ipc.receiptRunCheck(cwd, argv, opts),
  readText: (path) => ipc.fsReadText(path, 256 * 1024),
  turnList: (cwd, sessionId) => ipc.turnList(cwd, sessionId),
  askBrain,
  append: (root, data, sessionId, ptyId, cli) =>
    appendLedger<ReceiptData>(root, {
      kind: "receipt",
      author: { kind: "workspace", name: "receipts", sessionId, cli, ...(ptyId != null ? { ptyId } : {}) },
      scope: "project",
      subject: data.asked.slice(0, 200) || "Agent turn",
      ref: { kind: "session", id: sessionId },
      data,
    }),
  platform: () =>
    isWorkspaceHost() ? "unix" : typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent) ? "windows" : "unix",
  remote: () => isWorkspaceHost(),
  now: () => Date.now(),
};
let deps: EngineDeps = defaultDeps;

/** Tests only: swap the side effects. Null restores the real ones. */
export function setReceiptEngineDepsForTests(next: Partial<EngineDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const REMOTE_TIMEOUT_MS = 300 * 1000;
const MAX_FILES = 200;
const PATCH_KEEP = 256 * 1024;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const joinPath = (dir: string, rel: string) => `${norm(dir)}/${rel.replace(/^\/+/, "")}`;
const argvText = (argv: string[]) =>
  argv[0] === "/bin/sh" && argv[1] === "-c" ? argv[2] : argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

async function git(cwd: string, args: string[], opts: { head?: boolean; keepBytes?: number } = {}): Promise<string | null> {
  try {
    const r = await deps.run(cwd, ["git", ...args], { timeoutMs: 20_000, head: opts.head ?? true, keepBytes: opts.keepBytes ?? 64 * 1024 });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Repo-relative form of a journal path (absolute, or relative to the
 *  checkout). */
function relativeTo(top: string, path: string): string {
  const p = norm(path);
  const t = norm(top);
  return p.startsWith(`${t}/`) ? p.slice(t.length + 1) : p.replace(/^\.\//, "");
}

/** The turn-rollback snapshots taken when this turn started and ended:
 *  whole-tree commits (tracked and untracked), so diffing the two is exactly
 *  what the turn changed — Bash edits and new files included. */
async function turnSnapshots(t: VerifyTarget): Promise<{ start: string; end: string | null } | null> {
  if (t.startedAt == null || deps.remote()) return null;
  try {
    const list = await deps.turnList(t.cwd, t.sessionId);
    if (!list.git) return null;
    const end = t.endedAt ?? deps.now();
    // The snapshot is stamped when canopy-hook ran; the turn event is
    // observed up to a batch later. Closest start inside the turn wins.
    const hit = [...list.turns]
      .filter((p) => p.start && p.start.ts_ms >= t.startedAt! - 15_000 && p.start.ts_ms <= end + 2_000)
      .sort((a, b) => Math.abs(a.start!.ts_ms - t.startedAt!) - Math.abs(b.start!.ts_ms - t.startedAt!))[0];
    return hit?.start ? { start: hit.start.commit, end: hit.end?.commit ?? null } : null;
  } catch {
    return null;
  }
}

interface Scope {
  top: string;
  branch: string | null;
  base: string;
  /** The turn's end snapshot; null = compare with the working tree. */
  head: string | null;
  files: string[];
  untracked: Set<string>;
}

/** Which files this verification is about, and what to diff them against. */
async function scope(t: VerifyTarget, manual: boolean): Promise<Scope | null> {
  const top = (await git(t.cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return null;
  const branch = (await git(top, ["branch", "--show-current"]))?.trim() || null;
  const touched = (t.filesTouched ?? []).map((f) => relativeTo(top, f));
  const snapshot = manual ? null : await turnSnapshots(t);
  const base = snapshot?.start ?? "HEAD";
  const head = snapshot?.end ?? null;
  const untrackedOut = (await git(top, ["ls-files", "--others", "--exclude-standard"])) ?? "";
  const untracked = new Set(untrackedOut.split("\n").map((l) => l.trim()).filter(Boolean));
  let files: string[];
  if (manual) {
    // Verify now with no turn: everything uncommitted is the change.
    const dirty = (await git(top, ["diff", "--name-only", "HEAD"])) ?? "";
    files = [...dirty.split("\n"), ...untracked];
  } else if (snapshot && head) {
    const changed = (await git(top, ["diff", "--name-only", base, head])) ?? "";
    files = [...touched, ...changed.split("\n")];
  } else if (snapshot) {
    // Start snapshot against the working tree: a file still untracked shows
    // as "deleted" there (git compares tracked paths only), so untracked
    // names come from the journal, never from this list.
    const changed = (await git(top, ["diff", "--name-only", base])) ?? "";
    files = [...touched, ...changed.split("\n").filter((f) => !untracked.has(f.trim()))];
  } else {
    // Without a start snapshot, HEAD's diff also holds older uncommitted
    // work; only the journal can say what this turn did.
    files = touched;
  }
  const unique = [...new Set(files.map((f) => f.trim()).filter(Boolean))].slice(0, MAX_FILES);
  return { top, branch, base, head, files: unique, untracked };
}

async function turnPatch(s: Scope): Promise<string> {
  if (s.head)
    return s.files.length
      ? ((await git(s.top, ["diff", "--no-color", "--no-ext-diff", s.base, s.head, "--", ...s.files], { keepBytes: PATCH_KEEP })) ?? "")
      : "";
  const tracked = s.files.filter((f) => !s.untracked.has(f));
  let patch = "";
  if (tracked.length) patch = (await git(s.top, ["diff", "--no-color", "--no-ext-diff", s.base, "--", ...tracked], { keepBytes: PATCH_KEEP })) ?? "";
  // New files are invisible to `git diff`; show them as added in full.
  for (const f of s.files.filter((x) => s.untracked.has(x)).slice(0, 20)) {
    const text = await deps.readText(joinPath(s.top, f)).catch(() => null);
    if (text == null || text.includes("\0")) continue;
    const body = text.split("\n").slice(0, 400).map((l) => `+${l}`).join("\n");
    patch += `\ndiff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n${body}\n`;
  }
  return patch;
}

async function runCheck(spec: CheckSpec, dir: string): Promise<CheckResult> {
  const command = argvText(spec.argv);
  const base = { id: spec.id, label: spec.label, kind: spec.kind, command };
  try {
    const r = await deps.run(dir, spec.argv, {
      // A Linux workspace answers over HTTP that gives up at 330 s
      // (remoteExecution/client.ts); stop the check first so it reads
      // "timed out" rather than as a dropped connection.
      timeoutMs: Math.min(spec.kind === "test" ? TEST_TIMEOUT_MS : CHECK_TIMEOUT_MS, deps.remote() ? REMOTE_TIMEOUT_MS : Infinity),
      keepBytes: 64 * 1024,
    });
    const combined = [r.stdout, r.stderr].filter(Boolean).join("\n");
    const parsed = parseOutput(combined, spec.runner);
    const outcome = classify({ kind: spec.kind, exitCode: r.code, timedOut: r.timedOut, spawnError: r.spawnError, parsed, runner: spec.runner });
    return {
      ...base,
      exitCode: r.code,
      outcome,
      counts: parsed.counts,
      durationMs: r.durationMs,
      outputTail: tail(r.spawnError ? r.spawnError : combined),
      failures: parsed.failures,
      ...(outcome === "timed-out" ? { note: `Stopped after ${Math.round(r.durationMs / 1000)}s — not counted as a failure.` } : {}),
    };
  } catch (e) {
    return { ...base, exitCode: null, outcome: "not-run", counts: null, durationMs: 0, outputTail: String(e), failures: [] };
  }
}

async function packageChecks(s: Scope): Promise<PackageCheck[]> {
  const out: PackageCheck[] = [];
  for (const f of s.files.filter((x) => manifestKind(x)).slice(0, 6)) {
    const before = s.untracked.has(f) && !s.head ? null : await git(s.top, ["show", `${s.base}:${f}`], { keepBytes: 512 * 1024 });
    const after = s.head
      ? await git(s.top, ["show", `${s.head}:${f}`], { keepBytes: 512 * 1024 })
      : await deps.readText(joinPath(s.top, f)).catch(() => null);
    for (const dep of newDependencies(f, before, after).filter(plausibleName).slice(0, 12)) {
      let status: PackageCheck["status"] = "unchecked";
      try {
        const r = await deps.run(s.top, registryArgv(dep, deps.platform()), { timeoutMs: 12_000, keepBytes: 1024 });
        status = registryStatus(r.code, r.stdout);
      } catch {
        // No curl, no network: "not checked", never a guess.
      }
      out.push({ ecosystem: dep.ecosystem, name: dep.name, manifest: f, status });
    }
  }
  return out;
}

async function resolveChecks(t: VerifyTarget, s: Scope): Promise<{ dir: string; checks: CheckSpec[] }> {
  const custom = getSettings().receiptCommands[t.root] ?? getSettings().receiptCommands[s.top];
  if (custom?.length) return { dir: s.top, checks: customChecks(custom, deps.platform()) };
  if (touchesManifest(s.files)) {
    forgetDetection(s.top);
    forgetDetection(t.cwd);
  }
  const dirs = norm(t.cwd) === norm(s.top) ? [s.top] : [t.cwd, s.top];
  return detectChecksAt(dirs, deps.platform(), deps.now());
}

/** Content hash of what the brain would see, so an identical re-verify
 *  reuses the verdict instead of paying again. */
async function hashOf(text: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return `f${h}`;
  }
}
const verdictCache = new Map<string, { verdict: BrainVerdict }>();

const STABLE = (c: CheckResult) => ({ ...c, durationMs: 0 });

/** Gather evidence, judge it and file the receipt. Resolves with the stored
 *  record, or null when the turn changed nothing to verify. */
export async function verifyTurn(t: VerifyTarget, manual = false): Promise<ReceiptRecord | null> {
  const startedAt = deps.now();
  const s = await scope(t, manual);
  if (!s) {
    if (manual) setReceiptError(t.sessionId, "This folder is not a git checkout, so there is no change to verify.");
    return null;
  }
  if (!manual && !s.files.length) return null;
  setVerifying(t.sessionId, t.ptyId);
  try {
    const patch = await turnPatch(s);
    const diffs = parseUnifiedDiff(patch);
    const { dir, checks: specs } = await resolveChecks(t, s);
    const checks: CheckResult[] = [];
    for (const spec of specs) checks.push(await runCheck(spec, dir));
    const tamper = detectTamper(s.files, diffs);
    const packages = await packageChecks(s);
    const { ceiling, reasons } = workspaceCeiling(checks, packages);

    const asked = (t.prompt ?? "").trim().slice(0, 2000);
    const claim = t.claim?.trim().slice(0, 2000);
    const prompt = buildVerdictPrompt({
      asked,
      claim,
      diffSummary: patch,
      filesTouched: s.files,
      checks: checks.map(STABLE),
      tamper,
      packages,
    });
    let verdict: BrainVerdict | null = null;
    let note: string | undefined;
    let costUsd: number | null = null;
    const key = await hashOf(prompt);
    const cached = verdictCache.get(key);
    if (cached) verdict = cached.verdict;
    else {
      const answer: BrainAnswer<BrainVerdict> = await deps.askBrain<BrainVerdict>({
        feature: "receipt",
        tier: "background",
        json: true,
        // The brain runs on the computer showing the IDE; a workspace path
        // means nothing there, and the prompt already carries the evidence.
        cwd: deps.remote() ? "" : s.top,
        prompt,
        validate: validateVerdict,
        timeoutMs: 180_000,
      });
      if (answer.ok && answer.value) {
        verdict = answer.value;
        costUsd = answer.costUsd;
        verdictCache.set(key, { verdict });
        if (verdictCache.size > 200) verdictCache.delete(verdictCache.keys().next().value!);
      } else note = brainNote(answer.ok ? "invalid-output" : answer.reason);
    }
    const data: ReceiptData = {
      v: 1,
      trigger: manual ? "manual" : "turn-end",
      ...(t.turnId ? { turnId: t.turnId } : {}),
      sessionId: t.sessionId,
      ptyId: t.ptyId,
      cli: t.cli,
      cwd: t.cwd,
      branch: s.branch,
      asked,
      ...(claim ? { claim } : {}),
      filesTouched: s.files,
      base: s.base === "HEAD" ? "HEAD" : `turn start (${s.base.slice(0, 10)})`,
      checks,
      tamper,
      packages,
      verdict,
      ...(note ? { brainNote: note } : {}),
      ceiling,
      reasons,
      status: combineStatus(ceiling, verdict?.verdict ?? null, tamper),
      costUsd,
      startedAt,
      endedAt: deps.now(),
    };
    let record: ReceiptRecord;
    try {
      record = recordFromEntry(await deps.append(t.root, data, t.sessionId, t.ptyId, t.cli));
    } catch {
      // No ledger reachable: the person still sees the receipt this session.
      record = { ...data, id: `local-${startedAt}`, ts: deps.now(), root: t.root };
    }
    setReceipt(record);
    return record;
  } catch (e) {
    setReceiptError(t.sessionId, `Verification could not finish: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ------------------------------------------------------------- scheduling

interface Job {
  target: VerifyTarget;
  manual: boolean;
  started: boolean;
  done: Promise<ReceiptRecord | null>;
  resolve(r: ReceiptRecord | null): void;
}

const queues = new Map<string, Promise<unknown>>();
const pending = new Map<string, Job>();

/** Two turns of one session waiting in line become one verification of
 *  both: the later prompt, every file either touched, the earlier start. */
function fold(into: VerifyTarget, next: VerifyTarget): VerifyTarget {
  return {
    ...next,
    filesTouched: [...new Set([...(into.filesTouched ?? []), ...(next.filesTouched ?? [])])],
    startedAt: Math.min(into.startedAt ?? Infinity, next.startedAt ?? Infinity),
  };
}

export function scheduleVerify(target: VerifyTarget, manual = false): Promise<ReceiptRecord | null> {
  const waiting = pending.get(target.sessionId);
  if (waiting && !waiting.started) {
    waiting.target = fold(waiting.target, target);
    waiting.manual ||= manual;
    return waiting.done;
  }
  let resolve!: (r: ReceiptRecord | null) => void;
  const done = new Promise<ReceiptRecord | null>((r) => (resolve = r));
  const job: Job = { target, manual, started: false, done, resolve };
  pending.set(target.sessionId, job);
  const key = target.root || target.cwd;
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      job.started = true;
      if (pending.get(job.target.sessionId) === job) pending.delete(job.target.sessionId);
      const r = await verifyTurn(job.target, job.manual).catch(() => null);
      job.resolve(r);
    });
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return done;
}

/** "Verify now" / "Re-verify" from a receipt surface. */
export function verifyNow(target: VerifyTarget): Promise<ReceiptRecord | null> {
  return scheduleVerify(target, !target.filesTouched?.length);
}

/** Re-verify from an existing receipt: same session, same files. */
export function reverify(r: ReceiptRecord): Promise<ReceiptRecord | null> {
  return scheduleVerify(
    {
      sessionId: r.sessionId,
      ptyId: r.ptyId,
      cli: r.cli,
      cwd: r.cwd,
      root: r.root,
      prompt: r.asked,
      claim: r.claim,
      filesTouched: r.filesTouched,
    },
    // Re-checking against HEAD with the receipt's own file list.
    false,
  );
}

/** Type a short factual summary into the agent's terminal and submit it. */
export async function tellAgent(ptyId: number, message: string): Promise<void> {
  await ipc.ptyWrite(ptyId, message);
  await new Promise((r) => setTimeout(r, 250));
  await ipc.ptyWrite(ptyId, "\r");
}

export function onTurnEnd(turn: AgentTurnEnd): void {
  if (getSettings().receiptMode !== "auto") return;
  void scheduleVerify({
    sessionId: turn.sessionId,
    ptyId: turn.ptyId,
    cli: turn.cli,
    cwd: turn.cwd,
    root: turn.root,
    prompt: turn.prompt,
    claim: turn.lastMessage,
    filesTouched: turn.filesTouched,
    startedAt: turn.partial ? undefined : turn.startedAt,
    endedAt: turn.endedAt,
    turnId: turn.turnId,
  });
}

/** App.tsx starts this once. */
export function startReceiptEngine(): () => void {
  const offTurns = onAgentTurnEnd(onTurnEnd);
  const offLedger = followLedger();
  return () => {
    offTurns();
    offLedger();
  };
}

/** Tests only. */
export function resetReceiptEngineForTests(): void {
  queues.clear();
  pending.clear();
  verdictCache.clear();
  deps = defaultDeps;
}

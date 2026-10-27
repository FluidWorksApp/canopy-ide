// "Something's wrong" for the builder lens: diagnose first, fix only when the
// person says so, and stop after three failed fixes.
//
// Diagnosing and fixing are separate runs on purpose (Torres: "always separate
// diagnosing from fixing"). The diagnosis is an askBrain call, which is
// read-only by construction — plan mode plus a writer-tool denylist, no MCP,
// no Canopy tools — so a diagnosis cannot edit anything even if it wanted to.
// Only "Fix it" hands the diagnosis to the existing Build session, which is
// the fixing agent and already verifies and checkpoints its own work.
//
// Fix attempts are `outcome` ledger entries keyed by the symptom, so the
// three-strikes count survives a restart and is the same for every view of
// the project. After three failures the panel offers "Restart from plan"
// instead of a fourth try: rebuild from the last version that worked.
import { askBrain, type BrainAnswer } from "./brainCall";
import * as ipc from "./ipc";
import { appendLedger, queryLedger, setLedgerStatus, type LedgerEntry } from "./ledger";
import { isLensLayer, type LensLayer } from "./lensLayers";
import { getVibePreviewContext } from "./vibePreviewContext";

export type DiagnosisConfidence = "low" | "medium" | "high";

export interface Diagnosis {
  likelyCause: string;
  evidence: string[];
  suggestedFix: string;
  confidence: DiagnosisConfidence;
  layer: LensLayer;
}

export interface DiagnoseInput {
  symptom: string;
  consoleErrors: string[];
  failedRequests: string[];
  /** Plain titles of the latest changes, newest first. */
  recentChanges: string[];
  pageUrl?: string | null;
}

/** Two framings for the second opinion: the same evidence, approached from
 *  opposite ends, so agreement means something. */
export type DiagnosisFraming = "symptom-first" | "change-first";

export const FIX_STRIKE_LIMIT = 3;

const list = (title: string, items: readonly string[], empty: string) =>
  `${title}:\n${items.length ? items.slice(0, 20).map((i) => `- ${i.slice(0, 400)}`).join("\n") : `(${empty})`}`;

export function diagnosePrompt(input: DiagnoseInput, framing: DiagnosisFraming = "symptom-first"): string {
  const approach =
    framing === "symptom-first"
      ? "Start from what the person sees and the browser errors, then work back to the code that produces them."
      : "Be sceptical of the obvious explanation. Start from the most recent changes and ask which one could have caused this, then check it against the errors.";
  return [
    "You are diagnosing a problem in an app a non-engineer is building. DIAGNOSE ONLY: do not fix, do not propose to edit files yourself.",
    "You may read files in the current directory to confirm your theory.",
    approach,
    `What the person says is wrong: ${input.symptom.trim()}`,
    input.pageUrl ? `Page they are looking at: ${input.pageUrl}` : "",
    list("Browser console errors", input.consoleErrors, "none captured"),
    list("Failed network requests", input.failedRequests, "none captured"),
    list("Recent changes, newest first", input.recentChanges, "none recorded"),
    "Write likelyCause and suggestedFix in plain language the person understands; evidence items may quote an error or name a file.",
    "layer is where the cause lives: data (stored records), logic (rules and behaviour), view (what people see), auth (sign-in), deploy (hosting), integration (outside services).",
    'Reply with one JSON object: {"likelyCause":"…","evidence":["…"],"suggestedFix":"…","confidence":"low|medium|high","layer":"data|logic|view|auth|deploy|integration"}',
  ].filter(Boolean).join("\n");
}

const CONFIDENCE: readonly DiagnosisConfidence[] = ["low", "medium", "high"];

export function validateDiagnosis(v: unknown): Diagnosis | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = (x: unknown, max: number) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const likelyCause = text(o.likelyCause, 600);
  const suggestedFix = text(o.suggestedFix, 600);
  const confidence = text(o.confidence, 10).toLowerCase();
  const layer = text(o.layer, 20).toLowerCase();
  const evidence = Array.isArray(o.evidence) ? o.evidence.map((e) => text(e, 400)).filter(Boolean).slice(0, 8) : [];
  if (!likelyCause || !suggestedFix || !isLensLayer(layer) || !(CONFIDENCE as readonly string[]).includes(confidence)) {
    return null;
  }
  return { likelyCause, evidence, suggestedFix, confidence: confidence as DiagnosisConfidence, layer };
}

// ------------------------------------------------------------- convergence

const STOP = new Set(
  "the a an and or of to in on for is are was be it this that with when from by as at not no its their they your you can".split(" "),
);
const words = (s: string) =>
  new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

export type Convergence = "agree" | "partly" | "disagree";

/** Do two independent diagnoses point at the same thing? Same layer plus a
 *  real overlap in what they blame is agreement; same layer alone is partial;
 *  different layers is a disagreement worth showing. Deterministic on purpose:
 *  asking a third brain call to referee would cost more and explain less. */
export function diagnosesConverge(a: Diagnosis, b: Diagnosis): Convergence {
  if (a.layer !== b.layer) return "disagree";
  const wa = words(`${a.likelyCause} ${a.suggestedFix}`);
  const wb = words(`${b.likelyCause} ${b.suggestedFix}`);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const union = wa.size + wb.size - shared;
  return union > 0 && shared / union >= 0.2 ? "agree" : "partly";
}

export type DiagnoseResult =
  | { ok: true; primary: Diagnosis; second?: Diagnosis | null; convergence?: Convergence }
  | { ok: false; message: string };

export interface DiagnoseDeps {
  ask?: typeof askBrain;
}

/** Run the diagnosis — two in parallel with different framings when a second
 *  opinion is asked for. Main tier: the person is waiting on it. */
export async function diagnose(
  cwd: string,
  input: DiagnoseInput,
  opts: { secondOpinion?: boolean; signal?: AbortSignal } = {},
  deps: DiagnoseDeps = {},
): Promise<DiagnoseResult> {
  const ask = deps.ask ?? askBrain;
  const run = (framing: DiagnosisFraming): Promise<BrainAnswer<Diagnosis>> =>
    ask<Diagnosis>({
      feature: "lens",
      tier: "main",
      cwd,
      json: true,
      prompt: diagnosePrompt(input, framing),
      validate: validateDiagnosis,
      signal: opts.signal,
    });
  const [first, second] = await Promise.all([
    run("symptom-first"),
    opts.secondOpinion ? run("change-first") : Promise.resolve(null),
  ]);
  const primary = first.ok ? first.value ?? null : null;
  const other = second && second.ok ? second.value ?? null : null;
  // Either diagnosis is usable alone; only both failing is a failure.
  if (!primary && !other) {
    return { ok: false, message: first.ok ? "The diagnosis could not be read." : first.message };
  }
  if (!opts.secondOpinion) return { ok: true, primary: primary! };
  if (primary && other) return { ok: true, primary, second: other, convergence: diagnosesConverge(primary, other) };
  return { ok: true, primary: (primary ?? other)!, second: null };
}

// ---------------------------------------------------------- preview evidence

type ConsoleMessage = { level?: string; text?: string };
type NetworkRequest = { url?: string; method?: string; status?: number; error?: string };

/** Console errors and failed requests from the project's Build preview, via
 *  the same browser ops Build's own verification reads. Empty when there is no
 *  preview or it cannot be read — the diagnosis says "none captured". */
export async function previewEvidence(projectId: string): Promise<{
  consoleErrors: string[];
  failedRequests: string[];
  pageUrl: string | null;
}> {
  const context = getVibePreviewContext(projectId);
  const tabId = context?.tabId;
  if (!tabId) return { consoleErrors: [], failedRequests: [], pageUrl: null };
  const [consoleAck, networkAck] = await Promise.all([
    ipc.browserRunOp(tabId, { op: "console", lines: 300 }).catch(() => null),
    ipc.browserRunOp(tabId, { op: "network", lines: 300 }).catch(() => null),
  ]);
  const messages = ((consoleAck?.ok ? consoleAck.data : null) as { messages?: ConsoleMessage[] } | null)?.messages ?? [];
  const requests = ((networkAck?.ok ? networkAck.data : null) as { requests?: NetworkRequest[] } | null)?.requests ?? [];
  const consoleErrors = [...new Set(
    (Array.isArray(messages) ? messages : [])
      .filter((m) => m.level === "error")
      .map((m) => (m.text ?? "").trim())
      .filter(Boolean),
  )].slice(-20);
  const failedRequests = (Array.isArray(requests) ? requests : [])
    .filter((r) => Boolean(r.error) || r.status === 0 || (typeof r.status === "number" && r.status >= 400))
    .map((r) => `${r.method ?? "GET"} ${r.url ?? "?"} → ${r.error || r.status}`)
    .slice(-20);
  return { consoleErrors, failedRequests, pageUrl: context?.url || null };
}

// ------------------------------------------------------------ three strikes

/** The same problem described twice should count as one symptom. */
export function symptomKey(symptom: string): string {
  return symptom.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
}

export interface FixAttempt {
  symptom: string;
  diagnosis: Diagnosis;
}

export type FixResult = "fixed" | "failed";
const SYMPTOM_REF = "lens-symptom";

export async function fixAttempts(root: string, symptom: string): Promise<LedgerEntry<FixAttempt>[]> {
  return queryLedger<FixAttempt>(root, {
    kinds: ["outcome"], refKind: SYMPTOM_REF, refId: symptomKey(symptom), limit: 50,
  }).catch(() => []);
}

/** Failed fixes for this symptom since it was last fixed. A fix still pending
 *  counts too: starting another means the last one didn't do it. */
export function strikesFrom(attempts: readonly Pick<LedgerEntry, "status" | "ts">[]): number {
  let strikes = 0;
  for (const a of [...attempts].sort((x, y) => y.ts - x.ts)) {
    if (a.status === "fixed") break;
    strikes++;
  }
  return strikes;
}

export const canTryAnotherFix = (strikes: number) => strikes < FIX_STRIKE_LIMIT;

/** Record that a fix is starting. Any earlier pending attempt on the same
 *  symptom is settled as failed first — the person is trying again. */
export async function startFixAttempt(root: string, attempt: FixAttempt): Promise<LedgerEntry<FixAttempt> | null> {
  const prior = await fixAttempts(root, attempt.symptom);
  await Promise.all(
    prior.filter((p) => p.status === "pending").map((p) => setLedgerStatus(root, p.id, "failed").catch(() => undefined)),
  );
  return appendLedger<FixAttempt>(root, {
    kind: "outcome",
    author: { kind: "human", name: "lens" },
    scope: "project",
    subject: `Fix attempt: ${attempt.symptom.slice(0, 120)}`,
    ref: { kind: SYMPTOM_REF, id: symptomKey(attempt.symptom) },
    data: attempt,
    status: "pending",
  }).catch(() => null);
}

export async function settleFixAttempt(root: string, entry: LedgerEntry<FixAttempt>, result: FixResult): Promise<void> {
  await setLedgerStatus(root, entry.id, result).catch(() => undefined);
}

/** What the fixing agent is handed: the person's words plus the diagnosis as
 *  context, so the transcript shows their request and the agent sees why. */
export function fixRequest(symptom: string, d: Diagnosis): { text: string; context: string } {
  return {
    text: `Please fix this: ${symptom.trim()}`,
    context: [
      "A separate read-only diagnosis was run before this fix. Use it, but verify it before changing anything.",
      `Likely cause: ${d.likelyCause}`,
      d.evidence.length ? `Evidence:\n${d.evidence.map((e) => `- ${e}`).join("\n")}` : "",
      `Suggested fix: ${d.suggestedFix}`,
      `Confidence: ${d.confidence}. Layer: ${d.layer}.`,
      "Change only what this fix needs.",
    ].filter(Boolean).join("\n"),
  };
}

/** After three strikes: go back to the last version that worked and rebuild
 *  from the plan, rather than a fourth patch on a patch. */
export function restartFromPlanRequest(args: {
  symptom: string;
  checkpoint: { sha: string; title: string } | null;
  plan: string | null;
  tried: readonly Diagnosis[];
  /** The builder lens already restored the checkpoint's files (lensRestore). */
  restored?: boolean;
}): { text: string; context: string } {
  return {
    text: args.checkpoint
      ? `Let's start over from “${args.checkpoint.title}”, the last version that worked, and rebuild from the plan.`
      : "Let's start over from the plan instead of patching this again.",
    context: [
      `Three fixes for "${args.symptom.trim()}" did not work. Stop patching.`,
      args.checkpoint && args.restored
        ? `The project's files are already back to saved version ${args.checkpoint.sha} ("${args.checkpoint.title}"), committed as a new version. Confirm the preview works.`
        : args.checkpoint
        ? `Restore the project's files to saved version ${args.checkpoint.sha} ("${args.checkpoint.title}") without rewriting history (check the files out from that version and commit the result as a new version), then confirm the preview works.`
        : "There is no saved version to return to; keep the current files but rebuild the broken part cleanly.",
      args.plan ? `Then rebuild what came after, following this plan, avoiding what failed:\n${args.plan}` : "Then rebuild what came after, one small step at a time, avoiding what failed.",
      args.tried.length ? `What was tried and failed:\n${args.tried.map((d) => `- ${d.likelyCause} → ${d.suggestedFix}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
  };
}

/** Restore one saved version, through the Build session (it has the write
 *  authority and verifies the result; this lens never writes files itself). */
export function goBackRequest(checkpoint: { sha: string; title: string }): { text: string; context: string } {
  return {
    text: `Go back to “${checkpoint.title}”.`,
    context: `Restore the project's files to how they were at saved version ${checkpoint.sha} without rewriting history: check the files out from that version, commit the result as a new version, and confirm the preview still works.`,
  };
}

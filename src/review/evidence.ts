// The evidence half of a review: the proof receipt for a run, and the
// autonomy ledger — how work of this kind has held up in this repo.
//
// Receipts are written by the proof-receipts feature as `receipt` ledger
// entries (ref = the agent's session or turn). This module only reads them,
// and reads defensively: a missing field is a missing line, an unknown shape
// is "No receipt yet", never a crash.
//
// The autonomy ledger (MVP) is computed, not stored: per repo and task class
// (the brain files every plan under one), count the receipt verdicts of the
// runs that executed those plans, and how many of those runs were later
// reverted (see "reverts" below for the three signs). A class with a strong
// record is shown as *eligible* for auto-merge. Nothing auto-merges: the
// graduation is a recommendation on screen, and stays one.

import * as ipc from "../ipc";
import { queryLedger, type LedgerEntry } from "../ledger";
import type { PlanData, TaskClass } from "../plans/plan";

export type Verdict = "proven" | "partial" | "unproven" | "contradicted";
const VERDICTS: readonly Verdict[] = ["proven", "partial", "unproven", "contradicted"];

export interface ReceiptView {
  verdict: Verdict | null;
  asked: string;
  did: string;
  evidence: string[];
  gaps: string[];
  checks: { name: string; ok: boolean | null; detail: string }[];
  tampered: boolean;
  /** The plan's acceptance checks as the receipt's verdict judged them, in
   *  the plan's order. Empty when the run had no plan (or no verdict). */
  acceptance: { item: string; met: boolean | null; evidence: string }[];
  ts: number;
}

const text = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const t = [o.text, o.what, o.summary, o.claim, o.name, o.description].find((x) => typeof x === "string");
    if (typeof t === "string") return t;
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
};
const texts = (v: unknown) =>
  (Array.isArray(v) ? v : [])
    .map(text)
    .map((t) => t.replace(/\s+/g, " ").trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 20);

/** A receipt entry as something the review can show. */
export function readReceipt(entry: LedgerEntry): ReceiptView {
  const d = (entry.data && typeof entry.data === "object" ? entry.data : {}) as Record<string, unknown>;
  // A receipts-feature entry nests the brain's judgement (`verdict: {verdict,
  // did, …}`) and files the final, evidence-capped `status` beside it; a
  // flat shape carries it all at the top.
  const brain = (d.verdict && typeof d.verdict === "object" ? d.verdict : {}) as Record<string, unknown>;
  const pick = (k: string) => (d[k] !== undefined ? d[k] : brain[k]);
  const verdict = VERDICTS.includes(d.status as Verdict)
    ? (d.status as Verdict)
    : VERDICTS.includes(d.verdict as Verdict)
      ? (d.verdict as Verdict)
      : VERDICTS.includes(brain.verdict as Verdict)
        ? (brain.verdict as Verdict)
        : null;
  const rawChecks = Array.isArray(d.checks) ? d.checks : d.checks && typeof d.checks === "object" ? Object.entries(d.checks).map(([name, v]) => ({ name, ...(typeof v === "object" ? v : { value: v }) })) : [];
  const checks = rawChecks.slice(0, 20).map((c) => {
    const o = (c && typeof c === "object" ? c : { name: text(c) }) as Record<string, unknown>;
    const exit = typeof o.exit === "number" ? o.exit : typeof o.exitCode === "number" ? o.exitCode : null;
    const outcome = typeof o.outcome === "string" ? o.outcome : null;
    const ok =
      outcome === "passed" ? true : outcome === "failed" ? false : outcome ? null
      : typeof o.passed === "boolean" ? o.passed : typeof o.ok === "boolean" ? o.ok : exit != null ? exit === 0 : null;
    const nums = (o.counts && typeof o.counts === "object" ? o.counts : o) as Record<string, unknown>;
    const counts = ["passed", "failed", "count", "total"]
      .filter((k) => typeof nums[k] === "number")
      .map((k) => `${nums[k]} ${k}`)
      .join(", ");
    const detail = [outcome && outcome !== "passed" && outcome !== "failed" ? outcome.replace("-", " ") : "", exit != null ? `exit ${exit}` : "", counts]
      .filter(Boolean)
      .join(" · ");
    return { name: text(o.label ?? o.name ?? o.command ?? o.check ?? "check").slice(0, 200), ok, detail };
  });
  const tamper = d.tamper ?? d.tampered ?? d.tamperFlags;
  const tampered = Array.isArray(tamper) ? tamper.length > 0 : tamper === true || (!!tamper && typeof tamper === "object" && Object.values(tamper).some(Boolean));
  const rawAcceptance = Array.isArray(brain.acceptance) ? brain.acceptance : Array.isArray(d.acceptance) ? d.acceptance : [];
  const acceptance = rawAcceptance
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .slice(0, 12)
    .map((a) => ({
      item: text(a.item).slice(0, 300),
      met: a.met === true ? true : a.met === false ? false : null,
      evidence: text(a.evidence).slice(0, 300),
    }))
    .filter((a) => a.item);
  return {
    verdict,
    asked: text(pick("asked")).slice(0, 600),
    did: text(pick("did")).slice(0, 800),
    evidence: texts(pick("evidence")),
    gaps: texts(pick("gaps")),
    checks,
    tampered,
    acceptance,
    ts: entry.ts,
  };
}

/** Does this receipt belong to the run with `sessionId`? Its ref may be the
 *  session, or a turn (`<sessionId>:<startedAt>`). */
export function receiptMatches(entry: LedgerEntry, sessionId: string): boolean {
  const ref = entry.ref?.id ?? "";
  const d = (entry.data ?? {}) as Record<string, unknown>;
  return ref === sessionId || ref.startsWith(`${sessionId}:`) || d.sessionId === sessionId;
}

/** The newest receipt for a session, or null ("No receipt yet"). */
export async function latestReceipt(dir: string, sessionId: string | null | undefined): Promise<ReceiptView | null> {
  if (!sessionId) return null;
  const rows = await queryLedger(dir, { kinds: ["receipt"], limit: 500 }).catch(() => [] as LedgerEntry[]);
  const hit = rows.find((r) => receiptMatches(r, sessionId));
  return hit ? readReceipt(hit) : null;
}

/** One line for the brain's review prompt. */
export function receiptLine(r: ReceiptView | null): string | undefined {
  if (!r) return undefined;
  return [
    r.verdict ? `verdict ${r.verdict}` : "no verdict",
    r.gaps.length ? `gaps: ${r.gaps.join("; ")}` : "",
    r.checks.length ? `checks: ${r.checks.map((c) => `${c.name} ${c.ok === true ? "passed" : c.ok === false ? "failed" : "?"}`).join(", ")}` : "",
    r.acceptance.length
      ? `acceptance: ${r.acceptance.map((a, i) => `(${i + 1}) ${a.item} — ${a.met === true ? "met" : a.met === false ? "NOT met" : "not shown"}`).join("; ")}`
      : "",
    r.tampered ? "TAMPER FLAGS RAISED" : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

// --------------------------------------------------------------- reverts
//
// Was a run's work later undone? Three independent signs, any one enough:
//
//  * a commit whose message carries git's revert trailer, "This reverts
//    commit <sha>", naming one of the run's commits (whatever its subject);
//  * a later commit whose patch is the exact inverse of one of the run's
//    commits, or of the run's whole change — git's patch-id idea (changed
//    lines, whitespace ignored, order ignored), which catches a hand-made
//    revert and the revert of a squash-merged pull request alike;
//  * GitHub's own revert link: a revert PR ("Reverts owner/repo#N", or its
//    `revert-N-…` branch) whose target PR N landed the run's commits (a merge
//    containing them) or the run's change (a squash with the same patch).
//    When a revert's commit names only its own PR, `gh` reads that PR's body.

const REVERT_TTL = 5 * 60_000;
const LOG_DEPTH = 400;

interface LogCommit {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
  files: string[];
}

export interface RevertIndex {
  commits: LogCommit[];
  /** Shas named by a "This reverts commit <sha>" trailer. */
  shas: string[];
  /** Subjects quoted by `Revert "<subject>"`. */
  subjects: Set<string>;
  /** Pull requests GitHub says were reverted. */
  prs: Set<number>;
}

const revertCache = new Map<string, { at: number; value: Promise<RevertIndex> }>();
const planCache = new Map<string, { at: number; value: Promise<boolean> }>();

/** git through the receipts runner: works the same on this computer and in a
 *  Linux workspace, and a non-zero exit is an answer, not an exception. */
async function gitText(dir: string, args: string[], keepBytes = 1024 * 1024): Promise<string | null> {
  try {
    const r = await ipc.receiptRunCheck(dir, ["git", ...args], { timeoutMs: 30_000, head: true, keepBytes });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

const RS = "\x1e";
const US = "\x1f";

export function parseLog(log: string, names: string): LogCommit[] {
  const files = new Map<string, string[]>();
  for (const rec of names.split(RS)) {
    const [sha, ...rest] = rec.trim().split("\n");
    if (sha) files.set(sha.trim(), rest.map((l) => l.trim()).filter(Boolean).sort());
  }
  return log
    .split(RS)
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha = "", parents = "", subject = "", body = ""] = rec.split(US);
      return { sha: sha.trim(), parents: parents.trim().split(/\s+/).filter(Boolean), subject: subject.trim(), body: body.trim(), files: files.get(sha.trim()) ?? [] };
    })
    .filter((c) => /^[0-9a-f]{7,64}$/.test(c.sha));
}

const TRAILER = /this reverts commit ([0-9a-f]{7,64})/gi;
const REVERTS_PR = /\bReverts\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
const REVERT_BRANCH = /\brevert-(\d+)-/i;
const OWN_PR = /\(#(\d+)\)\s*$/;

/** The repo's recent history read once for every revert sign. */
export function revertIndex(dir: string): Promise<RevertIndex> {
  const hit = revertCache.get(dir);
  if (hit && Date.now() - hit.at < REVERT_TTL) return hit.value;
  const value = (async (): Promise<RevertIndex> => {
    const [log, names] = await Promise.all([
      gitText(dir, ["log", "-n", String(LOG_DEPTH), "--no-color", `--format=${RS}%H${US}%P${US}%s${US}%b`]),
      gitText(dir, ["log", "-n", String(LOG_DEPTH), "--no-color", `--format=${RS}%H`, "--name-only"]),
    ]);
    const commits = parseLog(log ?? "", names ?? "");
    const shas: string[] = [];
    const subjects = new Set<string>();
    const prs = new Set<number>();
    let asked = 0;
    for (const c of commits) {
      const text = `${c.subject}\n${c.body}`;
      for (const m of text.matchAll(TRAILER)) shas.push(m[1].toLowerCase());
      const quoted = /^Revert "(.+)"/i.exec(c.subject)?.[1];
      if (quoted) subjects.add(quoted.replace(/\s*\(#\d+\)$/, ""));
      const before = prs.size;
      for (const m of text.matchAll(REVERTS_PR)) prs.add(Number(m[1]));
      const branch = REVERT_BRANCH.exec(c.subject)?.[1];
      if (branch) prs.add(Number(branch));
      // A squash-merged revert PR names only itself ("Revert "x" (#124)"):
      // GitHub's body says which PR it undid.
      const own = OWN_PR.exec(c.subject)?.[1];
      if (prs.size === before && own && /^revert\b/i.test(c.subject) && asked < 10) {
        asked++;
        const body = await ipc.ghPrBody(dir, Number(own)).catch(() => "");
        for (const m of (body ?? "").matchAll(REVERTS_PR)) prs.add(Number(m[1]));
      }
    }
    return { commits, shas, subjects, prs };
  })();
  revertCache.set(dir, { at: Date.now(), value });
  return value;
}

/** A patch reduced to what patch-id compares: per file, the changed lines
 *  with whitespace removed, order ignored. `invert` swaps + and -. */
export function patchSignature(patch: string, invert = false): string {
  const byFile = new Map<string, string[]>();
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = /diff --git a\/(.+?) b\/(.+)$/.exec(line)?.[2] ?? line;
      if (!byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (!file || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line[0] !== "+" && line[0] !== "-") continue;
    const sign = invert ? (line[0] === "+" ? "-" : "+") : line[0];
    byFile.get(file)!.push(sign + line.slice(1).replace(/\s+/g, ""));
  }
  const parts = [...byFile.entries()].filter(([, l]) => l.length).sort(([a], [b]) => a.localeCompare(b));
  return parts.map(([f, l]) => `${f}\n${l.sort().join("\n")}`).join("\n\n");
}

const filesOf = (patch: string) =>
  [...patch.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((m) => m[1]).sort();
const sameFiles = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const shaHit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

async function showPatch(dir: string, sha: string): Promise<string> {
  return (await gitText(dir, ["show", "--format=", "--no-color", "--no-ext-diff", sha])) ?? "";
}

/** Did any of the three signs fire for this run's commits? */
export function planReverted(dir: string, plan: PlanData, index: RevertIndex): Promise<boolean> {
  const commits = (plan.commits ?? []).filter((c) => /^[0-9a-f]{7,64}$/.test(c.sha));
  if (!commits.length) return Promise.resolve(false);
  const key = `${dir}\0${plan.planId}\0${commits.map((c) => c.sha).join(",")}`;
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < REVERT_TTL) return hit.value;
  const value = (async () => {
    // 1. The revert trailer, or git's own `Revert "<subject>"`.
    if (commits.some((c) => index.shas.some((s) => shaHit(c.sha, s)) || index.subjects.has(c.subject))) return true;
    const ours = new Set(commits.map((c) => c.sha));
    const later = index.commits.filter((c) => c.parents.length <= 1 && ![...ours].some((s) => shaHit(s, c.sha)));
    // The run's patches: each commit, and the whole change (what a squash
    // merge lands, and what reverting that squash undoes).
    const oldest = commits[commits.length - 1].sha;
    const newest = commits[0].sha;
    const whole = await gitText(dir, ["diff", "--no-color", "--no-ext-diff", plan.baseHead ?? `${oldest}^`, newest]);
    const patches = [whole ?? "", ...(await Promise.all(commits.slice(0, 5).map((c) => showPatch(dir, c.sha))))].filter(Boolean);
    // 2. An exact inverse among later commits touching the same files.
    for (const patch of patches) {
      const files = filesOf(patch);
      const inverse = patchSignature(patch, true);
      if (!inverse) continue;
      for (const c of later.filter((x) => sameFiles(x.files, files)).slice(0, 8))
        if (patchSignature(await showPatch(dir, c.sha)) === inverse) return true;
    }
    // 3. GitHub: a reverted PR that landed this run.
    for (const n of index.prs) {
      for (const c of index.commits) {
        if (c.parents.length > 1 && new RegExp(`^Merge pull request #${n}\\b`).test(c.subject)) {
          const landed = (await gitText(dir, ["rev-list", `${c.parents[0]}..${c.sha}`])) ?? "";
          const shas = landed.split("\n").map((x) => x.trim()).filter(Boolean);
          if (shas.some((sha) => [...ours].some((s) => shaHit(sha, s)))) return true;
        } else if (OWN_PR.exec(c.subject)?.[1] === String(n) && whole) {
          if (patchSignature(await showPatch(dir, c.sha)) === patchSignature(whole)) return true;
        }
      }
    }
    return false;
  })().catch(() => false);
  planCache.set(key, { at: Date.now(), value });
  return value;
}

/** Plan ids among `plans` whose work was later reverted. */
export async function revertedPlans(dir: string, plans: LedgerEntry<PlanData>[]): Promise<Set<string>> {
  const out = new Set<string>();
  const withCommits = plans.filter((p) => p.data?.commits?.length).slice(0, 60);
  if (!withCommits.length) return out;
  const index = await revertIndex(dir);
  for (const p of withCommits) if (await planReverted(dir, p.data, index)) out.add(p.data.planId);
  return out;
}

// ------------------------------------------------------- autonomy ledger

export interface TrackRecord {
  taskClass: TaskClass;
  runs: number;
  proven: number;
  partial: number;
  unproven: number;
  contradicted: number;
  reverted: number;
  /** A displayed recommendation only. Nothing in Canopy acts on it. */
  eligible: boolean;
}

/** Proven runs a class needs, with no reverts or contradictions, before it is
 *  shown as eligible for auto-merge. */
export const GRADUATE_AFTER = 10;

export function scoreTrackRecord(
  taskClass: TaskClass,
  plans: LedgerEntry<PlanData>[],
  receipts: LedgerEntry[],
  /** Plan ids whose work was later reverted (`revertedPlans`). */
  reverted: Set<string>,
): TrackRecord {
  const rec: TrackRecord = { taskClass, runs: 0, proven: 0, partial: 0, unproven: 0, contradicted: 0, reverted: 0, eligible: false };
  for (const p of plans) {
    if (p.data?.taskClass !== taskClass || !p.data.sessionId) continue;
    rec.runs++;
    const receipt = receipts.find((r) => receiptMatches(r, p.data.sessionId as string));
    const verdict = receipt ? readReceipt(receipt).verdict : null;
    if (verdict) rec[verdict]++;
    if (reverted.has(p.data.planId)) rec.reverted++;
  }
  rec.eligible = rec.proven >= GRADUATE_AFTER && rec.reverted === 0 && rec.contradicted === 0;
  return rec;
}

export async function trackRecord(dir: string, taskClass: TaskClass): Promise<TrackRecord> {
  const [plans, receipts] = await Promise.all([
    queryLedger<PlanData>(dir, { kinds: ["plan"], limit: 2000 }).catch(() => [] as LedgerEntry<PlanData>[]),
    queryLedger(dir, { kinds: ["receipt"], limit: 2000 }).catch(() => [] as LedgerEntry[]),
  ]);
  const ofClass = plans.filter((p) => p.data?.taskClass === taskClass && p.data.sessionId);
  const reverted = await revertedPlans(dir, ofClass).catch(() => new Set<string>());
  return scoreTrackRecord(taskClass, plans, receipts, reverted);
}

/** Tests only. */
export function resetEvidenceForTests(): void {
  revertCache.clear();
  planCache.clear();
}

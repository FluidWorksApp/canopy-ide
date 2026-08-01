// Pruning: the arithmetic behind "this list is too long, take most of it away".
//
// A repo an agent has been working in for a month has 130 branches and 40
// workspaces, and every surface that lists them — the branch list, Loose ends,
// the Servers panel's per-workspace rows — is unreadable for the same reason.
// The lists are not the problem; the leftovers are. So there is one screen that
// takes them away in bulk, and this module is everything that screen has to be
// sure of before it does.
//
// The rule the whole thing turns on: a preset never ticks a row that would lose
// work. Uncommitted files live only in that folder and unpushed commits live
// only in this clone, so those rows can be ticked — by hand, one at a time,
// with what they cost written on them — and never by "Select safe" or by
// opening the dialog. `presetSelection` enforces that, and it is tested for it,
// because a bulk delete that is one preset away from dropping a day's work is
// worse than no bulk delete at all.
import type * as ipc from "./ipc";

/** How much you'd lose by taking a branch away, in the two units that matter.
 *  Both zero means the work exists somewhere else — on the remote, or on the
 *  base branch — and removing this is bookkeeping. */
export interface PruneLoss {
  /** Uncommitted files in its workspace. They exist in that folder and nowhere
   *  else in the world. */
  files: number;
  /** Commits that are on no remote. They exist in this clone and nowhere else. */
  commits: number;
}

/**
 * What kind of leftover this is, worst first. The tier decides the group it
 * lands in, the colour of that group's heading and — via `loses()` — whether a
 * preset is allowed to touch it.
 *
 * - `uncommitted` — files only in that directory.
 * - `unpushed`    — commits only in this clone.
 * - `open`        — pushed and not merged. Nothing is lost by deleting the
 *                   local copy, but it is still work someone is doing.
 * - `safe`        — merged, or its remote branch is gone. Pure clutter.
 */
export type PruneRisk = "uncommitted" | "unpushed" | "open" | "safe";

export const RISK_ORDER: PruneRisk[] = ["safe", "open", "unpushed", "uncommitted"];

export const RISK_LABEL: Record<PruneRisk, string> = {
  safe: "Safe to prune",
  open: "Still open",
  unpushed: "Unpushed commits",
  uncommitted: "Uncommitted work",
};

export const RISK_HINT: Record<PruneRisk, string> = {
  safe: "Merged, or its remote branch is gone. Nothing here exists only here.",
  open: "Pushed but not merged. The commits are on the remote, so only the local name goes.",
  unpushed: "Commits that are in this clone and nowhere else. Pruning drops them.",
  uncommitted: "Files that are in that folder and nowhere else. Pruning drops them.",
};

/** One git command a prune will run, in the order it runs them. */
export interface PruneStep {
  kind: "worktree" | "branch" | "remote";
  /** The command itself — this is a teaching surface as much as a delete one. */
  hint: string;
}

/** A branch, everything the decision about it needs, in one row. */
export interface PruneCandidate {
  /** The branch name, which is also the row's identity in a selection Set. */
  key: string;
  branch: ipc.BranchWork;
  risk: PruneRisk;
  /** Why it landed in that tier, as a clause for the row. */
  why: string;
  /** Non-null when it can never be pruned from here, and this is the reason.
   *  Listed anyway rather than hidden: "why isn't this in the list" is a
   *  question a pruning tool that drops rows can never answer. */
  blocked: string | null;
  /** Something live is running in its folder — an agent, a server, a terminal.
   *  Not a block (you may well want that workspace gone) but never pre-ticked. */
  busy: boolean;
  loss: PruneLoss;
}

/** The folder's own name — what a person calls a workspace. */
export const baseName = (path: string) =>
  path.replace(/\/+$/, "").split("/").pop() || path;

/**
 * Why git kept something, in words. Only the refusals a bulk prune actually
 * meets are worth naming; anything else keeps git's own first line, which is
 * better than the silence a swallowed error leaves.
 */
export function whyRefused(err: string): string {
  const at = /checked out at '([^']+)'/.exec(err)?.[1];
  if (at) return `it's open in ${baseName(at)}`;
  if (/not fully merged/i.test(err))
    return "it still has commits that aren't on the base branch";
  if (/locked/i.test(err)) return "something still has that workspace locked";
  return (
    err
      .split("\n")
      .map((l) => l.replace(/^(error|fatal|warning):\s*/i, "").trim())
      .find(Boolean) ?? "git wouldn't say why"
  );
}

/**
 * Is one of these live directories inside this workspace?
 *
 * A run's cwd is a component folder *within* the checkout, so this is a prefix
 * test and not an equality one — that difference is the whole reason a
 * workspace with a dev server in it used to come up ticked.
 *
 * The exception is the one that makes the prefix test wrong on its own: agent
 * workspaces are created *under* the repo, at `.claude/worktrees/<name>`, so by
 * plain prefix every single one of them makes the main checkout look busy. A
 * cwd below that folder belongs to whichever workspace owns it and to nothing
 * above it.
 */
export function isBusy(path: string | null, busy: readonly string[]): boolean {
  if (!path) return false;
  const root = path.replace(/\/+$/, "");
  return busy.some((d) => {
    const c = d.replace(/\/+$/, "");
    if (c === root) return true;
    if (!c.startsWith(`${root}/`)) return false;
    return !c.slice(root.length + 1).startsWith(".claude/worktrees/");
  });
}

/** What a candidate would destroy. Uncommitted files only count when there is
 *  a folder to remove — a branch with no workspace has no working tree to lose,
 *  whatever a stale audit says. */
function lossOf(b: ipc.BranchWork, countsDegraded: boolean): PruneLoss {
  const files = b.worktree && !b.prunable ? b.dirty : 0;
  // Merged means every commit on it is reachable from the base branch, so
  // there is nothing on it that exists only here — whatever `ahead` says about
  // an upstream it has drifted from. Checked before the counts, exactly as the
  // Loose ends buckets do, so the degraded case below can't overrule it.
  if (b.merged) return { files, commits: 0 };
  // Mirror git.rs: `ahead` is counted against the BASE BRANCH whenever there is
  // no usable upstream, and that count needs git 2.41+. Where it is
  // unavailable every such branch reports 0 — so trusting it would call a
  // branch that exists only in this clone lossless, and a preset would tick it.
  // Assume it holds a commit instead; the dialog's banner says why the number
  // is missing.
  const blind = (!b.upstream || b.upstream_gone) && countsDegraded;
  const commits = blind ? Math.max(b.ahead, 1) : b.ahead;
  return { files, commits };
}

function riskOf(b: ipc.BranchWork, loss: PruneLoss): { risk: PruneRisk; why: string } {
  if (loss.files > 0)
    return {
      risk: "uncommitted",
      // Just the count. Which folder they are in is already on the row as a
      // chip and in full in its tooltip, and a row this long truncates the end
      // of the sentence — which is the half that matters.
      why: `${loss.files} uncommitted file${loss.files === 1 ? "" : "s"}`,
    };
  if (loss.commits > 0)
    return {
      risk: "unpushed",
      why: `${loss.commits} commit${loss.commits === 1 ? "" : "s"} that are on no remote`,
    };
  if (b.merged) return { risk: "safe", why: "already merged into the base" };
  if (b.upstream_gone)
    return { risk: "safe", why: "its remote branch is gone — usually a squash-merge" };
  if (!b.upstream) return { risk: "open", why: "never pushed, but holds no commits of its own" };
  return { risk: "open", why: "pushed and not merged yet" };
}

/** Why this row is never offered, or null when it is. */
function blockOf(b: ipc.BranchWork, base: string): string | null {
  // The audit's base is a remote-tracking ref ("origin/main"), so a local
  // branch never equals it outright — compare on the tail as well, or `main`
  // reads as merely protected and the row stops saying what it actually is.
  const isBase = b.branch === base || base.endsWith(`/${b.branch}`);
  if (b.protected) return isBase ? "the base branch" : "a protected branch";
  if (b.current) return "the branch you're on";
  if (b.is_main) return "checked out in this project's own folder";
  return null;
}

/**
 * Every branch in the repo as a prune decision, ordered the way you read them:
 * the disposable pile first and oldest-first inside it (the most forgotten is
 * the most deletable), then the tiers that cost something, newest-first —
 * because the risky row you most need to recognise is the one you were working
 * on this morning. Blocked rows sort last within their tier; they are there to
 * be accounted for, not acted on.
 */
export function pruneCandidates(
  audit: ipc.WorkAudit,
  busy: readonly string[] = [],
): PruneCandidate[] {
  const rows = audit.items.map((b): PruneCandidate => {
    const loss = lossOf(b, audit.counts_degraded);
    const { risk, why } = riskOf(b, loss);
    return {
      key: b.branch,
      branch: b,
      risk,
      why,
      blocked: blockOf(b, audit.base),
      busy: isBusy(b.worktree, busy),
      loss,
    };
  });
  return rows.sort((x, y) => {
    const r = RISK_ORDER.indexOf(x.risk) - RISK_ORDER.indexOf(y.risk);
    if (r !== 0) return r;
    if (!!x.blocked !== !!y.blocked) return x.blocked ? 1 : -1;
    return x.risk === "safe"
      ? y.branch.age_days - x.branch.age_days
      : x.branch.age_days - y.branch.age_days;
  });
}

/** Would taking this away destroy something that exists nowhere else? */
export const loses = (c: PruneCandidate) => c.loss.files > 0 || c.loss.commits > 0;

/** Can a click tick this row at all? Blocked rows can't; risky ones can, one at
 *  a time — that is what "by hand" means here. */
export const selectable = (c: PruneCandidate) => c.blocked === null;

export type PrunePreset = "safe" | "gone" | "stale" | "none";

/**
 * Four, and four is the cap — the segmented control this renders in is right
 * that a fifth choice stops being a row you read and starts being a menu. So
 * there is no "Merged" here: it is the bulk of what `safe` already selects, and
 * on its own it is the least trustworthy of the three signals, because a
 * squash-merged branch never reads as merged at all.
 */
export const PRESETS: { id: PrunePreset; label: string; hint: string }[] = [
  {
    id: "safe",
    label: "Safe",
    hint: "Everything merged or with its remote branch gone, holding nothing of its own.",
  },
  {
    id: "gone",
    label: "Remote gone",
    hint: "Branches whose remote was deleted — usually the sign of a squash-merge.",
  },
  { id: "stale", label: "Untouched 30d", hint: "Nothing committed on them in a month." },
  { id: "none", label: "None", hint: "Clear the selection and pick by hand." },
];

/**
 * What a preset ticks.
 *
 * Every preset is filtered through the same three guards before its own rule is
 * even asked: never a blocked row, never a row something is running in, and
 * never a row that would lose work. So "Untouched 30d" cannot reach the branch
 * you forgot to push in June, and no future preset can either.
 */
export function presetSelection(
  candidates: readonly PruneCandidate[],
  preset: PrunePreset,
  staleDays = 30,
): Set<string> {
  if (preset === "none") return new Set();
  const rule = (c: PruneCandidate): boolean => {
    switch (preset) {
      case "safe":
        return c.risk === "safe";
      case "gone":
        return c.branch.upstream_gone;
      case "stale":
        return c.branch.age_days >= staleDays;
    }
  };
  return new Set(
    candidates
      .filter((c) => selectable(c) && !c.busy && !loses(c) && rule(c))
      .map((c) => c.key),
  );
}

/** The git this row will run, in order. The worktree always goes first: git
 *  refuses to delete a branch that something has checked out, so the other
 *  order would refuse every row that has a folder. */
export function planFor(c: PruneCandidate, remote: boolean): PruneStep[] {
  const steps: PruneStep[] = [];
  const b = c.branch;
  if (b.worktree && !b.is_main)
    steps.push({
      kind: "worktree",
      hint: `git worktree remove${b.dirty > 0 ? " --force" : ""} ${b.worktree}`,
    });
  steps.push({ kind: "branch", hint: `git branch -D ${b.branch}` });
  if (remote && b.upstream && !b.upstream_gone)
    steps.push({ kind: "remote", hint: `git push origin --delete ${b.branch}` });
  return steps;
}

export interface PruneTally {
  /** Rows selected — one local branch delete each. */
  branches: number;
  /** Folders that go with them. */
  worktrees: number;
  /** Branches that also go from the remote. Zero unless that is switched on. */
  remotes: number;
  files: number;
  commits: number;
}

export function tally(
  candidates: readonly PruneCandidate[],
  selected: ReadonlySet<string>,
  remote: boolean,
): PruneTally {
  const t: PruneTally = { branches: 0, worktrees: 0, remotes: 0, files: 0, commits: 0 };
  for (const c of candidates) {
    if (!selected.has(c.key) || !selectable(c)) continue;
    t.branches++;
    t.files += c.loss.files;
    t.commits += c.loss.commits;
    for (const s of planFor(c, remote)) {
      if (s.kind === "worktree") t.worktrees++;
      if (s.kind === "remote") t.remotes++;
    }
  }
  return t;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The consequence line, which is the only place the whole cost is stated at
 *  once: what goes, and — if anything — what will not exist afterwards. */
export function pruneSummary(t: PruneTally, base: string): string {
  if (t.branches === 0) return "Nothing selected.";
  const goes = [plural(t.branches, "branch", "branches")];
  if (t.worktrees > 0) goes.push(plural(t.worktrees, "workspace"));
  if (t.remotes > 0) goes.push(`${plural(t.remotes, "remote branch", "remote branches")} on origin`);
  const head = `${goes.join(", ")} go.`;
  const lost: string[] = [];
  if (t.files > 0) lost.push(plural(t.files, "uncommitted file"));
  if (t.commits > 0) lost.push(plural(t.commits, "unpushed commit"));
  return lost.length === 0
    ? `${head} Nothing is lost — every one of them is already on ${base} or on the remote.`
    : `${head} ${lost.join(" and ")} go with them, and exist nowhere else afterwards.`;
}

/** Accent or danger: does this button destroy something, or only tidy up? */
export const pruneIsLossy = (t: PruneTally) => t.files > 0 || t.commits > 0;

export function pruneLabel(t: PruneTally): string {
  if (t.branches === 0) return "Prune";
  return `Prune ${t.branches}`;
}

// ---------------------------------------------------------------------------
// Running it.

export interface PruneResult {
  key: string;
  ok: boolean;
  /** Present when it wasn't done: why git kept it, in words. */
  why?: string;
}

/** The three writes a prune can make, injected so the ordering and the
 *  stop-on-refusal rules below are tested rather than clicked. */
export interface PruneOps {
  removeWorktree(path: string, force: 0 | 1 | 2): Promise<unknown>;
  deleteBranch(branch: string): Promise<unknown>;
  deleteRemote(branch: string): Promise<unknown>;
}

/**
 * Prune the chosen rows, one at a time.
 *
 * Sequential on purpose: these are git writes against one repo, and twenty
 * concurrent `worktree remove`s contend on the same index lock and fail in ways
 * that read as "pruning is broken". Slower and legible beats fast and wrong.
 *
 * A refusal stops that row and nothing else. The folder is removed before the
 * branch, so if the folder stays the branch is left alone rather than asked for
 * and refused a second time; and the remote copy is only touched once the local
 * one has actually gone, so a half-failed row never ends with the branch alive
 * here and deleted for everyone else.
 *
 * A locked workspace is never forced. `force` goes to 1 for a row whose
 * uncommitted files the user explicitly ticked — they were told the cost on the
 * row — but a lock means something is still holding the folder open, and
 * overriding twenty of those in a loop is not a decision a bulk action gets to
 * make. Those come back as refusals with the reason.
 */
export async function runPrune(
  items: readonly PruneCandidate[],
  ops: PruneOps,
  remote: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<PruneResult[]> {
  const results: PruneResult[] = [];
  let done = 0;
  for (const c of items) {
    const steps = planFor(c, remote);
    let failed: string | null = null;
    for (const s of steps) {
      try {
        if (s.kind === "worktree")
          await ops.removeWorktree(c.branch.worktree as string, c.branch.dirty > 0 ? 1 : 0);
        else if (s.kind === "branch") await ops.deleteBranch(c.branch.branch);
        else await ops.deleteRemote(c.branch.branch);
      } catch (err) {
        failed = whyRefused(String(err));
        break;
      }
    }
    results.push(failed ? { key: c.key, ok: false, why: failed } : { key: c.key, ok: true });
    onProgress?.(++done, items.length);
  }
  return results;
}

/** What happened, in one line. Refusals are named rather than folded into the
 *  total — a prune that silently skipped half of what was ticked reads as a
 *  prune that worked. */
export function outcomeSummary(results: readonly PruneResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const bad = results.length - ok;
  const head =
    ok === 0
      ? "Nothing was pruned."
      : `Pruned ${plural(ok, "branch", "branches")}.`;
  return bad === 0
    ? head
    : `${head} ${plural(bad, "was", "were")} left alone — each one says why below.`;
}

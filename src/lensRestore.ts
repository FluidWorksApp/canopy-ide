// "Go back to here" without a live Build session: put the project's files
// back the way a saved version had them, as a NEW saved version on top.
//
// History is never rewritten. The restore is three plain git steps run where
// the project lives (receipt_run_check, so a cloud workspace's own checkout):
//
//  1. Anything not yet saved is saved first, as "vibe: Before going back to …",
//     so the restore itself can be undone from the same list.
//  2. `git read-tree -u --reset <sha>` makes the index and the files match the
//     saved version's tree — changed files reverted, later files removed,
//     deleted files back.
//  3. That is committed as "vibe: Back to …".
//
// The preview runs first and lists exactly what will change, from the same
// comparison (`git diff <sha>` reversed).

import * as ipc from "./ipc";
import { CHECKPOINT_SUBJECT_PREFIX } from "./lensCheckpoints";

export interface RestoreDeps {
  run(cwd: string, argv: string[], opts: { timeoutMs?: number; keepBytes?: number; head?: boolean }): Promise<ipc.ReceiptCheckRun>;
}

const defaultDeps: RestoreDeps = {
  run: (cwd, argv, opts) => ipc.receiptRunCheck(cwd, argv, opts),
};

export type RestoreChange = { path: string; status: "restore" | "remove" | "revert" };

export interface RestorePreview {
  sha: string;
  changes: RestoreChange[];
  /** What the restore does, as a patch (current files → the saved version). */
  patch: string;
  truncated: boolean;
  /** There are unsaved changes; they'll be saved as their own version first. */
  unsaved: number;
}

export interface RestoreOutcome {
  /** The new version holding the restored files; null when nothing changed. */
  commit: string | null;
  /** The version that saved unsaved work first, if there was any. */
  savedFirst: string | null;
  changed: number;
}

const SHA = /^[0-9a-f]{7,64}$/i;
const PATCH_KEEP = 192 * 1024;

async function git(
  d: RestoreDeps,
  cwd: string,
  args: string[],
  opts: { keepBytes?: number; allowFail?: boolean } = {},
): Promise<{ ok: boolean; out: string; err: string; truncated: boolean }> {
  const r = await d.run(cwd, ["git", ...args], { timeoutMs: 60_000, head: true, keepBytes: opts.keepBytes ?? 64 * 1024 });
  const ok = r.code === 0;
  if (!ok && !opts.allowFail) {
    throw new Error((r.spawnError || r.stderr || r.stdout || `git ${args[0]} failed`).trim().split("\n").slice(-3).join(" "));
  }
  return { ok, out: r.stdout, err: r.stderr, truncated: r.stdoutTruncated };
}

const STATUS: Record<string, RestoreChange["status"]> = {
  // `git diff <sha>` reads saved version → now; the restore goes the other way.
  A: "remove",
  D: "restore",
  M: "revert",
  T: "revert",
};

/** Parse `git diff --name-status` (saved version → working tree). */
export function parseNameStatus(text: string): RestoreChange[] {
  const out: RestoreChange[] = [];
  for (const line of text.split("\n")) {
    const m = /^([ADMT])\t(.+)$/.exec(line.trimEnd());
    if (m) out.push({ path: m[2], status: STATUS[m[1]] });
  }
  return out;
}

const subject = (title: string) => title.replace(/\s+/g, " ").trim().slice(0, 60) || "a saved version";

/** What going back to `sha` would change. */
export async function previewRestore(root: string, sha: string, deps: RestoreDeps = defaultDeps): Promise<RestorePreview> {
  if (!SHA.test(sha)) throw new Error("That isn't a saved version.");
  const full = (await git(deps, root, ["rev-parse", "--verify", `${sha}^{commit}`])).out.trim();
  const [names, patch, status] = await Promise.all([
    git(deps, root, ["diff", "--name-status", "--no-renames", full]),
    git(deps, root, ["diff", "-R", "--no-color", "--no-ext-diff", "--no-renames", full], { keepBytes: PATCH_KEEP }),
    git(deps, root, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  const changes = parseNameStatus(names.out);
  // Files nobody has saved yet aren't in `git diff`; they are saved first and
  // then removed by the restore, unless the saved version had them too.
  const untracked = status.out
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (untracked.length) {
    const inTarget = new Set(
      (await git(deps, root, ["ls-tree", "-r", "--name-only", full, "--", ...untracked.slice(0, 200)], { allowFail: true })).out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    for (const f of untracked) {
      if (!changes.some((c) => c.path === f)) changes.push({ path: f, status: inTarget.has(f) ? "revert" : "remove" });
    }
  }
  const unsaved = status.out.split("\n").filter((l) => l.trim()).length;
  return { sha: full, changes, patch: patch.out, truncated: patch.truncated, unsaved };
}

/** Go back to `sha`: save unsaved work, restore the tree, commit it. */
export async function restoreVersion(
  root: string,
  sha: string,
  title: string,
  deps: RestoreDeps = defaultDeps,
): Promise<RestoreOutcome> {
  if (!SHA.test(sha)) throw new Error("That isn't a saved version.");
  const full = (await git(deps, root, ["rev-parse", "--verify", `${sha}^{commit}`])).out.trim();
  const status = await git(deps, root, ["status", "--porcelain", "--untracked-files=all"]);
  let savedFirst: string | null = null;
  if (status.out.trim()) {
    await git(deps, root, ["add", "-A"]);
    await git(deps, root, ["commit", "--no-verify", "-q", "-m", `${CHECKPOINT_SUBJECT_PREFIX}Before going back to ${subject(title)}`]);
    savedFirst = (await git(deps, root, ["rev-parse", "HEAD"])).out.trim();
  }
  await git(deps, root, ["read-tree", "-u", "--reset", full]);
  const staged = await git(deps, root, ["diff", "--cached", "--name-only"]);
  const changed = staged.out.split("\n").filter((l) => l.trim()).length;
  if (!changed) return { commit: null, savedFirst, changed: 0 };
  await git(deps, root, ["commit", "--no-verify", "-q", "-m", `${CHECKPOINT_SUBJECT_PREFIX}Back to ${subject(title)}`]);
  const commit = (await git(deps, root, ["rev-parse", "HEAD"])).out.trim();
  return { commit, savedFirst, changed };
}

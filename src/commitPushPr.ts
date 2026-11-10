// Commit what is in a checkout, push its branch, and open a pull request: one
// flow for everything that needs to put work somewhere safe (the PR dialog,
// the agent card, closing an agent with unsaved work). T3 Code's equivalent is
// the `commit_push_pr` stacked action.
//
// Every step is injected so the flow is testable without git, and every failure
// names the step that failed, so a caller can show the error and, above all,
// know that nothing after that step ran. A caller that deletes a worktree must
// treat any thrown error as "do not delete".
import { generatePrDraft } from "./prGenerate";

export type FlowStep = "stage" | "commit" | "push" | "pr";

export class CommitPushPrError extends Error {
  step: FlowStep;
  constructor(step: FlowStep, cause: unknown) {
    super(String((cause as { message?: string })?.message ?? cause).replace(/^Error: /, ""));
    this.step = step;
  }
}

export interface FlowDeps {
  status: (repo: string) => Promise<{ entries: { status: string; path: string }[]; branch: string | null }>;
  stage: (repo: string, paths: string[]) => Promise<void>;
  commit: (repo: string, message: string) => Promise<string>;
  push: (repo: string, setUpstream: boolean) => Promise<string>;
  prContext: (repo: string, base: string) => Promise<{
    branch: string;
    base: string;
    commits: string[];
    files: string[];
    stat: string;
    template: string | null;
  }>;
  createPr: (repo: string, base: string, head: string, title: string, body: string, draft: boolean) => Promise<string>;
  /** The commit message with session trailers, or the message unchanged. */
  withTrailers?: (repo: string, message: string) => Promise<string>;
}

export interface FlowOptions {
  repo: string;
  /** Allow committing straight onto main/master/develop. Off by default: an
   *  agent's work belongs on its own branch, and this flow pushes what is
   *  checked out. */
  allowDefaultBranch?: boolean;
  /** Commit message. Required when there are uncommitted changes to commit. */
  message?: string;
  /** Commit uncommitted changes first (default true). False: push and open the PR only. */
  commit?: boolean;
  /** Open a pull request after the push (default true). */
  openPr?: boolean;
  draft?: boolean;
  /** Overrides for the PR text; otherwise drafted from the branch. */
  title?: string;
  body?: string;
  base?: string;
}

export interface FlowResult {
  committed: boolean;
  pushed: boolean;
  /** The PR's URL; null when none was asked for, or one already existed. */
  prUrl: string | null;
  /** A pull request for this branch already existed. */
  prExisted: boolean;
  /** Changed files left out of the commit because they look like secrets. */
  skipped: string[];
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/i;

/** A path that looks like a credential. Left out of an automatic commit and
 *  reported, never silently committed (and pushed) with the rest. */
export function looksSecret(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const lower = name.toLowerCase();
  if (lower === ".env" || (lower.startsWith(".env.") && !ENV_TEMPLATE.test(lower))) return true;
  return (
    /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)/.test(lower) ||
    /\.(pem|key|p12|pfx|kdbx)$/.test(lower) ||
    lower === ".npmrc" ||
    lower === ".netrc" ||
    lower === ".git-credentials" ||
    /^credentials(\.|$)/.test(lower) ||
    lower === "secrets.json" ||
    lower === "serviceaccount.json"
  );
}

/** `git status --porcelain` codes for an unmerged path. */
const conflicted = (status: string) => /U/.test(status) || status === "AA" || status === "DD";

const step = async <T>(name: FlowStep, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw new CommitPushPrError(name, error);
  }
};

export async function commitPushPr(deps: FlowDeps, opts: FlowOptions): Promise<FlowResult> {
  let committed = false;
  let skipped: string[] = [];
  if (opts.commit !== false) {
    const status = await step("stage", () => deps.status(opts.repo));
    if (!status.branch) {
      throw new CommitPushPrError("stage", "This checkout is on a detached HEAD, so there is no branch to push.");
    }
    if (!opts.allowDefaultBranch && DEFAULT_BRANCHES.has(status.branch)) {
      throw new CommitPushPrError("stage", `This is ${status.branch}. Work belongs on its own branch before it is committed and pushed.`);
    }
    const unmerged = status.entries.filter((e) => conflicted(e.status));
    if (unmerged.length > 0) {
      // Staging an unmerged file would mark it resolved with its conflict markers in it.
      throw new CommitPushPrError("stage", `Resolve the merge conflicts first: ${unmerged.map((e) => e.path).join(", ")}`);
    }
    skipped = [...new Set(status.entries.map((e) => e.path).filter(looksSecret))];
    const paths = [...new Set(status.entries.map((e) => e.path))].filter((p) => !looksSecret(p));
    if (paths.length > 0) {
      const message = opts.message?.trim();
      if (!message) throw new CommitPushPrError("commit", "A commit message is needed to commit these changes.");
      await step("stage", () => deps.stage(opts.repo, paths));
      const full = deps.withTrailers ? await deps.withTrailers(opts.repo, message).catch(() => message) : message;
      await step("commit", () => deps.commit(opts.repo, full));
      committed = true;
    }
  }
  // Idempotent when already pushed; sets the upstream when it is missing.
  await step("push", () => deps.push(opts.repo, true));
  if (opts.openPr === false) return { committed, pushed: true, prUrl: null, prExisted: false, skipped };
  try {
    const ctx = await deps.prContext(opts.repo, opts.base ?? "");
    const draft = generatePrDraft({
      branch: ctx.branch,
      commits: ctx.commits,
      files: ctx.files,
      stat: ctx.stat,
      template: ctx.template,
    });
    const url = await deps.createPr(
      opts.repo,
      opts.base ?? ctx.base,
      ctx.branch,
      opts.title ?? draft.title,
      opts.body ?? draft.body,
      opts.draft ?? false,
    );
    return { committed, pushed: true, prUrl: url, prExisted: false, skipped };
  } catch (error) {
    // The work is already safe on the remote; a PR that exists is not a failure.
    const text = String((error as { message?: string })?.message ?? error);
    if (/pull request .*already exists|already exists.*pull request/i.test(text)) {
      // gh names the existing PR in its message.
      const url = text.match(/https:\/\/[^\s"')]+\/pull\/\d+/)?.[0] ?? null;
      return { committed, pushed: true, prUrl: url, prExisted: true, skipped };
    }
    throw new CommitPushPrError("pr", error);
  }
}

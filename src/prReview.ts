// Derivations over a PR's conversation: which comments actually need answering,
// where each thread belongs in the diff, what the one obvious next move is, and
// how to read a suggested change out of a comment body. All pure — the tab
// renders these, the loop (prLoop.ts) acts on them, and both are testable
// without a GitHub round trip.
import type * as ipc from "./ipc";

/** Whose words an agent may act on. A review comment becomes an instruction to
 *  something with push access, so anonymous drive-by comments are read by the
 *  human and nobody else: this is the prompt-injection boundary, not a nicety.
 *  (The briefs also frame every comment as a claim to verify, never a command.) */
export const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export const isTrusted = (association: string): boolean =>
  TRUSTED_ASSOCIATIONS.includes(association);

/** Threads indexed by file, so a file card can find its own comments without
 *  scanning every thread on every render. Sorted by line for stable order. */
export function threadsByPath(threads: ipc.PrThread[]): Map<string, ipc.PrThread[]> {
  const map = new Map<string, ipc.PrThread[]>();
  for (const t of threads) {
    const list = map.get(t.path);
    if (list) list.push(t);
    else map.set(t.path, [t]);
  }
  for (const list of map.values()) list.sort((a, b) => a.line - b.line);
  return map;
}

/** A thread nobody has dealt with yet. Outdated still counts: the code moved,
 *  but the point may stand — that's a judgement, not a state. */
export const isThreadLive = (t: ipc.PrThread): boolean => !t.resolved;

/** Did anyone but me say something in this thread? A thread of only my own
 *  replies is my own voice coming back at me. */
export const hasOthersVoice = (t: ipc.PrThread): boolean =>
  t.comments.some((c) => !c.mine && isTrusted(c.association));

export interface Actionable {
  /** Unresolved threads with someone else's words in them. */
  threads: ipc.PrThread[];
  /** Conversation comments from other people. */
  comments: ipc.PrComment[];
  /** Reviews that asked for changes and haven't been superseded. */
  changesRequested: ipc.PrReviewSummary[];
  /** What the badge and the task label count. */
  count: number;
  /** Stable ids of everything counted — the loop's dedup key set. */
  ids: string[];
}

/** What is actually waiting on the author. This is the number the "Address
 *  comments" task is gated on: without it the task will happily spin up a
 *  worktree, a checkout and an agent for a PR with nothing to address. */
export function actionable(conv: ipc.PrConversation): Actionable {
  const threads = conv.threads.filter((t) => isThreadLive(t) && hasOthersVoice(t));
  const comments = conv.comments.filter((c) => !c.mine && isTrusted(c.association));
  const changesRequested = conv.reviews.filter(
    (r) => r.state === "CHANGES_REQUESTED" && !r.mine && isTrusted(r.association),
  );
  const ids = [
    ...threads.map((t) => t.id),
    ...comments.map((c) => c.id),
    ...changesRequested.map((r) => r.id),
  ];
  return {
    threads,
    comments,
    changesRequested,
    count: threads.length + comments.length + changesRequested.length,
    ids,
  };
}

/** Nits are optional by convention (and by the review brief). Splitting them out
 *  is what stops a wall of style notes reading as blocking work. */
export const isNit = (body: string): boolean => /^\s*(nit|nitpick)\b\s*:?/i.test(body);

/** The ```suggestion fences in a comment body, in order. GitHub's own "Commit
 *  suggestion" button has no API — but the replacement text is right here in the
 *  body, and we have the checkout, so applying one locally is a parse away. */
export function parseSuggestions(body: string): string[] {
  const out: string[] = [];
  const re = /```+\s*suggestion[^\n]*\n([\s\S]*?)```+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1].replace(/\n$/, ""));
  return out;
}

/** Does this thread carry a suggested change we could apply? */
export const threadSuggestion = (t: ipc.PrThread): string | null => {
  for (const c of t.comments) {
    const s = parseSuggestions(c.body);
    if (s.length) return s[0];
  }
  return null;
};

export type Role = "author" | "reviewer";

export const roleFor = (pr: ipc.PrInfo, conv?: ipc.PrConversation | null): Role =>
  !conv || !conv.viewer ? (pr.mine ? "author" : "reviewer") : conv.viewer === pr.author ? "author" : "reviewer";

/** Every next-move the bar can name. The id is what the button dispatches. */
export type MoveId =
  | "none"
  | "landed"
  | "self-review"
  | "mark-ready"
  | "fix-ci"
  | "update-branch"
  | "resolve-conflicts"
  | "address-comments"
  | "review-it"
  | "request-review"
  | "merge"
  | "waiting";

export interface NextMove {
  id: MoveId;
  /** The sentence in the bar: what needs to happen. */
  label: string;
  /** The button, when there is something to press. */
  action?: string;
  /** Why this and not something else — a tooltip, kept short. */
  hint?: string;
  /** Blocking (accent) vs merely informative. */
  urgent?: boolean;
}

/** The single most useful thing to do to this PR right now.
 *
 *  Order matters more than the list: a broken build outranks unanswered
 *  comments (you'd be fixing review notes on a red branch), conflicts outrank
 *  both (nothing can land), and "ready to merge" only ever appears when GitHub
 *  itself says the PR is approved and green. */
export function nextMove(
  pr: ipc.PrInfo,
  conv: ipc.PrConversation | null,
  opts: { actionable: number; loopBusy?: boolean; autoMerge?: boolean } = { actionable: 0 },
): NextMove {
  if (pr.state !== "OPEN")
    return { id: "landed", label: pr.state === "MERGED" ? "Merged" : "Closed" };
  const role = roleFor(pr, conv);
  const checks = conv?.checks || pr.checks;
  const conflicting = (conv?.mergeable || pr.mergeable) === "CONFLICTING";
  const decision = conv?.review_decision || pr.review_decision;
  const draft = conv?.draft ?? pr.draft;

  if (opts.loopBusy)
    return { id: "none", label: "An agent is working on this round", hint: "watch it in the rounds panel" };

  if (draft && role === "author")
    return {
      id: "self-review",
      label: "Draft — review it yourself before anyone else does",
      action: "Self-review",
      hint: "findings stay local; nothing is posted",
    };

  if (conflicting)
    return {
      id: "update-branch",
      label: "Conflicts with its base",
      action: "Update branch",
      hint: "try GitHub's own merge first; if it can't, hand it to an agent",
      urgent: true,
    };

  if (checks === "FAIL")
    return {
      id: "fix-ci",
      label: "Checks are failing",
      action: "Fix CI",
      hint: "an agent reads the failing logs and fixes the cause",
      urgent: true,
    };

  if (role === "author" && opts.actionable > 0)
    return {
      id: "address-comments",
      label: `${opts.actionable} ${opts.actionable === 1 ? "comment" : "comments"} to address`,
      action: "Start round",
      hint: "validates each comment before changing anything",
      urgent: true,
    };

  if (role === "reviewer" && !conv?.my_last_review_sha)
    return {
      id: "review-it",
      label: "Waiting on your review",
      action: "Review it",
      urgent: true,
    };

  if (role === "reviewer" && conv && conv.my_last_review_sha !== conv.head_sha)
    return {
      id: "review-it",
      label: "New commits since your review",
      action: "Review the delta",
    };

  if (decision === "APPROVED" && checks !== "FAIL" && !conflicting)
    return {
      id: "merge",
      label: opts.autoMerge ? "Approved and green — auto-merge is armed" : "Approved and green — ready to land",
      action: opts.autoMerge ? undefined : "Merge",
    };

  if (role === "author" && (decision === "" || decision === "REVIEW_REQUIRED"))
    return { id: "request-review", label: "Nobody is reviewing it yet", action: "Ask for review" };

  return { id: "waiting", label: role === "author" ? "Waiting on review" : "Nothing needs you" };
}

/** Reviews worth showing at the top of the rail, newest first: a verdict with
 *  something in it, or any verdict that isn't a bare comment. */
export function verdicts(conv: ipc.PrConversation): ipc.PrReviewSummary[] {
  return conv.reviews
    .filter((r) => r.state !== "PENDING" && (r.body.trim() !== "" || r.state !== "COMMENTED"))
    .sort((a, b) => (a.submitted < b.submitted ? 1 : -1));
}

/** The reason a file has no hunks, when a reassembled patch carries one.
 *
 *  A patch stitched from `pulls/{n}/files` (git.rs `assemble_patch`, used when
 *  GitHub refuses a 20k-line combined diff) marks files it couldn't inline the
 *  same way git marks a binary — so without this they would all read "Binary
 *  file", which is a lie about a 4,000-line lockfile. */
export function fileNote(patch: string): string | null {
  const m = /^\((GitHub didn't include|\d+ more file)[^\n]*\)$/m.exec(patch);
  return m ? m[0].slice(1, -1) : null;
}

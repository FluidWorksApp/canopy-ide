// Micro-tasks: one-shot jobs an agent does from a single CTA — "Raise PR" on a
// branch — then reports done via the canopy_job_done MCP tool and disappears
// (tab closed, session forgotten). Each definition builds the agent's opening
// brief from the surface it was clicked on plus whatever the user typed; the
// launcher appends the shared completion protocol. Kin to the context builders
// in prs.ts / trackers.ts, but registered so any surface can host a CTA.
import type * as ipc from "./ipc";
import { cleanupLine } from "./prs";

/** A task that edits files can't run in the shared checkout — other agents live
 *  there, and switching its branch under them is how you lose an afternoon. A
 *  task declaring this gets a worktree with the PR's branch instead: the one
 *  that already holds it, or a throwaway the launcher creates and the agent
 *  removes at the end (which is what `cleanup` in MicroTaskEnv announces). */
export interface PrWorktreeIsolation<P> {
  kind: "pr-worktree";
  /** Which PR to check out — the payload always carries it, but only the task
   *  knows where, so it names it rather than the launcher guessing. */
  target(payload: P): { repo: string; pr: ipc.PrInfo };
}

/** What the launcher resolved before seeding the agent. Today just the
 *  throwaway worktree it made, which the brief has to tell the agent to tear
 *  down; absent when the run needed no isolation or reused a real worktree. */
export interface MicroTaskEnv {
  cleanup?: { repo: string; worktree: string };
}

export interface MicroTaskDef<P> {
  id: string;
  /** CTA label — also the tab title ("Raise PR · Claude Code"). */
  label: string;
  icon: string;
  /** Hint for the optional user-context input in the CTA popover. */
  placeholder: string;
  /** Where the agent runs — unless `isolation` overrides it with a worktree,
   *  in which case this is only the fallback the launcher never reaches. */
  cwd(payload: P): string;
  /** The job brief — a single line (PTY prompt contract, see preview.ts). The
   *  completion protocol is appended by the launcher, not here. */
  buildContext(payload: P, userQuery: string, env?: MicroTaskEnv): string;
  /** For the Tasks panel's built-in list: where this task's button lives.
   *  Built-ins run from their surface, which is what supplies the payload. */
  surfaceNote?: string;
  /** One line: what this actually does. Four of these are called some variant
   *  of "review" and a label alone cannot tell them apart. */
  blurb?: string;
  /** What it does to the world — the question a list of names hides, and the
   *  one worth grouping by: `reads` leaves no trace, `posts` writes something
   *  public under your name, `pushes` changes code on the branch. */
  effect?: TaskEffect;
  /** Set by tasks that mutate files; the launcher prepares the checkout. */
  isolation?: PrWorktreeIsolation<P>;
}

export type TaskEffect = "reads" | "posts" | "pushes";

/** Headings for the three, phrased as consequences rather than categories. */
export const EFFECT_HEADING: Record<TaskEffect, string> = {
  reads: "Reads only — nothing is posted",
  posts: "Posts to GitHub under your name",
  pushes: "Changes code and pushes",
};

/** PTY prompts must be one line — a newline submits early. Same contract every
 *  context builder honors; this makes it structural for micro-task briefs. */
export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The completion contract appended to every micro-task brief: do the one job,
 *  call canopy_job_done, stop. The print fallback covers CLIs without the MCP
 *  bridge (only claude registers it today) so the ending is still legible. */
export function microTaskProtocol(): string {
  return (
    `This is a one-shot micro-task: do exactly this job and nothing else — no follow-up work, ` +
    `no servers, no unrelated fixes. When finished, call the \`canopy_job_done\` tool with ` +
    `status "done", a one-sentence summary, and the url if the job produced one. If you cannot ` +
    `finish, call it with status "blocked" and say what you need. If the canopy_job_done tool ` +
    `is not available, print \`JOB DONE: <summary>\` as your final line instead. After Canopy ` +
    `acknowledges, stop — one closing sentence at most; Canopy will close this terminal.`
  );
}

/** Kept lean on purpose: the Git panel's branch rows only know a branch by
 *  name, while a branch tab has the full BranchWork — both can launch this.
 *  `unpushed` undefined = the launcher didn't know; the agent checks. */
export interface RaisePrPayload {
  repo: string;
  branch: string;
  worktree?: string | null;
  unpushed?: boolean;
}

/** Raise the PR the repo's own conventions ask for: read the change, find the
 *  template (repo-level, or a nearer one for the area being touched), fill every
 *  section from evidence, and open it via --body-file so the template's headings
 *  survive the trip. Never commits — the branch ships as it is. */
export const raisePrTask: MicroTaskDef<RaisePrPayload> = {
  id: "raise-pr",
  label: "Raise PR",
  icon: "⇈",
  placeholder: "Anything the PR should mention…",
  blurb: "Opens the PR, filling in whatever template the repo asks for.",
  effect: "posts",
  surfaceNote: "on a branch tab",
  cwd: (p) => p.worktree ?? p.repo,
  buildContext(p, userQuery) {
    const push =
      p.unpushed === false
        ? ""
        : p.unpushed
          ? `Push it first (\`git push -u origin ${p.branch}\`). `
          : `If it has no upstream or unpushed commits, push it first (\`git push -u origin ${p.branch}\`). `;
    const query = oneLine(userQuery);
    return oneLine(
      `Open a pull request for the branch ${p.branch}. ` +
        push +
        `Work in this order. (1) Understand the change: read \`git log\` for the branch and the ` +
        `full diff against the base branch — the code itself, not just the commit messages, which ` +
        `are a claim about the change and not the change. (2) Find the template before writing any ` +
        `prose: look for \`.github/pull_request_template.md\`, \`.github/PULL_REQUEST_TEMPLATE.md\`, ` +
        `\`.github/PULL_REQUEST_TEMPLATE/\` (spellings and case vary), \`docs/\`, and the repo root; ` +
        `then look for anything more specific to the area this branch touches — a template or ` +
        `CONTRIBUTING/AGENTS/CLAUDE notes in the package, app, or subdirectory the diff lives in — ` +
        `and prefer the nearest one. (3) Fill it: use the template verbatim as the body's skeleton, ` +
        `keeping every heading and its order, and answer each section from what the diff actually ` +
        `shows. Keep a heading you can't answer and write "N/A — <one-line reason>" under it rather ` +
        `than deleting it. Only tick a checklist box for something you have verified yourself, and ` +
        `never invent tests, screenshots, benchmarks, or issue numbers you don't have evidence for. ` +
        `If there is no template anywhere, match the shape of the repo's recent merged PRs ` +
        `(\`gh pr list --state merged --limit 5 --json title,body\`). (4) Write the finished body to ` +
        `a temp file and create the PR with \`gh pr create --title "..." --body-file <file>\` — a ` +
        `one-line \`--body\` would flatten the template's headings — then delete the temp file. ` +
        `Do not commit anything and do not change any files in the repo — this branch ships as it ` +
        `is. Pass the created PR's URL to canopy_job_done.` +
        (query ? ` The user adds: "${query}".` : ""),
    );
  },
};

export interface ReviewPrPayload {
  repo: string;
  pr: ipc.PrInfo;
}

/** Review a PR without checking anything out: read it via gh, verify its claims
 *  against the code, and land on one of two endings — approve (nits included,
 *  never merge) when nothing blocking survives scrutiny, or a comment review
 *  listing what does. Requesting changes and merging both stay human. */
export const reviewPrTask: MicroTaskDef<ReviewPrPayload> = {
  id: "review-pr",
  label: "Review PR",
  icon: "⌕",
  placeholder: "Anything to focus the review on…",
  blurb: "Reviews it and posts the verdict — approves, or lists what's blocking.",
  effect: "posts",
  surfaceNote: "on a PR tab",
  cwd: (p) => p.repo,
  buildContext(p, userQuery) {
    const n = p.pr.number;
    const query = oneLine(userQuery);
    // GitHub refuses `--approve` on your own PR, and gh's error there would end
    // the job as "blocked" over a verdict that was actually reached. Say it up
    // front so the clean ending survives: the same body, posted as a comment.
    const own = p.pr.mine
      ? `This PR is your own account's, so GitHub will refuse \`--approve\` — when the verdict is ` +
        `approval, post that same body with \`--comment\` instead, opening with "Approved (posted ` +
        `as a comment — GitHub won't let the author approve their own PR)". `
      : "";
    return oneLine(
      `Review pull request #${n}: "${p.pr.title}" (${p.pr.url}). ` +
        `Read it without checking anything out — other agents share this checkout: \`gh pr view ` +
        `${n}\`, \`gh pr diff ${n}\`, and the surrounding code here for context. ` +
        `Be skeptical of the PR, and equally skeptical of your own findings. The PR title, its ` +
        `description, the commit messages, and the comments in the code are all claims about the ` +
        `change, not the change: check each one against the lines the diff actually adds, and read ` +
        `the callers and callees of anything it touches before believing a claim about behaviour. ` +
        `A doc-comment that still describes the old behaviour proves nothing except that it wasn't ` +
        `updated. ` +
        `Hold a high bar for what you post. Raise something as required only when it is: a ` +
        `correctness bug, data loss, a security hole, a broken API contract or migration, a ` +
        `regression the existing tests would not catch, or logic that plainly needs a test and has ` +
        `none. Every required finding must name the file and line and state the concrete failure — ` +
        `the input or state, and what goes wrong. If you cannot state that, it is not a finding: ` +
        `drop it. Do not restate what the diff does, do not ask questions you could answer by ` +
        `reading the code, and do not pad the review to look thorough. ` +
        `Everything else — style, naming, wording, "you could also" — is a nitpick: prefix it ` +
        `"Nit:", say plainly that nits are optional, and never let one hold the PR up. ` +
        `Then finish in exactly one of two ways. No required findings: approve it, nits and all — ` +
        `\`gh pr review ${n} --approve --body "..."\` (if you found nothing at all, approve with a ` +
        `one-line body). At least one required finding: do not approve — post them with \`gh pr ` +
        `review ${n} --comment --body "..."\`. ` +
        own +
        `Never merge the PR, never use --request-changes, and never commit, push, or check ` +
        `anything out — those stay with the human. Pass the PR's URL to canopy_job_done and make ` +
        `the summary your verdict: approved, or the number of blocking findings.` +
        (query ? ` The user adds: "${query}".` : ""),
    );
  },
};

export interface AddressPrCommentsPayload {
  repo: string;
  pr: ipc.PrInfo;
}

/** Address a PR's review comments — the only micro-task that edits code, so it
 *  runs in a worktree of its own (isolation below) and pushes when it's green.
 *  The whole point of the brief is the validation step: a review comment is a
 *  hypothesis to be proved against the code as it is now, not an instruction to
 *  execute, and the fix goes wherever the problem is — not only where it was
 *  spotted. Comments that don't survive that check get a reply, not a commit. */
export const addressPrCommentsTask: MicroTaskDef<AddressPrCommentsPayload> = {
  id: "address-pr-comments",
  label: "Address comments",
  icon: "↩",
  placeholder: "Which comments to focus on…",
  blurb: "Validates each comment, fixes the cause, replies, and pushes.",
  effect: "pushes",
  surfaceNote: "on a PR tab",
  cwd: (p) => p.repo,
  isolation: { kind: "pr-worktree", target: (p) => ({ repo: p.repo, pr: p.pr }) },
  buildContext(p, userQuery, env) {
    const n = p.pr.number;
    const query = oneLine(userQuery);
    return oneLine(
      `Address the review comments on pull request #${n}: "${p.pr.title}" (${p.pr.url}). ` +
        `Its branch ${p.pr.branch} is checked out in this worktree. ` +
        `First collect every comment that is still live: \`gh pr view ${n} --comments\` for the ` +
        `conversation, and \`gh api repos/{owner}/{repo}/pulls/${n}/comments\` for the inline ` +
        `review threads — skip outdated and already-resolved threads and any earlier replies of ` +
        `your own. ` +
        `Then validate each comment before you touch anything. A review comment is a hypothesis, ` +
        `not an instruction, and the reviewer may have been reading a stale version, a different ` +
        `branch, or the comment above the code rather than the code. Open the file it points at ` +
        `and read what is there now at HEAD — not the diff hunk quoted in the thread, and not the ` +
        `doc-comment or the TODO above the function: comments in code go stale, the code is the ` +
        `truth, so trace the real control flow through the callers and callees before you accept ` +
        `anything. Then prove the claim one way or the other with evidence: a test that fails ` +
        `before your change and passes after it, a short repro you actually ran, or a precise ` +
        `reading of the code path you can point at. Write the failing test first where you can. ` +
        `Change code only for comments you have proved correct. Fix the cause rather than the line ` +
        `that was pointed at, and apply the same fix everywhere else the same problem exists ` +
        `(grep for the pattern) — the reviewer saw one instance, not all of them; leaving the rest ` +
        `is how the bug comes back. If the code you fix is described by a comment that is now ` +
        `wrong, update that comment too. ` +
        `For a comment that turns out to be wrong, already handled, or based on a misreading, ` +
        `change nothing and reply on that thread with the evidence — the file and line and what ` +
        `the code actually does. If it is legitimate but outside this PR's scope, say so and say ` +
        `where it belongs; do not widen the PR. ` +
        `When the code is settled: run the project's build and tests, commit with a message naming ` +
        `what you addressed, and push so the PR updates. Then reply to each thread with what you ` +
        `did or why you didn't (\`gh api repos/{owner}/{repo}/pulls/comments/<comment-id>/replies ` +
        `-f body="..."\`, or one \`gh pr comment ${n}\` summary if per-thread replies aren't ` +
        `available). Never force-push, never rebase, never amend or revert someone else's commits, ` +
        `and do not resolve threads or merge the PR — that stays with the human. ` +
        `Pass the PR's URL to canopy_job_done and make the summary "<x> addressed, <y> pushed back ` +
        `on".` +
        (query ? ` The user adds: "${query}".` : "") +
        (env?.cleanup ? cleanupLine(env.cleanup.repo, env.cleanup.worktree) : ""),
    );
  },
};

// ---------- PR tasks whose output the tab reads back ----------
//
// A micro-task's terminal closes itself, so anything it produces for the page
// has to be written down. These write one file under `.canopy/` in the repo —
// inside the workspace, because fs_read_file only reads registered roots — and
// the brief keeps it out of git via .git/info/exclude rather than touching the
// repo's own .gitignore.

const ARTIFACT_EXT = { map: "md", findings: "json", progress: "txt" } as const;

/** Where a PR task leaves something for the tab to render. */
export type PrArtifact = keyof typeof ARTIFACT_EXT;

export const prArtifactPath = (
  repo: string,
  number: number,
  kind: PrArtifact = "map",
): string => `${repo}/.canopy/pr-${number}-${kind}.${ARTIFACT_EXT[kind]}`;

/** The Review task's milestones, in order.
 *
 *  A one-shot agent is a black box for however long it runs, and "an agent is on
 *  it" is not progress — it says nothing at minute four that it didn't say at
 *  second one. So the task reports: it appends a step's `id` to the progress
 *  file as it finishes it, and the tab lights the milestone up. `owner: "app"`
 *  marks the step the tab completes itself, after the agent's terminal is gone.
 *
 *  Two labels each, because a step reads differently depending on where it is:
 *  the middle one is happening now, the ones behind it already happened. */
export interface TaskStep {
  id: string;
  /** While it's the one in flight. */
  doing: string;
  /** Once it's behind you — a rail still reading "Reading the change" three
   *  steps later reads as stuck. */
  done: string;
  /** "app" = the tab finishes this one, so the agent is never asked to. */
  owner?: "app";
}

export const PR_REVIEW_STEPS: readonly TaskStep[] = [
  { id: "read", doing: "Reading the change", done: "Read the change" },
  { id: "map", doing: "Mapping the risk", done: "Mapped the risk" },
  { id: "findings", doing: "Finding problems", done: "Found the problems" },
  { id: "staged", doing: "Staging drafts", done: "Staged as drafts", owner: "app" },
];

/** Which milestones are finished, given what the agent has reported.
 *
 *  A high-water mark, not a set: these are stages of one pass, so reaching the
 *  third means the first two happened whether or not the agent remembered to
 *  say so. Reading it as a set produced rails with a later step ticked and
 *  earlier ones blank — which describes nothing that can actually occur, and
 *  read as a bug in the task rather than a missed line in a file.
 *
 *  Order comes from `steps`, so a line written twice, out of sequence, or
 *  misspelled can't skew it; unknown lines are ignored rather than guessed at. */
export function stepsDone(progress: string, steps: readonly TaskStep[]): string[] {
  const seen = new Set(
    progress
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
  let furthest = -1;
  steps.forEach((s, i) => {
    if (seen.has(s.id)) furthest = i;
  });
  return steps.slice(0, furthest + 1).map((s) => s.id);
}

/** The lines that make an agent report its milestones. Written as shell appends
 *  rather than a tool call so every CLI can do it, with or without the MCP
 *  bridge — and truncating first is what stops a re-run showing the previous
 *  run's progress as already complete. */
const progressProtocol = (path: string, steps: readonly TaskStep[]): string => {
  const agentSteps = steps.filter((s) => s.owner !== "app");
  return (
    `Report your progress as you go — the user is watching a progress rail on the PR tab and it moves ` +
    `only when you say so. Before anything else, start it empty: \`mkdir -p\` the directory and run ` +
    `\`: > ${path}\`. Then, the moment you finish each of these, append its name on its own line ` +
    `(\`printf '<name>\\n' >> ${path}\`), in this order: ` +
    agentSteps.map((s) => `\`${s.id}\` once you have ${s.done.toLowerCase()}`).join(", ") +
    `. Append one line each and never rewrite the file. Do this even for a step that turned up ` +
    `nothing — a milestone that is skipped silently reads as a task that hung. `
  );
};

/** One line the briefs share: make the directory, keep it out of git. */
const artifactPreamble = (path: string): string =>
  `Write your output to \`${path}\` (\`mkdir -p\` its directory first, and make sure \`.canopy/\` is ` +
  `in \`.git/info/exclude\` — append it if missing — so this never shows up as a repo change). `;

/** The whole read-only review, in one pass. This used to be three tasks — map
 *  the change, draft findings, self-review — which asked the user to choose
 *  between three phrasings of one job before the agent had read a line. They
 *  share all the expensive work (reading the diff and the code around it), so
 *  they are one brief with two outputs: the map the tab renders, and the
 *  findings JSON the tab stages as draft comments. Posts nothing: whether any
 *  of it reaches GitHub stays a human click on the review composer. */
export const prReviewTask: MicroTaskDef<ReviewPrPayload> = {
  id: "pr-review",
  label: "Review",
  icon: "◎",
  placeholder: "Anything to focus on…",
  blurb: "Reads it, maps the risk, and stages findings for you to vet.",
  effect: "reads",
  surfaceNote: "on a PR tab",
  cwd: (p) => p.repo,
  buildContext(p, userQuery) {
    const n = p.pr.number;
    const query = oneLine(userQuery);
    // Same bar either way; the author's lens catches a different tail (debug
    // leftovers, a stale doc, a description the diff outgrew) and it costs one
    // clause to ask for it on the PRs where it applies.
    const lens = p.pr.mine
      ? `This is the user's own PR, so review it the way they would want it reviewed before anyone ` +
        `else sees it: also flag debug leftovers, a TODO that should be a ticket, a comment or doc ` +
        `still describing the old behaviour, and anything in the description the diff outgrew. `
      : "";
    return oneLine(
      `Review pull request #${n}: "${p.pr.title}" (${p.pr.url}) for a human who is about to read it. ` +
        `Nothing you produce goes to GitHub — post no comments and no review, and change no code. ` +
        `Read it without checking anything out — other agents share this checkout: \`gh pr view ${n}\`, ` +
        `\`gh pr diff ${n}\`, and the surrounding code here for context. ` +
        `Be skeptical of the PR and equally skeptical of yourself. The title, the description, the ` +
        `commit messages and the comments in the code are all claims about the change, not the change: ` +
        `check each against the lines the diff actually adds, and read the callers and callees of ` +
        `anything it touches before believing a claim about behaviour. A doc-comment that still ` +
        `describes the old behaviour proves nothing except that it wasn't updated. ` +
        lens +
        progressProtocol(prArtifactPath(p.repo, n, "progress"), PR_REVIEW_STEPS) +
        `Write two more files, and nothing else. ` +
        `(1) The map. ` +
        artifactPreamble(prArtifactPath(p.repo, n, "map")) +
        `Structure it exactly like this, in GitHub-flavoured markdown, under 250 words. ` +
        `"## What it does" — two or three sentences describing the change as it is in the diff, not as ` +
        `the description claims. "## Risk" — the changed files that carry real risk, each with one ` +
        `clause saying why (a behaviour change, a shared signature, a migration, an unguarded path); ` +
        `leave out the files that are noise. "## Look at" — at most three specific things worth a ` +
        `human's attention, each naming a file and line. "## Claims to check" — any statement in the ` +
        `description or a commit message the diff does not obviously support. ` +
        `(2) The findings, as inline review comments the human will vet before any of it is posted. ` +
        artifactPreamble(prArtifactPath(p.repo, n, "findings")) +
        `That file must be exactly this JSON and nothing else: ` +
        `{"findings":[{"path":"src/x.ts","line":42,"side":"RIGHT","severity":"blocking","body":"…"}]} ` +
        `— \`line\` is a line number in the NEW file for side "RIGHT" (use "LEFT" and the old line only ` +
        `when the problem is a deletion), and \`severity\` is "blocking" or "nit". A finding is ` +
        `"blocking" only if it is a correctness bug, data loss, a security hole, a broken API contract ` +
        `or migration, a regression the tests would not catch, or logic that plainly needs a test and ` +
        `has none — and every one must name the concrete failure: the input or state, and what goes ` +
        `wrong. If you cannot state that, it is not a finding: leave it out. Everything else is "nit" ` +
        `and its body must start with "Nit: ". Aim for few and certain rather than many: five findings ` +
        `is a lot, and an empty array is a perfectly good answer. ` +
        `Make the canopy_job_done summary the one-line version of "What it does", then ` +
        `"<b> blocking, <n> nits".` +
        (query ? ` The user adds: "${query}".` : ""),
    );
  },
};

/** Green-keeper: the failing checks, read and fixed. Edits code, so it runs in
 *  the PR's own worktree like addressing comments does. */
export const fixCiTask: MicroTaskDef<ReviewPrPayload> = {
  id: "pr-fix-ci",
  label: "Fix CI",
  icon: "⚒",
  placeholder: "Which check to start with…",
  blurb: "Reads the failing logs, fixes the cause, pushes when it's green.",
  effect: "pushes",
  surfaceNote: "on a PR tab",
  cwd: (p) => p.repo,
  isolation: { kind: "pr-worktree", target: (p) => ({ repo: p.repo, pr: p.pr }) },
  buildContext(p, userQuery, env) {
    const n = p.pr.number;
    const query = oneLine(userQuery);
    return oneLine(
      `Make the failing checks on pull request #${n}: "${p.pr.title}" (${p.pr.url}) pass. Its branch ` +
        `${p.pr.branch} is checked out in this worktree. ` +
        `Start from the evidence, not a guess: \`gh pr checks ${n}\` for what is red, then ` +
        `\`gh run view <run-id> --log-failed\` for each failing run's actual output. Reproduce the ` +
        `failure locally with the project's own command before changing anything — a check that fails ` +
        `in CI and passes here is telling you something about the environment, and the fix is different. ` +
        `Fix the cause, not the symptom: do not delete, skip, or loosen a test, do not raise a timeout ` +
        `to make a flake pass, and do not silence a type error with a cast or an ignore comment. If the ` +
        `failure is a genuine flake or an infrastructure problem, change nothing, say so, and re-run it ` +
        `(\`gh run rerun --failed\`). When the project's build and tests are green locally, commit with a ` +
        `message naming what broke and push so the checks re-run. Never force-push, never rebase, never ` +
        `amend someone else's commit, and do not merge. Pass the PR's URL to canopy_job_done with a ` +
        `summary of what was broken and what fixed it.` +
        (query ? ` The user adds: "${query}".` : "") +
        (env?.cleanup ? cleanupLine(env.cleanup.repo, env.cleanup.worktree) : ""),
    );
  },
};

export interface ApplySuggestionPayload extends ReviewPrPayload {
  path: string;
  line: number;
  suggestion: string;
  threadId: string;
}

/** Apply a reviewer's suggested change. GitHub's "Commit suggestion" button has
 *  no API — but the replacement text is in the comment body and the branch is
 *  right here, so we apply it, prove it, and push. */
export const applySuggestionTask: MicroTaskDef<ApplySuggestionPayload> = {
  id: "pr-apply-suggestion",
  label: "Apply suggestion",
  icon: "⇥",
  placeholder: "Anything to watch for…",
  blurb: "Applies a reviewer's suggested change, proves it, and pushes.",
  effect: "pushes",
  surfaceNote: "on a PR comment",
  cwd: (p) => p.repo,
  isolation: { kind: "pr-worktree", target: (p) => ({ repo: p.repo, pr: p.pr }) },
  buildContext(p, userQuery, env) {
    const n = p.pr.number;
    const query = oneLine(userQuery);
    return oneLine(
      `A reviewer suggested a change on pull request #${n} (${p.pr.url}) at ${p.path}:${p.line}. Its ` +
        `branch ${p.pr.branch} is checked out in this worktree. The suggested replacement for that ` +
        `line (or line range) is, between the markers: <<<SUGGESTION ${oneLine(p.suggestion)} ` +
        `SUGGESTION>>>. Open ${p.path} and read what is there now — the suggestion was written against ` +
        `the diff and the file may have moved on. Apply it if it still makes sense, adjusting ` +
        `indentation to match the file; if the code has changed enough that it no longer applies, ` +
        `change nothing and say so. Then verify: run the project's build and tests, and if the ` +
        `suggestion touches behaviour, satisfy yourself with a test or a short repro that it is right — ` +
        `a suggestion is a proposal, not an instruction. When green, commit with a message crediting the ` +
        `suggestion and push. Reply on the thread saying it is applied (or why it isn't) with ` +
        `\`gh api repos/{owner}/{repo}/pulls/${n}/comments\` replies, and do not resolve the thread or ` +
        `merge — that stays with the human. Pass the PR's URL to canopy_job_done.` +
        (query ? ` The user adds: "${query}".` : "") +
        (env?.cleanup ? cleanupLine(env.cleanup.repo, env.cleanup.worktree) : ""),
    );
  },
};

/** Run the branch and look at it. The thing no hosted reviewer can do: start the
 *  project, drive the changed screen, and come back with pictures. */
export const runItReviewTask: MicroTaskDef<ReviewPrPayload> = {
  id: "pr-run-it",
  label: "Run it & look",
  icon: "▶",
  placeholder: "Which screen or flow to exercise…",
  blurb: "Starts the app on the PR's branch and reports what it saw.",
  effect: "reads",
  surfaceNote: "on a PR tab",
  cwd: (p) => p.repo,
  isolation: { kind: "pr-worktree", target: (p) => ({ repo: p.repo, pr: p.pr }) },
  buildContext(p, userQuery, env) {
    const n = p.pr.number;
    const query = oneLine(userQuery);
    return oneLine(
      `Exercise pull request #${n}: "${p.pr.title}" (${p.pr.url}) as a user would, and report what you ` +
        `saw. Its branch ${p.pr.branch} is checked out in this worktree — this is the review no hosted ` +
        `tool can do, so spend the effort on running it rather than re-reading the diff. ` +
        `Read \`gh pr diff ${n}\` only far enough to know which screens or endpoints the change touches. ` +
        `Install dependencies if they're missing, then start the project's dev server with ` +
        `canopy_start_server and wait for it with canopy_wait_for. Drive the changed surface with ` +
        `canopy_browser_navigate / canopy_browser_click / canopy_browser_type, and take ` +
        `canopy_screenshot of each state that matters — how it LOOKS is the point, and a DOM snapshot ` +
        `cannot see overlap, contrast or a layout that has collapsed. Check canopy_browser_console for ` +
        `errors and warnings the change introduced. Also run the project's own tests if it has them. ` +
        `Then stop the server with canopy_stop_server. Report only what you observed, with the ` +
        `screenshots you took: what works, what looks wrong, what you could not reach. Post nothing to ` +
        `GitHub and change no code. Make the canopy_job_done summary your verdict in one line.` +
        (query ? ` The user adds: "${query}".` : "") +
        (env?.cleanup ? cleanupLine(env.cleanup.repo, env.cleanup.worktree) : ""),
    );
  },
};

/** The tail nobody gets to: comments that are legitimate but out of scope. They
 *  become issues so the PR can land without swallowing them. */
export const followUpsTask: MicroTaskDef<ReviewPrPayload> = {
  id: "pr-follow-ups",
  label: "Spin off follow-ups",
  icon: "⤴",
  placeholder: "Which ones to spin off…",
  blurb: "Turns out-of-scope comments into issues and links them back.",
  effect: "posts",
  surfaceNote: "on a PR tab",
  cwd: (p) => p.repo,
  buildContext(p, userQuery) {
    const n = p.pr.number;
    const query = oneLine(userQuery);
    return oneLine(
      `Turn the out-of-scope review comments on pull request #${n}: "${p.pr.title}" (${p.pr.url}) into ` +
        `issues so the PR can land without losing them. Collect the conversation with ` +
        `\`gh pr view ${n} --comments\` and the inline threads with ` +
        `\`gh api repos/{owner}/{repo}/pulls/${n}/comments\`; skip resolved and outdated threads. ` +
        `A comment belongs in a follow-up only if it is legitimate AND outside this PR's stated scope — ` +
        `a pre-existing problem the diff merely exposed, a refactor the reviewer wants next, a missing ` +
        `test for code this PR didn't touch. Anything the PR itself should fix is not a follow-up: ` +
        `leave it alone. Check for an existing issue first (\`gh issue list --search\`) and do not open a ` +
        `duplicate. For each one, open an issue with \`gh issue create\` whose body quotes the comment, ` +
        `links back to the thread, and says in one line what "done" would look like; then reply on that ` +
        `thread with the issue link so the reviewer knows where it went. Change no code and do not ` +
        `resolve any thread. Pass the list of issue URLs to canopy_job_done.` +
        (query ? ` The user adds: "${query}".` : ""),
    );
  },
};

/** Every built-in micro-task a CTA can launch. These are surface-bound: their
 *  payload comes from where the button lives (see each task's surfaceNote),
 *  which is why the Tasks panel lists them read-only — run them from there. */
export const MICRO_TASKS: MicroTaskDef<never>[] = [
  raisePrTask as MicroTaskDef<never>,
  reviewPrTask as MicroTaskDef<never>,
  addressPrCommentsTask as MicroTaskDef<never>,
  prReviewTask as MicroTaskDef<never>,
  fixCiTask as MicroTaskDef<never>,
  runItReviewTask as MicroTaskDef<never>,
  followUpsTask as MicroTaskDef<never>,
];

/** A task the user wrote themselves (Tasks panel → New task). Stored in
 *  settings; unlike built-ins it has no surface payload — it runs in a project
 *  directory the user picks at launch, so the brief has to say everything. */
export interface CustomMicroTask {
  id: string;
  label: string;
  icon: string;
  placeholder: string;
  /** The job, in the user's words. May be typed multiline; one-lined at launch. */
  brief: string;
}

/** Adapt a user-written task to the MicroTaskDef the launcher runs. The
 *  payload is just the directory the Tasks panel resolved for it. */
export function customTaskDef(c: CustomMicroTask): MicroTaskDef<{ dir: string }> {
  return {
    id: `custom-${c.id}`,
    label: c.label,
    icon: c.icon || "◆",
    placeholder: c.placeholder || "Anything to add…",
    cwd: (p) => p.dir,
    buildContext: (_p, userQuery) => {
      const query = oneLine(userQuery);
      return oneLine(c.brief) + (query ? ` The user adds: "${query}".` : "");
    },
  };
}

export const ADHOC_TASK_ID = "adhoc";

/** A name for a task nobody named: the head of the brief, cut on a word so the
 *  tab title and the history row still say what the thing was. Saved tasks have
 *  a label because the user typed one; a one-off never gets asked. */
export function adhocLabel(brief: string): string {
  const job = oneLine(brief);
  if (!job) return "One-off task";
  if (job.length <= 32) return job;
  const cut = job.slice(0, 32);
  const space = cut.lastIndexOf(" ");
  return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, "")}…`;
}

/** A task the user typed once and doesn't want to keep. Identical to a saved
 *  task at run time — same launcher, same completion protocol, same ephemeral
 *  tab — the only difference being that there's no registry entry left behind
 *  to run it again. This is the escape hatch that stops the task list filling
 *  up with one-shot jobs nobody will run twice. */
export function adhocTaskDef(brief: string, label?: string): MicroTaskDef<{ dir: string }> {
  const job = oneLine(brief);
  return {
    id: ADHOC_TASK_ID,
    label: label ?? adhocLabel(job),
    icon: "⚡",
    placeholder: "",
    cwd: (p) => p.dir,
    buildContext: (_p, userQuery) => {
      const query = oneLine(userQuery);
      return job + (query ? ` The user adds: "${query}".` : "");
    },
  };
}

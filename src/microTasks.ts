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
  /** Set by tasks that mutate files; the launcher prepares the checkout. */
  isolation?: PrWorktreeIsolation<P>;
}

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

/** Every built-in micro-task a CTA can launch. These are surface-bound: their
 *  payload comes from where the button lives (see each task's surfaceNote),
 *  which is why the Tasks panel lists them read-only — run them from there. */
export const MICRO_TASKS: MicroTaskDef<never>[] = [
  raisePrTask as MicroTaskDef<never>,
  reviewPrTask as MicroTaskDef<never>,
  addressPrCommentsTask as MicroTaskDef<never>,
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

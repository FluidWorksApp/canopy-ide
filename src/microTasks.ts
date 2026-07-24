// Micro-tasks: one-shot jobs an agent does from a single CTA — "Raise PR" on a
// branch — then reports done via the canopy_job_done MCP tool and disappears
// (tab closed, session forgotten). Each definition builds the agent's opening
// brief from the surface it was clicked on plus whatever the user typed; the
// launcher appends the shared completion protocol. Kin to the context builders
// in prs.ts / trackers.ts, but registered so any surface can host a CTA.
import type * as ipc from "./ipc";

export interface MicroTaskDef<P> {
  id: string;
  /** CTA label — also the tab title ("Raise PR · Claude Code"). */
  label: string;
  icon: string;
  /** Hint for the optional user-context input in the CTA popover. */
  placeholder: string;
  cwd(payload: P): string;
  /** The job brief — a single line (PTY prompt contract, see preview.ts). The
   *  completion protocol is appended by the launcher, not here. */
  buildContext(payload: P, userQuery: string): string;
  /** For the Tasks panel's built-in list: where this task's button lives.
   *  Built-ins run from their surface, which is what supplies the payload. */
  surfaceNote?: string;
  // Future seam: isolation?: "worktree" — create a throwaway worktree first,
  // startPrAgent-style, for tasks that mutate files. Raise PR doesn't.
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
        `Then create the PR with \`gh pr create\`, with a clear title and a body that ` +
        `summarizes what the branch's commits actually change (read \`git log\` and the diff ` +
        `against the base branch). Do not commit anything and do not change any files — ` +
        `this branch ships as it is. Pass the created PR's URL to canopy_job_done.` +
        (query ? ` The user adds: "${query}".` : ""),
    );
  },
};

export interface ReviewPrPayload {
  repo: string;
  pr: ipc.PrInfo;
}

/** Review a PR without checking anything out: read it via gh, post the review
 *  as a PR comment (the durable artifact), report the verdict via job_done.
 *  Deliberately never approves or requests changes — that stays human. */
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
    return oneLine(
      `Review pull request #${n}: "${p.pr.title}" (${p.pr.url}). ` +
        `Read it without checking anything out: \`gh pr view ${n}\`, \`gh pr diff ${n}\`, and ` +
        `the surrounding code in this checkout as needed. Give a thorough review — correctness, ` +
        `edge cases, tests, and risks — then post it on the PR as a review comment ` +
        `(\`gh pr review ${n} --comment --body "..."\`). Do not approve or request changes, and ` +
        `do not commit, push, or check anything out — the posted comment is for the human to act ` +
        `on. Pass the PR's URL to canopy_job_done and make the summary your one-line verdict.` +
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

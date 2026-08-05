// Where an agent's work stands on the road out of its checkout: wrote code →
// committed → pushed → PR. One pure join over AgentWorkspace facts, so every
// surface that answers "did the agent commit? is anything stranded?" phrases
// it identically. "attention" marks the step where work is currently at risk
// of being lost or forgotten — uncommitted files, a branch that was never
// pushed — as opposed to a step that simply hasn't happened yet.

export type TrailState = "done" | "attention" | "pending";

export interface TrailStep {
  id: "code" | "commit" | "push" | "pr";
  label: string;
  state: TrailState;
  /** The number behind the verdict, for the tooltip — "3 files uncommitted". */
  detail: string;
}

export interface TrailFacts {
  dirty: number;
  commits: number;
  /** null = no upstream (never pushed); 0 = everything pushed. */
  unpushed: number | null;
  onBase: boolean;
  merged: boolean;
  /** Isolated worktree — the dirty count is this agent's alone. On a shared
   *  checkout it may include other agents' files, and the trail says so. */
  isolated: boolean;
  /** Files the agent reported touching — catches "wrote code" before the
   *  first save shows up in git, and on a branchless/base session. */
  touched: number;
  /** Open PR from the branch, when the live lookup found one. */
  prNumber?: number | null;
  /** PR numbers this session is on record as having raised (provenance) —
   *  survives merge/close, when the live lookup goes blank. */
  raised?: number[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function agentGitTrail(f: TrailFacts): TrailStep[] {
  const wrote = f.dirty > 0 || f.commits > 0 || f.touched > 0;
  const sharedNote = f.isolated
    ? ""
    : " (shared checkout — the count can include other agents' files)";

  const code: TrailStep = {
    id: "code",
    label: "wrote code",
    state: wrote ? "done" : "pending",
    detail: wrote
      ? f.dirty > 0
        ? plural(f.dirty, "file") + " changed" + sharedNote
        : "all changes are in commits"
      : "no changes yet",
  };

  const commit: TrailStep = {
    id: "commit",
    label: "committed",
    state:
      f.dirty > 0
        ? "attention"
        : f.commits > 0 || (f.onBase && wrote)
          ? "done"
          : "pending",
    detail:
      f.dirty > 0
        ? plural(f.dirty, "uncommitted file") +
          (f.commits > 0 ? ` beside ${plural(f.commits, "commit")}` : "") +
          sharedNote
        : f.onBase
          ? wrote
            ? "nothing uncommitted — but on the base branch, its commits aren't attributed"
            : "nothing committed yet"
          : f.commits > 0
            ? plural(f.commits, "commit") + " on the branch"
            : "nothing committed yet",
  };

  const push: TrailStep = {
    id: "push",
    label: "pushed",
    state: f.merged
      ? "done"
      : f.commits === 0
        ? "pending"
        : f.unpushed === 0
          ? "done"
          : "attention",
    detail: f.merged
      ? "merged into the base branch"
      : f.commits === 0
        ? "nothing to push yet"
        : f.unpushed === null
          ? "the branch was never pushed"
          : f.unpushed === 0
            ? "everything is pushed"
            : plural(f.unpushed, "commit") + " not pushed",
  };

  const prNo = f.prNumber ?? null;
  // PR numbers only ever grow, so the highest is the most recent whatever
  // order the provenance rows arrived in.
  const lastRaised = f.raised?.length ? Math.max(...f.raised) : null;
  const pr: TrailStep = {
    id: "pr",
    label: prNo
      ? `PR #${prNo}`
      : lastRaised
        ? `PR #${lastRaised}`
        : "PR",
    state: prNo || lastRaised ? "done" : f.merged ? "done" : "pending",
    detail: prNo
      ? `#${prNo} is open from this branch`
      : lastRaised
        ? `#${lastRaised} was raised by this session`
        : f.merged
          ? "the branch is already merged"
          : "no PR yet",
  };

  return [code, commit, push, pr];
}

// A merge GitHub refuses because the base branch's policy is not met yet (checks
// pending, reviews missing) can be queued instead: `gh pr merge --auto` merges
// the PR when the policy is met. gh's own refusal names that flag, which is the
// signal used here; conflicts, failing checks and other errors do not say it.

/** True when `error` is gh telling us auto-merge is the way forward. */
export function offersAutoMerge(error: unknown): boolean {
  const text = String((error as { message?: string })?.message ?? error);
  return text.includes("base branch policy") && text.includes("--auto");
}

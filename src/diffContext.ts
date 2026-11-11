// The opening context an agent gets when a diff surface hands it work — the
// counterpart to prReviewContext/ticketContext, but for changes that live in
// the working tree (session changes, a single file's diff) or arrived over the
// relay (a teammate's review). Each builder folds in the user's typed query
// when there is one, and falls back to a plain "review this" brief when empty.
import type { ReviewPayload } from "./components/ReviewView";

/** Attach the user's question, or a default review brief, to a base pointer. */
function withQuery(base: string, query: string): string {
  return query
    ? `${base} Then: ${query}`
    : `${base} Give it a thorough review — correctness, edge cases, tests, and risks — ` +
        `and summarize what you find. Don't commit or push.`;
}

/** One file's working-tree diff. */
export function fileDiffContext(path: string, query: string): string {
  const base = `Look at the current uncommitted changes to \`${path}\` (run \`git diff -- "${path}"\`).`;
  return withQuery(base, query);
}

/** A review request that came over the relay. The diff isn't in any local
 *  checkout, so the caller writes it to `patchPath` first and we point the
 *  agent at that file (and ask it to clean the file up afterwards). */
export function reviewContext(
  review: ReviewPayload,
  patchPath: string,
  query: string,
): string {
  const who = review.from ? `${review.from} ` : "";
  const what = review.title ? ` — "${review.title}"` : "";
  const base =
    `${who}sent a code review request for branch "${review.branch}"${what}. ` +
    `The diff is saved at ${patchPath}` +
    (review.truncated ? " (it was truncated at 2 MB)" : "") +
    `. Read it and the surrounding code.`;
  return `${withQuery(base, query)} Delete ${patchPath} when you're done.`;
}

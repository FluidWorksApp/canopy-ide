// "Suggest message" in the commit box: the brain reads the staged diff and
// writes the commit message.
//
// User-initiated — someone pressed the button and is waiting — so it runs on
// the main tier. Everything the brain needs goes in the prompt (the staged
// patch, the file list, the repo's recent subjects for house style): askBrain
// is read-only and one-shot, and a model left to run `git diff` itself would
// see unstaged work too and describe changes this commit doesn't contain.

import { askBrain, type BrainAnswer } from "./brainCall";
import { isWorkspaceHost } from "./host";
import * as ipc from "./ipc";

/** Characters of patch handed to the brain. Enough for any commit a person
 *  writes one message for; a generated-file avalanche is cut, and the prompt
 *  says so, rather than spending the plan on a lockfile. */
export const COMMIT_DIFF_BUDGET = 60_000;
/** Git's own convention, and what every log view truncates at. */
export const COMMIT_SUBJECT_MAX = 72;

export interface StagedDiff {
  diff: string;
  /** Files whose patch did not fit (listed by name only). */
  omitted: string[];
}

/** Concatenate the staged patch file by file, within the budget. One
 *  `git diff --staged` per file because that is the command that exists in
 *  both desktop and cloud workspaces; a file that would overflow is named but
 *  not included. */
export async function stagedDiff(
  repo: string,
  files: string[],
  budget = COMMIT_DIFF_BUDGET,
  read: (repo: string, path: string) => Promise<string> = (r, p) => ipc.gitDiff(r, p, true),
): Promise<StagedDiff> {
  let diff = "";
  const omitted: string[] = [];
  for (const path of files) {
    if (diff.length >= budget) {
      omitted.push(path);
      continue;
    }
    const patch = await read(repo, path).catch(() => "");
    if (!patch.trim()) continue;
    if (diff.length + patch.length > budget) {
      omitted.push(path);
      continue;
    }
    diff += patch.endsWith("\n") ? patch : `${patch}\n`;
  }
  return { diff, omitted };
}

export function buildCommitPrompt(input: {
  diff: string;
  files: string[];
  omitted?: string[];
  recentSubjects?: string[];
}): string {
  const style = (input.recentSubjects ?? []).filter((s) => s.trim()).slice(0, 8);
  return [
    "Write the git commit message for the staged changes below.",
    "",
    "Rules:",
    `- First line: an imperative summary of what the change does, at most ${COMMIT_SUBJECT_MAX} characters, no trailing period.`,
    "- If the change needs explaining, add a blank line and a short body (wrapped at 72) saying why, not a file-by-file list.",
    "- Describe only what is in this diff. Do not mention tests, issues or co-authors that the diff does not show.",
    "- Reply with the commit message only: no quotes, no code fence, no preamble.",
    style.length
      ? `\nThis repository's recent subjects, for house style:\n${style.map((s) => `- ${s}`).join("\n")}`
      : "",
    "",
    `Staged files (${input.files.length}):`,
    ...input.files.slice(0, 200).map((f) => `- ${f}`),
    input.omitted?.length
      ? `\nToo large to include, judge from the name: ${input.omitted.slice(0, 50).join(", ")}`
      : "",
    "",
    "Staged diff:",
    "```diff",
    input.diff.trimEnd(),
    "```",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}

/** Turn the brain's reply into a commit message, or null when it isn't one.
 *  Tolerates the wrappers models add anyway (a fence, quotes, a "Commit
 *  message:" label); rejects an empty reply, a refusal-shaped one, or a first
 *  line far past any sensible subject. A slightly long subject is cut at a
 *  word boundary rather than thrown away. */
export function cleanCommitMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/\r\n/g, "\n").trim();
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:suggested\s+)?commit message:\s*/i, "").trim();
  if (/^(["'`])[\s\S]*\1$/.test(text)) text = text.slice(1, -1).trim();
  if (!text) return null;
  const [first, ...rest] = text.split("\n");
  let subject = first.trim().replace(/\.$/, "");
  if (!subject || subject.length > 200) return null;
  if (/^(?:i (?:can(?:no|')t|am unable)|sorry|as an ai)/i.test(subject)) return null;
  if (subject.length > COMMIT_SUBJECT_MAX) {
    const cut = subject.slice(0, COMMIT_SUBJECT_MAX);
    const space = cut.lastIndexOf(" ");
    subject = (space > 40 ? cut.slice(0, space) : cut).trimEnd();
  }
  const body = rest.join("\n").trim();
  return body ? `${subject}\n\n${body}` : subject;
}

export type CommitSuggestion =
  | { ok: true; message: string }
  | { ok: false; reason: Extract<BrainAnswer<string>, { ok: false }>["reason"] | "empty"; message: string };

/** Ask the brain for a commit message for what is staged in `repo`. */
export async function suggestCommitMessage(
  repo: string,
  files: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<CommitSuggestion> {
  const { diff, omitted } = await stagedDiff(repo, files);
  if (!diff.trim() && omitted.length === 0) {
    return { ok: false, reason: "empty", message: "Nothing staged to describe." };
  }
  const recentSubjects = await ipc
    .gitLog(repo, 8)
    .then((log) => log.map((c) => c.subject))
    .catch(() => [] as string[]);
  const answer = await askBrain<string>({
    feature: "commit-message",
    tier: "main",
    // The brain runs on the desktop; a cloud workspace's path does not exist
    // there, and the prompt already carries everything it needs.
    cwd: isWorkspaceHost() ? "" : repo,
    prompt: buildCommitPrompt({ diff, files, omitted, recentSubjects }),
    validate: (v) => cleanCommitMessage(v),
    timeoutMs: 90_000,
    signal: opts.signal,
  });
  if (!answer.ok) return { ok: false, reason: answer.reason, message: answer.message };
  return { ok: true, message: answer.value ?? answer.text };
}

/** One line for a suggestion that didn't come back. The connection states
 *  are the chip's job (and swap the button for "Connect your brain"), so
 *  this only has to say what happened to this one request. */
export function suggestFailure(r: Extract<CommitSuggestion, { ok: false }>): string {
  switch (r.reason) {
    case "over-budget":
      return "Today's brain budget for commit messages is used up — raise it from the brain chip.";
    case "rate-limited":
      return "Your brain's plan is rate-limited right now. Try again after it resets.";
    case "signed-out":
    case "no-brain":
      return "Your brain isn't connected.";
    case "timeout":
      return "The brain took too long. Try again.";
    case "invalid-output":
      return "The brain's reply wasn't a usable commit message. Try again.";
    case "empty":
      return r.message;
    default:
      return "Couldn't get a suggestion. Try again.";
  }
}

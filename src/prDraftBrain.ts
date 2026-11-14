// Draft the commit message and pull request text for a checkout's changes with
// the brain CLI (askBrain), from what is uncommitted plus what the branch holds
// beyond its base.
//
// The offline draft in prGenerate.ts stays the fallback: every failure here
// (no brain, over budget, a bad reply, a slow answer) returns null and the
// caller keeps that draft, so raising a PR never depends on a model.
//
// Nothing that looks like a credential is read or sent: `looksSecret` paths are
// left out of the prompt, the same rule the commit flow uses to leave them out
// of the commit.

import { askBrain, type BrainAnswer, type BrainRequest } from "./brainCall";
import { looksSecret } from "./commitPushPr";
import * as ipc from "./ipc";

export interface BrainPrDraft {
  /** The pull request's title. */
  title: string;
  /** The commit message: a subject, a blank line, then the why. */
  message: string;
  /** The pull request's description. */
  body: string;
}

export interface DraftDeps {
  status: (repo: string) => Promise<{ branch: string | null; entries: { status: string; path: string }[] }>;
  diff: (repo: string, path: string, staged: boolean) => Promise<string>;
  readText: (path: string, maxBytes: number) => Promise<string>;
  context: (repo: string) => Promise<{
    branch: string;
    base: string;
    commits: string[];
    stat: string;
    template: string | null;
  }>;
  ask: (req: BrainRequest<BrainPrDraft>) => Promise<BrainAnswer<BrainPrDraft>>;
}

export const ipcDraftDeps: DraftDeps = {
  status: (repo) => ipc.gitStatus(repo),
  diff: (repo, path, staged) => ipc.gitDiff(repo, path, staged),
  readText: (path, maxBytes) => ipc.fsReadText(path, maxBytes),
  context: (repo) => ipc.gitPrContext(repo),
  ask: (req) => askBrain<BrainPrDraft>(req),
};

/** Most paths shown with their changes, how much of each, and the whole prompt's budget. */
export const MAX_FILES = 40;
export const MAX_PER_FILE = 4000;
export const MAX_TOTAL = 30000;
const MAX_COMMITS = 30;
const MAX_TEMPLATE = 4000;
export const DRAFT_TIMEOUT_MS = 60_000;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;

type Change = { path: string; text: string };

/** Each changed path with its diff (staged and unstaged) or, for a new untracked
 *  file, its first lines. Secret-looking paths are omitted entirely. */
async function collectChanges(deps: DraftDeps, repo: string, entries: { status: string; path: string }[]) {
  const paths = [...new Set(entries.map((e) => e.path))].filter((p) => !looksSecret(p));
  const statusOf = new Map(entries.map((e) => [e.path, e.status] as const));
  const shown: Change[] = [];
  let used = 0;
  let index = 0;
  for (; index < paths.length && index < MAX_FILES && used < MAX_TOTAL; index++) {
    const path = paths[index];
    let text = "";
    try {
      if (statusOf.get(path) === "??") {
        text = `(new file)\n${await deps.readText(`${repo.replace(/\/$/, "")}/${path}`, MAX_PER_FILE)}`;
      } else {
        const staged = await deps.diff(repo, path, true).catch(() => "");
        const unstaged = await deps.diff(repo, path, false).catch(() => "");
        text = [staged, unstaged].filter(Boolean).join("\n");
      }
    } catch {
      text = "(could not be read)";
    }
    const part = clip(text, MAX_PER_FILE);
    shown.push({ path, text: part });
    used += part.length + path.length;
  }
  return { shown, unshown: paths.slice(index) };
}

export function buildDraftPrompt(input: {
  branch: string;
  base: string;
  commits: string[];
  stat: string;
  template: string | null;
  shown: Change[];
  unshown: string[];
}): string {
  const commits = input.commits.slice(-MAX_COMMITS);
  const changes = input.shown.length
    ? input.shown.map((c) => `### ${c.path}\n${c.text || "(no textual change)"}`).join("\n\n")
    : "(nothing uncommitted)";
  const rest = input.unshown.length
    ? `\n\nAlso changed, not shown (${input.unshown.length}): ${input.unshown.slice(0, 60).join(", ")}`
    : "";
  return [
    "You write the commit message and the pull request text for the changes below.",
    'Reply with one JSON object: {"title": string, "commit": string, "body": string}.',
    "",
    "Rules:",
    '- "title": the pull request title. An imperative outcome in sentence case, no "feat:" or "fix:" prefix, no trailing period, at most 72 characters. Say what changes for the person using the product, not which files moved.',
    '- "commit": the commit message. A subject line in the same style (at most 72 characters), a blank line, then a short plain-text body that explains why the change is made.',
    `- "body": the pull request description in markdown. ${
      input.template
        ? "Fill in the repository's template below, keeping its headings."
        : "Use the headings Summary, Changes and Testing."
    } Describe only what the changes show. Do not claim anything was tested or passed. Under Testing write "- [ ] Describe how this was verified." unless the changes add tests, and then name them.`,
    "",
    `Branch: ${input.branch}${input.base ? ` (base ${input.base})` : ""}`,
    input.commits.length ? `Commits already on the branch:\n${commits.map((c) => `- ${c}`).join("\n")}` : "No commits beyond the base yet.",
    input.stat ? `Branch summary: ${input.stat}` : "",
    "",
    "Uncommitted changes (paths that look like credentials are left out):",
    changes + rest,
    input.template ? `\nPull request template:\n${clip(input.template, MAX_TEMPLATE)}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** A reply is usable only when all three parts are real text. The title is one line. */
export function validateDraft(value: unknown): BrainPrDraft | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const title = typeof v.title === "string" ? v.title.replace(/\s+/g, " ").trim() : "";
  const message = typeof v.commit === "string" ? v.commit.trim() : typeof v.message === "string" ? v.message.trim() : "";
  const body = typeof v.body === "string" ? v.body.trim() : "";
  if (!title || title.length > 120 || !message || !body) return null;
  return { title, message, body };
}

/** The brain's draft for this checkout, or null for any reason it cannot give one. */
export async function draftPrWithBrain(
  opts: { repo: string; signal?: AbortSignal },
  deps: DraftDeps = ipcDraftDeps,
): Promise<BrainPrDraft | null> {
  try {
    const [status, context] = await Promise.all([deps.status(opts.repo), deps.context(opts.repo).catch(() => null)]);
    const { shown, unshown } = await collectChanges(deps, opts.repo, status.entries);
    if (!shown.length && !context?.commits.length) return null;
    const answer = await deps.ask({
      feature: "pr",
      tier: "main",
      json: true,
      cwd: opts.repo,
      prompt: buildDraftPrompt({
        branch: context?.branch ?? status.branch ?? "",
        base: context?.base ?? "",
        commits: context?.commits ?? [],
        stat: context?.stat ?? "",
        template: context?.template ?? null,
        shown,
        unshown,
      }),
      validate: validateDraft,
      timeoutMs: DRAFT_TIMEOUT_MS,
      signal: opts.signal,
    });
    return answer.ok && answer.value ? answer.value : null;
  } catch {
    return null;
  }
}

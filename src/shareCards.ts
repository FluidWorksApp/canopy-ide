// Building share cards on the sender's side, from what each entry point has:
// a PR row, an editor selection, a diff, a terminal selection, an agent report.
//
// Everything here ends in a card that cardSchema.parseCard accepts, or a
// ShareError that says plainly why not. Repos are named only by their origin
// (host + owner/name); a checkout with no origin on a git host cannot be shared
// as a repo card at all, because there is nothing a teammate could open.
import * as ipc from "./ipc";
import { repoRefFromRemote } from "./gitLinks";
import {
  LIMITS,
  SHA,
  clipBytes,
  cleanLine,
  stripAnsi,
  validCardPath,
  type Card,
  type DiffCard,
  type FileCard,
  type PrCard,
  type RepoRef,
  type ReportCard,
  type ReviewRequestCard,
  type TerminalCard,
} from "./teamMessaging/cardSchema";

export class ShareError extends Error {}

/** What the entry points open the share dialog with. */
export type ShareRequest =
  | { kind: "share"; card: Card; warning?: string; /** A teammate's account id: opens addressed to them, and mentions them. */ to?: string }
  | { kind: "review"; card: Omit<ReviewRequestCard, "reviewers"> }
  | { kind: "error"; message: string };

export const OPEN_SHARE_DIALOG_EVENT = "canopy:open-share-dialog";
/** Opens the one share dialog (ShareDialogHost, mounted by App). */
export function openShareDialog(request: ShareRequest): void {
  window.dispatchEvent(new CustomEvent<ShareRequest>(OPEN_SHARE_DIALOG_EVENT, { detail: request }));
}
/** Builds a card and opens the dialog with it — or with the reason it can't be shared. */
export function shareWith(build: () => Promise<ShareRequest>): void {
  void build()
    .catch(
      (e: unknown): ShareRequest => ({
        kind: "error",
        message: e instanceof ShareError ? e.message : `Couldn't prepare this to share: ${e instanceof Error ? e.message : String(e)}`,
      }),
    )
    .then(openShareDialog);
}

const NO_ORIGIN =
  "This checkout has no origin on a git host, so there is nothing a teammate could open. Add or push to a remote first.";

/** The repo a checkout's origin names; refuses a checkout without one. */
export async function repoRefFor(repoPath: string): Promise<RepoRef> {
  const remote = await ipc.gitRemoteUrl(repoPath).catch(() => "");
  const ref = repoRefFromRemote(remote);
  if (!ref) throw new ShareError(NO_ORIGIN);
  return ref;
}

const full = (sha: string | undefined) => (sha && SHA.test(sha) ? sha : undefined);
const titleOf = (value: string, fallback: string) => cleanLine(value, LIMITS.title) || fallback;

/** Code or a patch as a block a card can carry: line endings normalized, and
 *  control and bidi characters (the Trojan Source kind) removed. */
export function cleanBlock(value: string): string {
  return stripAnsi(value).replace(/\s+$/, "");
}
/** At most `maxBytes`, cut at a line boundary; `tail` keeps the end instead. */
export function clipLines(value: string, maxBytes: number, tail = false): { text: string; clipped: boolean } {
  if (new TextEncoder().encode(value).length <= maxBytes) return { text: value, clipped: false };
  if (tail) {
    const lines = value.split("\n");
    const out: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const n = new TextEncoder().encode(lines[i]).length + 1;
      if (used + n > maxBytes) break;
      out.unshift(lines[i]);
      used += n;
    }
    return { text: out.join("\n") || clipBytes(value.slice(-maxBytes), maxBytes).text, clipped: true };
  }
  const { text } = clipBytes(value, maxBytes);
  const cut = text.lastIndexOf("\n");
  return { text: cut > 0 ? text.slice(0, cut) : text, clipped: true };
}

export async function buildPrCard(repoPath: string, pr: ipc.PrInfo): Promise<PrCard> {
  const repo = await repoRefFor(repoPath);
  const head = full(pr.head_sha);
  const base = full(pr.base_sha);
  return {
    type: "pr",
    v: 1,
    repo,
    number: pr.number,
    title: titleOf(pr.title, `#${pr.number}`),
    ...(head ? { head } : {}),
    ...(base ? { base } : {}),
  };
}

/** A review request pins the head commit it asks about; reviewers are chosen in the dialog. */
export async function buildReviewRequest(
  repoPath: string,
  pr: ipc.PrInfo,
  list: (repo: string) => Promise<ipc.PrInfo[]> = ipc.ghPrList,
): Promise<Omit<ReviewRequestCard, "reviewers">> {
  const repo = await repoRefFor(repoPath);
  let head = full(pr.head_sha);
  if (!head) head = full((await list(repoPath).catch(() => [])).find((p) => p.number === pr.number)?.head_sha);
  if (!head) throw new ShareError(`Couldn't read the head commit of #${pr.number} from GitHub. Is gh signed in?`);
  return { type: "review-request", v: 1, repo, number: pr.number, title: titleOf(pr.title, `#${pr.number}`), head };
}

export interface FileShare {
  card: FileCard;
  /** Set when the shared lines may not match the commit the card names. */
  warning?: string;
}
/** Lines of a file as committed at HEAD — with a warning when the file has
 *  uncommitted changes, since the recipient sees the commit. */
export async function buildFileCard(absPath: string, start: number, end: number, text: string): Promise<FileShare> {
  const ctx = await ipc.gitShareContext(absPath);
  const repo = repoRefFromRemote(ctx.origin);
  if (!repo) throw new ShareError(NO_ORIGIN);
  if (!validCardPath(ctx.rel)) throw new ShareError("This file's path can't be shared (it's outside the repo, inside .git, or has unusual characters).");
  if (!full(ctx.head)) throw new ShareError("This repo has no commits yet. Commit the file first.");
  if (end - start + 1 > LIMITS.maxSpan) throw new ShareError(`Select at most ${LIMITS.maxSpan} lines.`);
  const { text: snippet, clipped } = clipLines(cleanBlock(text), LIMITS.snippetBytes);
  const card: FileCard = {
    type: "file",
    v: 1,
    repo,
    path: ctx.rel,
    rev: ctx.head,
    lines: { start, end: clipped ? start + snippet.split("\n").length - 1 : end },
    ...(snippet ? { snippet } : {}),
  };
  const warnings = [
    ctx.dirty ? `${ctx.rel} has uncommitted changes; teammates will open it at ${ctx.head.slice(0, 7)}, which may differ.` : "",
    clipped ? "The selection was shortened to fit a card." : "",
  ].filter(Boolean);
  return { card, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}

/** One file's diff in a PR, between the PR's base and head commits. */
export async function buildDiffCard(repoPath: string, pr: ipc.PrInfo, path: string, patch: string): Promise<{ card: DiffCard; warning?: string }> {
  const repo = await repoRefFor(repoPath);
  const base = full(pr.base_sha);
  const head = full(pr.head_sha);
  if (!base || !head) throw new ShareError(`Couldn't read #${pr.number}'s commits from GitHub. Refresh the PR and try again.`);
  if (!validCardPath(path)) throw new ShareError("This file's path can't be shared.");
  const { text, clipped } = clipLines(cleanBlock(patch), LIMITS.patchBytes);
  if (!text) throw new ShareError("There is no diff to share for this file.");
  return {
    card: { type: "diff", v: 1, repo, base, head, path, patch: text, pr: pr.number },
    ...(clipped ? { warning: "The diff was shortened to fit a card; teammates can open the whole PR." } : {}),
  };
}

/** Selected terminal output: escape sequences stripped, the last 12 KB kept. */
export function buildTerminalCard(title: string, output: string, command?: string): TerminalCard {
  const clean = cleanBlock(output);
  if (!clean.trim()) throw new ShareError("Select some output first.");
  const { text, clipped } = clipLines(clean, LIMITS.outputBytes, true);
  const cmd = command ? cleanLine(command, LIMITS.command) : "";
  return {
    type: "terminal",
    v: 1,
    title: titleOf(title, "Terminal output"),
    ...(cmd ? { command: cmd } : {}),
    output: text,
    ...(clipped ? { truncated: true } : {}),
  };
}

/** An agent's report, as plain text. The repo is optional: without an origin it is left off rather than refused. */
export async function buildReportCard(agent: string, title: string, body: string, repoPath?: string, pr?: number): Promise<ReportCard> {
  const clean = cleanBlock(body);
  if (!clean.trim()) throw new ShareError("This report is empty.");
  const { text } = clipLines(clean, LIMITS.bodyBytes);
  const repo = repoPath ? await repoRefFor(repoPath).catch(() => undefined) : undefined;
  return {
    type: "report",
    v: 1,
    agent: titleOf(agent, "Agent"),
    title: titleOf(title, "Report"),
    body: text,
    ...(repo ? { repo, ...(pr ? { pr } : {}) } : {}),
  };
}

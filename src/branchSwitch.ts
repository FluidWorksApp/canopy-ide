// Turning a refused branch switch into something a person can answer.
//
// Git has good reasons to refuse a checkout and terrible ways of saying so
// ("fatal: 'x' is already used by worktree at '/…'"). The backend classifies
// those refusals into outcomes; this module turns an outcome into the dialog
// the user sees — title, one plain sentence, and the ways out, best-first.
//
// House rules for the copy here: no git nouns in the primary text. A worktree
// is a "workspace", a detached checkout is a "snapshot", a stash is "your
// changes, saved". The git term is allowed in the small secondary line, where
// it teaches rather than blocks.
import type * as ipc from "./ipc";

export type SwitchAction =
  /** Point the project's files at the workspace that already has the branch. */
  | "open-there"
  /** Free the name from that workspace, then switch here. */
  | "move-here"
  /** Detached checkout — look without moving anything. */
  | "snapshot"
  /** Set the local changes aside, switch, put them back. */
  | "carry"
  /** Drop the record of a workspace whose folder is gone, then switch. */
  | "cleanup"
  | "cancel";

export interface SwitchChoice {
  action: SwitchAction;
  label: string;
  /** One line under the label: what it does to your files. */
  sub?: string;
  /** The safest way out of this dialog — visually led, never auto-run. */
  recommended?: boolean;
  /** Shown, but not offerable; `sub` says why. */
  disabled?: boolean;
}

export interface SwitchDialog {
  title: string;
  body: string;
  /** Small print — the git-level detail, including raw output when we have
   *  nothing better. Never the only thing on screen. */
  detail?: string;
  choices: SwitchChoice[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const SNAPSHOT_SUB =
  "Look around without moving anything. Your next branch switch puts everything back.";

/** How to describe the workspace holding a branch, without saying "worktree"
 *  first. */
export function holderPhrase(holder: ipc.BranchHolder): string {
  if (holder.is_main) return "this project's main checkout";
  return holder.agent ? "an agent workspace" : "another workspace";
}

const dirtyNote = (holder: ipc.BranchHolder) =>
  holder.dirty > 0
    ? `${holder.dirty} unsaved ${plural(holder.dirty, "change", "changes")} there stay put.`
    : "";

function busyDialog(branch: string, holder: ipc.BranchHolder): SwitchDialog {
  const choices: SwitchChoice[] = [];

  if (holder.prunable) {
    // The folder is gone; only git's bookkeeping still claims the name, and no
    // other option can work until that record goes.
    return {
      title: "This branch is stuck on a workspace that's gone",
      body: `${branch} is still claimed by a workspace whose folder no longer exists.`,
      detail: `${holder.path} — ${holder.prunable}`,
      choices: [
        {
          action: "cleanup",
          label: "Clear it and switch",
          sub: "Forgets the missing workspace. Nothing on disk is touched.",
          recommended: true,
        },
        { action: "snapshot", label: "Test a snapshot", sub: SNAPSHOT_SUB },
        { action: "cancel", label: "Cancel" },
      ],
    };
  }

  if (!holder.is_main) {
    choices.push({
      action: "open-there",
      label: "Open it there",
      sub: `Point this project's files at ${holder.name}. Nothing moves, nothing is lost.`,
      recommended: true,
    });
  }

  choices.push(
    holder.locked
      ? {
          action: "move-here",
          label: "Move the branch here",
          sub: "That workspace is locked, so its branch can't be moved out.",
          disabled: true,
        }
      : {
          action: "move-here",
          label: "Move the branch here",
          sub: [
            `${holder.is_main ? "That checkout" : "That workspace"} keeps its files; the branch moves to this project.`,
            dirtyNote(holder),
          ]
            .filter(Boolean)
            .join(" "),
          recommended: holder.is_main,
        },
  );

  choices.push({ action: "snapshot", label: "Test a snapshot", sub: SNAPSHOT_SUB });
  choices.push({ action: "cancel", label: "Cancel" });

  return {
    title: "This branch is busy",
    body: `${branch} is currently open in ${holderPhrase(holder)}.`,
    detail: `${holder.path}${holder.locked ? ` — locked: ${holder.locked}` : ""}`,
    choices,
  };
}

function localChangesDialog(
  branch: string,
  out: Extract<ipc.CheckoutOutcome, { kind: "local_changes" }>,
): SwitchDialog {
  const n = out.files.length;
  return {
    title: n
      ? `You have unsaved changes to ${n} ${plural(n, "file", "files")}`
      : "You have unsaved changes",
    body: `Switching to ${branch} would overwrite ${
      out.untracked ? "new files you haven't committed" : "them"
    }.`,
    detail: out.files.join("\n") || out.detail,
    choices: [
      {
        action: "carry",
        label: "Carry them over safely",
        sub: "Your changes are set aside, the branch switches, then they're put back.",
        recommended: true,
      },
      { action: "cancel", label: "Cancel" },
    ],
  };
}

function stashedDialog(
  branch: string,
  out: Extract<ipc.CheckoutOutcome, { kind: "changes_stashed" }>,
): SwitchDialog {
  return {
    title: "Your changes are saved, but not back yet",
    body: `You're on ${branch} now. Your changes clashed with what's on this branch, so they've been kept safely to one side instead of being forced in — nothing is lost.`,
    detail: `Put them back when you're ready with: git stash pop (saved as ${out.stash})\n\n${out.detail}`,
    choices: [{ action: "cancel", label: "Got it", recommended: true }],
  };
}

/** The dialog for an outcome, or null when there is nothing to ask about. */
export function switchDialog(
  branch: string,
  out: ipc.CheckoutOutcome,
): SwitchDialog | null {
  switch (out.kind) {
    case "switched":
      return null;
    case "branch_in_worktree":
      return busyDialog(branch, out.holder);
    case "local_changes":
      return localChangesDialog(branch, out);
    case "changes_stashed":
      return stashedDialog(branch, out);
    case "failed":
      return {
        title: `Couldn't switch to ${branch}`,
        body: out.summary,
        detail: out.detail,
        choices: [
          { action: "snapshot", label: "Test a snapshot", sub: SNAPSHOT_SUB },
          { action: "cancel", label: "Cancel" },
        ],
      };
  }
}

/** A thrown error is the last resort — the backend only throws when it couldn't
 *  run git at all — but it still gets a human first line. */
export function errorDialog(branch: string, err: unknown): SwitchDialog {
  return {
    title: `Couldn't switch to ${branch}`,
    body: "Git wouldn't run that switch. The details below are its own.",
    detail: String(err),
    choices: [{ action: "cancel", label: "Close" }],
  };
}

/** Branch name → the worktree holding it, for badging the branch list before
 *  anyone clicks. `repoPath` is this checkout, which never counts as a holder
 *  of its own branch. */
export function heldBranches(
  worktrees: ipc.WorktreeInfo[],
  repoPath: string | null,
): Map<string, ipc.WorktreeInfo> {
  const held = new Map<string, ipc.WorktreeInfo>();
  for (const w of worktrees) {
    if (!w.branch || w.path === repoPath) continue;
    held.set(w.branch, w);
  }
  return held;
}

/** The badge for a held branch: short enough for a row, honest about which
 *  kind of workspace has it. */
export function heldBadge(w: ipc.WorktreeInfo): { label: string; title: string } {
  const label = w.prunable
    ? "workspace missing"
    : w.is_main
      ? "in main checkout"
      : w.path.includes("/.claude/worktrees/")
        ? "in agent workspace"
        : "in another workspace";
  return {
    label,
    title: `${w.branch} is open in ${w.path}\nClick to see your options for testing it.`,
  };
}

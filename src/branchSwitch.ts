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

/** What a ref-moving command did, or why it couldn't — named here so the copy
 *  layer reads as the answer to one thing, and so a caller building a dialog
 *  never has to reach for the IPC module. */
export type CheckoutOutcome = ipc.CheckoutOutcome;

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
  /** Same, for a record that is *also* still claimed — an ordinary prune skips
   *  a locked entry silently, so the plain cleanup would loop forever. */
  | "force-cleanup"
  /** Give the branch a workspace of its own instead of moving anything here. */
  | "open-elsewhere"
  /** Drop the half-finished merge/replay/copy. Every file stays as it is. */
  | "stop-operation"
  /** Run the same thing again — something else was holding the project. */
  | "retry"
  /** Look on the remote first, then run the same thing again. */
  | "fetch-retry"
  /** Start the branch here after all: nothing of that name exists yet. */
  | "create-here"
  /** Open the branch that already has that name, instead of starting one. */
  | "switch-existing"
  /** Use the folder that is already there instead of making a second one. */
  | "reuse-workspace"
  /** Put a branch on commits the switch would otherwise have left loose. */
  | "keep-leftovers"
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
    //
    // Locked *and* missing needs the heavier hand: `git worktree prune` skips a
    // locked entry without a word and exits 0, so the ordinary cleanup would
    // come back here forever.
    const clear: SwitchChoice = holder.locked
      ? {
          action: "force-cleanup",
          label: "Clear it and switch",
          sub: "Forgets the missing workspace, even though something still claimed it. Nothing on disk is touched.",
          recommended: true,
        }
      : {
          action: "cleanup",
          label: "Clear it and switch",
          sub: "Forgets the missing workspace. Nothing on disk is touched.",
          recommended: true,
        };
    return {
      title: "This branch is stuck on a workspace that's gone",
      body: `${branch} is still claimed by a workspace whose folder no longer exists.`,
      detail: `${holder.path} — ${holder.prunable}${
        holder.locked ? `\nlocked: ${holder.locked}` : ""
      }`,
      choices: [
        clear,
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
  out: Extract<CheckoutOutcome, { kind: "local_changes" }>,
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
  out: Extract<CheckoutOutcome, { kind: "changes_stashed" }>,
): SwitchDialog {
  return {
    title: "Your changes are saved, but not back yet",
    body: `You're on ${branch} now. Your changes clashed with what's on this branch, so they've been kept safely to one side instead of being forced in — nothing is lost.`,
    detail: `Put them back when you're ready with: git stash pop (saved as ${out.stash})\n\n${out.detail}`,
    choices: [{ action: "cancel", label: "Got it", recommended: true }],
  };
}

/** The half-finished operations git will not switch out of, said in words rather
 *  than in git's verbs. `noun` is the short form the "call it off" label uses. */
const OPERATIONS: Record<string, { unfinished: string; noun: string }> = {
  merge: { unfinished: "a merge you haven't finished", noun: "merge" },
  rebase: {
    unfinished: "a replay of your commits you haven't finished",
    noun: "replay",
  },
  "cherry-pick": { unfinished: "a commit you were copying across", noun: "copy" },
  revert: { unfinished: "a commit you were undoing", noun: "undo" },
  am: { unfinished: "a set of patches you were applying", noun: "run of patches" },
};

function repoBusyDialog(
  branch: string,
  out: Extract<CheckoutOutcome, { kind: "repo_busy" }>,
): SwitchDialog {
  const op = OPERATIONS[out.operation];
  if (!op) {
    // Not a half-finished operation — something else holds the project's lock
    // right now. Waiting it out is the whole answer.
    return {
      title: "This project is busy right now",
      body: "Another command is using this project right now.",
      detail: out.detail,
      choices: [
        {
          action: "retry",
          label: "Try again",
          sub: "Runs the same thing again, once the other command has let go.",
          recommended: true,
        },
        { action: "cancel", label: "Leave it for now" },
      ],
    };
  }
  return {
    title: "This project is in the middle of something",
    body: `There's ${op.unfinished} here, so ${branch} can't be opened yet.`,
    detail: [
      `git ${out.operation} --quit — the ${out.operation} state is cleared; the working tree is untouched.`,
      out.detail,
    ]
      .filter(Boolean)
      .join("\n\n"),
    choices: [
      {
        action: "open-elsewhere",
        label: "Open it in a workspace of its own",
        sub: `Leaves everything here exactly as it is and gives ${branch} its own folder.`,
        recommended: true,
      },
      {
        action: "stop-operation",
        label: `Call off that ${op.noun}, keep your files`,
        sub: "Only the half-finished operation is dropped. Every file you have stays exactly as it is.",
      },
      { action: "cancel", label: "Leave it for now" },
    ],
  };
}

function nothingCalledDialog(
  out: Extract<CheckoutOutcome, { kind: "nothing_called" }>,
): SwitchDialog {
  const choices: SwitchChoice[] = [
    {
      action: "fetch-retry",
      label: "Look for it on GitHub",
      sub: "Fetches from the remote, then tries again. Nothing here changes.",
      recommended: true,
    },
  ];
  if (out.can_create)
    choices.push({
      action: "create-here",
      label: "Start it here instead",
      sub: `Makes ${out.name} from where you are now.`,
    });
  choices.push({ action: "cancel", label: "Cancel" });
  return {
    title: `There's nothing here called ${out.name}`,
    body: "No branch or commit with that name is in this project yet — it may only exist on GitHub.",
    detail: out.detail,
    choices,
  };
}

function nameTakenDialog(
  out: Extract<CheckoutOutcome, { kind: "name_taken" }>,
): SwitchDialog {
  return {
    title: `There's already a branch called ${out.branch}`,
    body: "You asked to start a new one, but that name is taken.",
    detail: out.detail,
    choices: [
      {
        action: "switch-existing",
        label: "Open the one that's already there",
        sub: `Switches to ${out.branch} as it stands.`,
        recommended: true,
      },
      { action: "cancel", label: "Pick another name" },
    ],
  };
}

function pathInUseDialog(
  out: Extract<CheckoutOutcome, { kind: "path_in_use" }>,
): SwitchDialog {
  const choices: SwitchChoice[] = [];
  if (out.usable)
    choices.push({
      action: "reuse-workspace",
      label: "Use the folder that's there",
      sub: "Opens it as it is. Nothing is created and nothing is deleted.",
      recommended: true,
    });
  choices.push({ action: "cancel", label: "Choose another name" });
  return {
    title: "There's already a folder there",
    body: `${out.path} exists, so a new workspace can't be put at that name.`,
    detail: out.detail,
    choices,
  };
}

function remoteUnreachableDialog(
  out: Extract<CheckoutOutcome, { kind: "remote_unreachable" }>,
): SwitchDialog {
  return {
    title: "Couldn't get that from GitHub",
    body: out.summary || "Canopy couldn't reach GitHub just now.",
    detail: out.detail,
    choices: [
      {
        action: "retry",
        label: "Try again",
        sub: "Asks GitHub once more. Nothing here changes either way.",
        recommended: true,
      },
      { action: "cancel", label: "Cancel" },
    ],
  };
}

/** The branch a loose commit is offered: deterministic, so the dialog can name
 *  it up front and never needs a text field. */
export function savedBranchName(commit: string): string {
  const sha = commit.trim().split(/\s+/)[0] ?? "";
  return `saved-${sha.slice(0, 7)}`;
}

function leftoversDialog(
  branch: string,
  out: Extract<CheckoutOutcome, { kind: "switched_with_leftovers" }>,
): SwitchDialog {
  const n = out.commits.length;
  const it = plural(n, "It's", "They're");
  return {
    title: `You're on ${branch} — but ${
      n === 1 ? "a commit was" : `${n} commits were`
    } left behind`,
    body: `The snapshot you were looking at had ${n} ${plural(
      n,
      "commit that isn't",
      "commits that aren't",
    )} on any branch. ${it} still here, and ${plural(
      n,
      "it's",
      "they're",
    )} easy to lose.`,
    detail: [out.commits.join("\n"), out.detail].filter(Boolean).join("\n\n"),
    choices: [
      {
        action: "keep-leftovers",
        label: plural(n, "Save it to a branch", "Save them to a branch"),
        sub: `Makes a branch called ${savedBranchName(
          out.commits[0] ?? "",
        )} at that commit, so it stops being loose.`,
        recommended: true,
      },
      { action: "cancel", label: plural(n, "I know — leave it", "I know — leave them") },
    ],
  };
}

/** The dialog for an outcome, or null when there is nothing to ask about. */
export function switchDialog(
  branch: string,
  out: CheckoutOutcome,
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
    case "repo_busy":
      return repoBusyDialog(branch, out);
    case "nothing_called":
      return nothingCalledDialog(out);
    case "name_taken":
      return nameTakenDialog(out);
    case "path_in_use":
      return pathInUseDialog(out);
    case "remote_unreachable":
      return remoteUnreachableDialog(out);
    case "switched_with_leftovers":
      return leftoversDialog(branch, out);
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

/** What a workspace was asked for. `pr` is set when the workspace is for a pull
 *  request's head rather than for the branch itself — the one difference that
 *  changes the ways out. */
export interface WorkspaceRequest {
  branch: string;
  pr?: number;
}

/** The dialog for an outcome of *making a workspace*, which asks a different
 *  question from switching here.
 *
 *  `switchDialog` stays intent-blind on purpose (its wording is pinned), so the
 *  one place the two intents genuinely diverge lives here: when something else
 *  holds the branch, "Move the branch here" is meaningless — you asked for a
 *  second folder, not for the branch to relocate. Everything else reads the
 *  same, so it is delegated rather than duplicated. */
export function workspaceDialog(
  req: WorkspaceRequest,
  out: CheckoutOutcome,
): SwitchDialog | null {
  if (out.kind !== "branch_in_worktree") return switchDialog(req.branch, out);
  const holder = out.holder;
  const choices: SwitchChoice[] = [
    {
      action: "open-there",
      label: "Open the workspace that has it",
      sub: `Point this project's files at ${holder.name}. Nothing moves, nothing is lost.`,
      recommended: true,
    },
  ];
  if (req.pr != null)
    choices.push({
      action: "snapshot",
      label: "Make one at the pull request's head instead",
      sub: `A folder of its own, holding #${req.pr}'s changes exactly as they are. ${req.branch} stays where it is.`,
    });
  choices.push({ action: "cancel", label: "Choose another name" });
  return {
    title: "This branch is busy",
    body: `${req.branch} is currently open in ${holderPhrase(holder)}.`,
    detail: `${holder.path}${holder.locked ? ` — locked: ${holder.locked}` : ""}`,
    choices,
  };
}

/** Any other question, in this same shape and this same single dialog — remove
 *  a workspace, delete a branch, leave a workspace. One model for every
 *  question means recommended leads, per-choice sub-lines and a folded Details
 *  everywhere, instead of a second free-text confirm with none of them.
 *
 *  A way out is guaranteed: a `cancel` is appended when the caller forgot one,
 *  because no dialog in this app is allowed to dead-end. */
export function askDialog(d: {
  title: string;
  body: string;
  detail?: string;
  choices: SwitchChoice[];
}): SwitchDialog {
  const choices = d.choices.some((c) => c.action === "cancel")
    ? d.choices
    : [...d.choices, { action: "cancel" as const, label: "Cancel" }];
  return { title: d.title, body: d.body, detail: d.detail, choices };
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

/** Either way a surface knows about a held branch: from the worktree list, or
 *  from the work audit's per-branch rows. The badge is the same either way, so
 *  it is written once. */
export type HeldBranch = ipc.WorktreeInfo | ipc.BranchWork;

/** Where the holding workspace is, whichever shape we were handed. */
const heldPath = (w: HeldBranch) => ("path" in w ? w.path : (w.worktree ?? ""));

/** The badge for a held branch: short enough for a row, honest about which
 *  kind of workspace has it. */
export function heldBadge(w: HeldBranch): { label: string; title: string } {
  const path = heldPath(w);
  const label = w.prunable
    ? "workspace missing"
    : w.is_main
      ? "in main checkout"
      : path.includes("/.claude/worktrees/")
        ? "in agent workspace"
        : "in another workspace";
  return {
    label,
    title: `${w.branch} is open in ${path}\nClick to see your options for testing it.`,
  };
}

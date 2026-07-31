import { describe, expect, it } from "vitest";
import {
  askDialog,
  errorDialog,
  heldBadge,
  heldBranches,
  holderPhrase,
  savedBranchName,
  switchDialog,
  workspaceDialog,
  type CheckoutOutcome,
  type SwitchAction,
  type SwitchDialog,
} from "./branchSwitch";
import type * as ipc from "./ipc";

const holder = (over: Partial<ipc.BranchHolder> = {}): ipc.BranchHolder => ({
  branch: "feat/embedded-browser",
  path: "/repo/.claude/worktrees/agent-a17876ad98b03ff64",
  name: "agent-a17876ad98b03ff64",
  agent: true,
  is_main: false,
  dirty: 0,
  locked: null,
  prunable: null,
  head: "abc1234",
  ...over,
});

const worktree = (over: Partial<ipc.WorktreeInfo> = {}): ipc.WorktreeInfo => ({
  path: "/repo/.claude/worktrees/agent-a1",
  name: "agent-a1",
  head: "abc1234",
  branch: "feat/x",
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  is_main: false,
  dirty: 0,
  ...over,
});

const branchWork = (over: Partial<ipc.BranchWork> = {}): ipc.BranchWork => ({
  branch: "feat/x",
  worktree: "/repo/.claude/worktrees/agent-a1",
  is_main: false,
  prunable: false,
  current: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  upstream: null,
  upstream_gone: false,
  merged: false,
  protected: false,
  last_commit: "abc1234",
  age_days: 1,
  subject: "wip",
  author: "sam",
  ...over,
});

const actions = (d: { choices: { action: SwitchAction }[] }) =>
  d.choices.map((c) => c.action);

/** Everything a person actually reads. The small `detail` line is deliberately
 *  excluded — that is where the git term is allowed to teach. */
const primaryText = (d: SwitchDialog) => [
  d.title,
  d.body,
  ...d.choices.flatMap((c) => [c.label, c.sub ?? ""]),
];

describe("switchDialog", () => {
  it("has nothing to ask about a switch that worked", () => {
    expect(switchDialog("feat/x", { kind: "switched", message: "Switched" })).toBeNull();
  });

  it("offers opening it there first when an agent workspace holds the branch", () => {
    const d = switchDialog("feat/embedded-browser", {
      kind: "branch_in_worktree",
      holder: holder(),
    })!;
    expect(d.title).toBe("This branch is busy");
    expect(d.body).toBe(
      "feat/embedded-browser is currently open in an agent workspace.",
    );
    expect(actions(d)).toEqual(["open-there", "move-here", "snapshot", "cancel"]);
    expect(d.choices[0].recommended).toBe(true);
  });

  it("keeps git's vocabulary out of the primary copy", () => {
    const d = switchDialog("feat/x", { kind: "branch_in_worktree", holder: holder() })!;
    const primary = [d.title, d.body, ...d.choices.flatMap((c) => [c.label, c.sub ?? ""])];
    for (const text of primary) {
      expect(text.toLowerCase()).not.toContain("worktree");
      expect(text.toLowerCase()).not.toContain("detached");
      expect(text.toLowerCase()).not.toContain("stash");
    }
  });

  it("says a locked workspace can't hand the branch over, rather than hiding it", () => {
    const d = switchDialog("feat/x", {
      kind: "branch_in_worktree",
      holder: holder({ locked: "agent is running" }),
    })!;
    const move = d.choices.find((c) => c.action === "move-here")!;
    expect(move.disabled).toBe(true);
    expect(move.sub).toContain("locked");
    // The zero-risk paths are still open.
    expect(actions(d)).toContain("open-there");
    expect(actions(d)).toContain("snapshot");
  });

  it("promises the other workspace keeps its unsaved work", () => {
    const d = switchDialog("feat/x", {
      kind: "branch_in_worktree",
      holder: holder({ dirty: 3 }),
    })!;
    expect(d.choices.find((c) => c.action === "move-here")!.sub).toContain(
      "3 unsaved changes",
    );
  });

  it("leads with cleanup when the holding workspace's folder is gone", () => {
    const d = switchDialog("feat/x", {
      kind: "branch_in_worktree",
      holder: holder({ prunable: "gitdir file points to non-existent location" }),
    })!;
    expect(actions(d)).toEqual(["cleanup", "snapshot", "cancel"]);
    expect(d.choices[0].recommended).toBe(true);
  });

  it("offers moving the branch when the project's own main checkout holds it", () => {
    const d = switchDialog("feat/x", {
      kind: "branch_in_worktree",
      holder: holder({ is_main: true, agent: false, path: "/repo", name: "repo" }),
    })!;
    // Nothing to "open there" — that checkout is not a separate workspace.
    expect(actions(d)).toEqual(["move-here", "snapshot", "cancel"]);
    expect(d.body).toContain("this project's main checkout");
  });

  it("counts the files in the way and recommends carrying them", () => {
    const d = switchDialog("feat/x", {
      kind: "local_changes",
      files: ["src/app.ts", "src/index.css"],
      untracked: false,
      detail: "error: Your local changes …",
    })!;
    expect(d.title).toBe("You have unsaved changes to 2 files");
    expect(actions(d)).toEqual(["carry", "cancel"]);
    expect(d.choices[0].recommended).toBe(true);
    expect(d.detail).toContain("src/index.css");
  });

  it("uses the singular for one file", () => {
    const d = switchDialog("feat/x", {
      kind: "local_changes",
      files: ["a.ts"],
      untracked: true,
      detail: "",
    })!;
    expect(d.title).toBe("You have unsaved changes to 1 file");
    expect(d.body).toContain("new files you haven't committed");
  });

  it("says where the changes went when they wouldn't reapply", () => {
    const d = switchDialog("feat/x", {
      kind: "changes_stashed",
      stash: "stash@{0}",
      detail: "CONFLICT (content): Merge conflict in a.ts",
    })!;
    expect(d.body).toContain("nothing is lost");
    expect(d.detail).toContain("stash@{0}");
    expect(actions(d)).toEqual(["cancel"]);
  });

  it("puts a human line above raw git output it doesn't recognise", () => {
    const d = switchDialog("feat/x", {
      kind: "failed",
      summary: "Git couldn't switch to feat/x.",
      detail: "fatal: invalid reference: feat/x",
    })!;
    expect(d.body).toBe("Git couldn't switch to feat/x.");
    expect(d.detail).toBe("fatal: invalid reference: feat/x");
    // Even here there is a way to see the branch rather than a dead end.
    expect(actions(d)).toContain("snapshot");
  });
});

describe("errorDialog", () => {
  it("keeps the thrown text under a sentence a person can read", () => {
    const d = errorDialog("feat/x", new Error("boom"));
    expect(d.title).toBe("Couldn't switch to feat/x");
    expect(d.detail).toContain("boom");
    expect(actions(d)).toEqual(["cancel"]);
  });
});

describe("holderPhrase", () => {
  it("names the kind of workspace without saying worktree", () => {
    expect(holderPhrase(holder())).toBe("an agent workspace");
    expect(holderPhrase(holder({ agent: false }))).toBe("another workspace");
    expect(holderPhrase(holder({ is_main: true }))).toBe("this project's main checkout");
  });
});

describe("heldBranches", () => {
  it("maps a branch to the workspace holding it", () => {
    const held = heldBranches([worktree(), worktree({ branch: "feat/y" })], "/repo");
    expect([...held.keys()].sort()).toEqual(["feat/x", "feat/y"]);
  });

  it("never counts this checkout as holding its own branch", () => {
    const held = heldBranches(
      [worktree({ path: "/repo", branch: "main", is_main: true })],
      "/repo",
    );
    expect(held.size).toBe(0);
  });

  it("ignores detached workspaces — they hold no name", () => {
    expect(heldBranches([worktree({ branch: null, detached: true })], "/repo").size).toBe(0);
  });
});

describe("heldBadge", () => {
  it("tells an agent workspace from one you made", () => {
    expect(heldBadge(worktree()).label).toBe("in agent workspace");
    expect(heldBadge(worktree({ path: "/repo-wt-feature" })).label).toBe(
      "in another workspace",
    );
    expect(heldBadge(worktree({ is_main: true, path: "/other" })).label).toBe(
      "in main checkout",
    );
    expect(heldBadge(worktree({ prunable: "gone" })).label).toBe("workspace missing");
  });

  it("reads a work-audit row the same way, so panels stop writing their own", () => {
    expect(heldBadge(branchWork()).label).toBe("in agent workspace");
    expect(heldBadge(branchWork({ worktree: "/repo-wt-feature" })).label).toBe(
      "in another workspace",
    );
    expect(heldBadge(branchWork({ is_main: true })).label).toBe("in main checkout");
    expect(heldBadge(branchWork({ prunable: true })).label).toBe("workspace missing");
    expect(heldBadge(branchWork()).title).toContain(
      "/repo/.claude/worktrees/agent-a1",
    );
  });
});

// ---------------------------------------------------------------------------
// The refusals git's older wording never covered, and the states it does not
// refuse at all. Each one used to arrive as raw stderr in a toast.

describe("a half-finished operation", () => {
  type Op = Extract<CheckoutOutcome, { kind: "repo_busy" }>["operation"];
  const busy = (operation: Op): CheckoutOutcome => ({
    kind: "repo_busy",
    operation,
    detail: "error: you need to resolve your current index first",
  });

  it("names the unfinished thing in words and offers a way that keeps every file", () => {
    const d = switchDialog("feat/x", busy("merge"))!;
    expect(d.title).toBe("This project is in the middle of something");
    expect(d.body).toBe(
      "There's a merge you haven't finished here, so feat/x can't be opened yet.",
    );
    expect(actions(d)).toEqual(["open-elsewhere", "stop-operation", "cancel"]);
    expect(d.choices[0].recommended).toBe(true);
    // The git-level way out is taught in the small print, not in the choice.
    expect(d.detail).toContain("git merge --quit");
  });

  it("describes a rebase without asking the user to know the word", () => {
    const d = switchDialog("feat/x", busy("rebase"))!;
    expect(d.body).toContain("a replay of your commits you haven't finished");
    expect(d.choices[1].label).toBe("Call off that replay, keep your files");
    expect(d.detail).toContain("git rebase --quit");
  });

  it("turns a lock held by another command into waiting, not into an error", () => {
    const d = switchDialog("feat/x", {
      kind: "repo_busy",
      operation: "another-command",
      detail: "Unable to create '/repo/.git/index.lock': File exists.",
    })!;
    expect(d.body).toBe("Another command is using this project right now.");
    expect(actions(d)).toEqual(["retry", "cancel"]);
    expect(d.choices[0].recommended).toBe(true);
  });
});

describe("a name that isn't here", () => {
  it("leads with looking on GitHub and offers starting it only when it can", () => {
    const d = switchDialog("feat/x", {
      kind: "nothing_called",
      name: "feat/x",
      can_create: true,
      detail: "error: pathspec 'feat/x' did not match any file(s) known to git",
    })!;
    expect(d.title).toBe("There's nothing here called feat/x");
    expect(actions(d)).toEqual(["fetch-retry", "create-here", "cancel"]);
    expect(d.choices[0].recommended).toBe(true);
  });

  it("doesn't offer to start a commit that doesn't exist", () => {
    const d = switchDialog("abc1234", {
      kind: "nothing_called",
      name: "abc1234",
      can_create: false,
      detail: "fatal: invalid reference: abc1234",
    })!;
    expect(actions(d)).toEqual(["fetch-retry", "cancel"]);
  });
});

describe("a name already taken", () => {
  it("offers the branch that's there instead of a snapshot of one that isn't", () => {
    const d = switchDialog("feat/x", {
      kind: "name_taken",
      branch: "feat/x",
      detail: "fatal: a branch named 'feat/x' already exists",
    })!;
    expect(d.title).toBe("There's already a branch called feat/x");
    expect(actions(d)).toEqual(["switch-existing", "cancel"]);
    // Cancel is the "pick another name" way out, not a dead end.
    expect(d.choices[1].label).toBe("Pick another name");
    expect(actions(d)).not.toContain("snapshot");
  });
});

describe("a folder already at that name", () => {
  it("offers the one that's there when it can be used", () => {
    const d = switchDialog("feat/x", {
      kind: "path_in_use",
      path: "/repo-wt-feat-x",
      usable: true,
      detail: "fatal: '/repo-wt-feat-x' already exists",
    })!;
    expect(d.title).toBe("There's already a folder there");
    expect(d.body).toContain("/repo-wt-feat-x");
    expect(actions(d)).toEqual(["reuse-workspace", "cancel"]);
  });

  it("still ends in a way out when it can't be used", () => {
    const d = switchDialog("feat/x", {
      kind: "path_in_use",
      path: "/repo-wt-feat-x",
      usable: false,
      detail: "",
    })!;
    expect(actions(d)).toEqual(["cancel"]);
    expect(d.choices[0].label).toBe("Choose another name");
  });
});

describe("GitHub out of reach", () => {
  it("says the cause the backend worked out and offers another go", () => {
    const d = switchDialog("feat/x", {
      kind: "remote_unreachable",
      summary: "This project has no remote to fetch from.",
      detail: "no git remotes found",
    })!;
    expect(d.body).toBe("This project has no remote to fetch from.");
    expect(actions(d)).toEqual(["retry", "cancel"]);
  });
});

describe("a switch that worked but left commits behind", () => {
  const leftovers = (commits: string[]): CheckoutOutcome => ({
    kind: "switched_with_leftovers",
    message: "Switched to branch 'main'",
    commits,
    detail: "Warning: you are leaving 1 commit behind",
  });

  it("says a commit was left loose and names the branch that would save it", () => {
    const d = switchDialog("main", leftovers(["6ccd544 orphan"]))!;
    expect(d.title).toBe("You're on main — but a commit was left behind");
    expect(d.body).toContain("still here");
    expect(actions(d)).toEqual(["keep-leftovers", "cancel"]);
    expect(d.choices[0].sub).toContain("saved-6ccd544");
    expect(d.choices[0].recommended).toBe(true);
    // Deterministic, so the dialog never needs a text field.
    expect(savedBranchName("6ccd5449a0b known subject")).toBe("saved-6ccd544");
  });

  it("counts more than one", () => {
    const d = switchDialog("main", leftovers(["6ccd544 a", "11aa22b b"]))!;
    expect(d.title).toBe("You're on main — but 2 commits were left behind");
    expect(d.choices[0].label).toBe("Save them to a branch");
  });
});

describe("workspaceDialog", () => {
  it("never offers to move a branch here — a second folder was the request", () => {
    const d = workspaceDialog(
      { branch: "feat/x" },
      { kind: "branch_in_worktree", holder: holder() },
    )!;
    expect(actions(d)).toEqual(["open-there", "cancel"]);
    expect(d.choices[0].label).toBe("Open the workspace that has it");
    expect(d.choices[0].recommended).toBe(true);
    expect(d.choices[1].label).toBe("Choose another name");
  });

  it("offers the pull request's own head when that's what's wanted", () => {
    const d = workspaceDialog(
      { branch: "feat/x", pr: 142 },
      { kind: "branch_in_worktree", holder: holder() },
    )!;
    expect(actions(d)).toEqual(["open-there", "snapshot", "cancel"]);
    expect(d.choices[1].label).toBe("Make one at the pull request's head instead");
  });

  it("has nothing to ask about a workspace that got made", () => {
    expect(
      workspaceDialog({ branch: "feat/x" }, { kind: "switched", message: "ok" }),
    ).toBeNull();
  });

  it("asks every other question exactly as a switch does", () => {
    const out: CheckoutOutcome = {
      kind: "path_in_use",
      path: "/repo-wt-feat-x",
      usable: true,
      detail: "",
    };
    expect(workspaceDialog({ branch: "feat/x" }, out)).toEqual(
      switchDialog("feat/x", out),
    );
  });
});

describe("a locked workspace whose folder is gone", () => {
  it("clears it the hard way — an ordinary tidy-up skips it in silence", () => {
    const d = switchDialog("feat/x", {
      kind: "branch_in_worktree",
      holder: holder({ prunable: "its folder is gone", locked: "agent is running" }),
    })!;
    expect(actions(d)).toEqual(["force-cleanup", "snapshot", "cancel"]);
    expect(d.choices[0].sub).toContain("even though something still claimed it");
    expect(d.choices[0].recommended).toBe(true);
  });
});

describe("askDialog", () => {
  it("renders any other question in the same shape", () => {
    const d = askDialog({
      title: "Remove this workspace?",
      body: "Its folder and everything in it goes.",
      detail: "git worktree remove /repo-wt-x",
      choices: [{ action: "cleanup", label: "Remove it", sub: "3 unsaved changes go with it." }],
    });
    expect(d.title).toBe("Remove this workspace?");
    expect(d.detail).toContain("git worktree remove");
    // A way out is guaranteed even when the caller forgot one.
    expect(actions(d)).toEqual(["cleanup", "cancel"]);
  });

  it("leaves a caller's own way out alone", () => {
    const d = askDialog({
      title: "t",
      body: "b",
      choices: [{ action: "cancel", label: "Never mind" }],
    });
    expect(d.choices).toHaveLength(1);
    expect(d.choices[0].label).toBe("Never mind");
  });
});

describe("the house voice", () => {
  // Every dialog shape this module can produce, not just the original five —
  // new copy is added here rather than written free-hand.
  const everyDialog = (): SwitchDialog[] => {
    const outcomes: CheckoutOutcome[] = [
      { kind: "branch_in_worktree", holder: holder() },
      { kind: "branch_in_worktree", holder: holder({ is_main: true }) },
      { kind: "branch_in_worktree", holder: holder({ locked: "agent is running" }) },
      { kind: "branch_in_worktree", holder: holder({ prunable: "gone" }) },
      {
        kind: "branch_in_worktree",
        holder: holder({ prunable: "gone", locked: "agent is running" }),
      },
      { kind: "local_changes", files: ["a.ts"], untracked: true, detail: "raw" },
      { kind: "changes_stashed", stash: "stash@{0}", detail: "raw" },
      { kind: "failed", summary: "Git couldn't switch to feat/x.", detail: "raw" },
      { kind: "repo_busy", operation: "merge", detail: "raw" },
      { kind: "repo_busy", operation: "rebase", detail: "raw" },
      { kind: "repo_busy", operation: "cherry-pick", detail: "raw" },
      { kind: "repo_busy", operation: "revert", detail: "raw" },
      { kind: "repo_busy", operation: "am", detail: "raw" },
      { kind: "repo_busy", operation: "another-command", detail: "raw" },
      { kind: "nothing_called", name: "feat/x", can_create: true, detail: "raw" },
      { kind: "nothing_called", name: "feat/x", can_create: false, detail: "raw" },
      { kind: "name_taken", branch: "feat/x", detail: "raw" },
      { kind: "path_in_use", path: "/repo-wt-feat-x", usable: true, detail: "raw" },
      { kind: "path_in_use", path: "/repo-wt-feat-x", usable: false, detail: "raw" },
      {
        kind: "remote_unreachable",
        summary: "Canopy couldn't reach GitHub with the sign-in it has.",
        detail: "raw",
      },
      {
        kind: "switched_with_leftovers",
        message: "Switched to branch 'main'",
        commits: ["6ccd544 orphan"],
        detail: "raw",
      },
    ];
    const dialogs: SwitchDialog[] = [errorDialog("feat/x", new Error("boom"))];
    for (const out of outcomes) {
      const a = switchDialog("feat/x", out);
      if (a) dialogs.push(a);
      const b = workspaceDialog({ branch: "feat/x", pr: 142 }, out);
      if (b) dialogs.push(b);
    }
    return dialogs;
  };

  it("keeps git's vocabulary out of every primary line, in every dialog", () => {
    for (const d of everyDialog())
      for (const text of primaryText(d)) {
        expect(text.toLowerCase()).not.toContain("worktree");
        expect(text.toLowerCase()).not.toContain("detached");
        expect(text.toLowerCase()).not.toContain("stash");
      }
  });

  it("never dead-ends: every dialog ends in an action a click can take", () => {
    for (const d of everyDialog()) {
      const live = d.choices.filter((c) => !c.disabled);
      expect(live.length).toBeGreaterThan(0);
      expect(actions(d)).toContain("cancel");
      // Nothing is offered without saying what it is.
      for (const c of d.choices) expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("answers every outcome the backend can send", () => {
    // A compile-time link, not a runtime one: if `ipc.CheckoutOutcome` gains a
    // kind this module has no dialog for, this line stops building.
    const answerable = (o: ipc.CheckoutOutcome) => switchDialog("feat/x", o);
    expect(answerable({ kind: "switched", message: "ok" })).toBeNull();
  });
});

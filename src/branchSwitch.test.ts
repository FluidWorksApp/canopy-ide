import { describe, expect, it } from "vitest";
import {
  errorDialog,
  heldBadge,
  heldBranches,
  holderPhrase,
  switchDialog,
  type SwitchAction,
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

const actions = (d: { choices: { action: SwitchAction }[] }) =>
  d.choices.map((c) => c.action);

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
});

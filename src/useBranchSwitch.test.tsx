// The funnel used to be a private closure inside GitPanel with no test at all —
// which is exactly why it could be moved, and exactly why it must be pinned now
// that every surface depends on it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as ipc from "./ipc";
import {
  attentionItems,
  clearAttentionHistory,
  outstandingQuestions,
} from "./attention";
import {
  BranchSwitchProvider,
  useBranchSwitch,
  type BranchSwitch,
  type SwitchResult,
} from "./useBranchSwitch";

vi.mock("./ipc", () => ({
  gitCheckout: vi.fn(),
  gitCheckoutDetached: vi.fn(),
  gitCheckoutCarry: vi.fn(),
  gitBranchRelease: vi.fn(),
  gitWorktrees: vi.fn(),
  gitWorktreeAdd: vi.fn(),
  gitWorktreeAddPr: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  gitWorktreePrune: vi.fn(),
  workspaceAdd: vi.fn(),
  gitFetch: vi.fn(),
  ghPrCheckout: vi.fn(),
  gitOperationQuit: vi.fn(),
  gitBranchAt: vi.fn(),
}));

const holder = (over: Partial<ipc.BranchHolder> = {}): ipc.BranchHolder => ({
  branch: "feat/x",
  path: "/repo/.claude/worktrees/agent-a1",
  name: "agent-a1",
  agent: true,
  is_main: false,
  dirty: 0,
  locked: null,
  prunable: null,
  head: "abc1234",
  ...over,
});

let api: BranchSwitch;

function Grab() {
  api = useBranchSwitch();
  return null;
}

function mount(opts: { projectId?: string; projectName?: string; visible?: boolean } = {}) {
  const onNotice = vi.fn();
  const onUseWorktree = vi.fn();
  const tree = (o: typeof opts) => (
    <BranchSwitchProvider
      onNotice={onNotice}
      onUseWorktree={onUseWorktree}
      projectId={o.projectId}
      projectName={o.projectName}
      visible={o.visible}
    >
      <Grab />
    </BranchSwitchProvider>
  );
  const r = render(tree(opts));
  return {
    onNotice,
    onUseWorktree,
    /** Change what the provider is told about its project — becoming the tab on
     *  screen, or ceasing to be. */
    show: (visible: boolean) => act(() => r.rerender(tree({ ...opts, visible }))),
    unmount: () => act(() => r.unmount()),
  };
}

/** Start a switch and let it get as far as its first question. It deliberately
 *  does not resolve until that question is answered, so it is never awaited. */
async function begin(run: () => Promise<SwitchResult>) {
  const box: { result?: SwitchResult } = {};
  await act(async () => {
    void run().then((r) => {
      box.result = r;
    });
  });
  return box;
}

const click = async (label: string) => {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  clearAttentionHistory();
  vi.mocked(ipc.workspaceAdd).mockResolvedValue(undefined as never);
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([]);
});

describe("a switch that just works", () => {
  it("settles where you asked, with no question on screen", async () => {
    const { onNotice } = mount();
    vi.mocked(ipc.gitCheckout).mockResolvedValue({
      kind: "switched",
      message: "Switched to feat/x",
    });

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "branch", branch: "feat/x" }),
    );

    expect(box.result).toEqual({
      kind: "settled",
      path: "/repo",
      branch: "feat/x",
      detached: false,
      created: false,
      message: "Switched to feat/x",
    });
    expect(screen.queryByText("This branch is busy")).toBeNull();
    expect(onNotice).toHaveBeenCalledWith("Switched to feat/x", "success");
  });

  it("keeps quiet when the caller says it will post its own", async () => {
    const { onNotice } = mount();
    vi.mocked(ipc.gitCheckout).mockResolvedValue({ kind: "switched", message: "ok" });
    await begin(() =>
      api.switchTo("/repo", { kind: "branch", branch: "feat/x" }, { quiet: true }),
    );
    expect(onNotice).not.toHaveBeenCalled();
  });
});

describe("a switch git refuses", () => {
  it("asks, and 'open it there' settles on the workspace that has it", async () => {
    const { onUseWorktree, onNotice } = mount();
    vi.mocked(ipc.gitCheckout).mockResolvedValue({
      kind: "branch_in_worktree",
      holder: holder(),
    });

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "branch", branch: "feat/x" }),
    );
    expect(screen.getByText("This branch is busy")).toBeTruthy();
    expect(box.result).toBeUndefined();

    await click("Open it there");

    expect(onUseWorktree).toHaveBeenCalledWith(
      "/repo",
      "/repo/.claude/worktrees/agent-a1",
      "feat/x",
    );
    expect(box.result).toEqual({
      kind: "settled",
      path: "/repo/.claude/worktrees/agent-a1",
      branch: "feat/x",
      detached: false,
      created: false,
      message: "Opened agent-a1.",
    });
    // The redirection used to be entirely silent.
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining("Your own checkout hasn't moved"),
      "success",
    );
    expect(screen.queryByText("This branch is busy")).toBeNull();
  });

  it("runs one explicit operation per choice, and asks again if that is refused too", async () => {
    mount();
    vi.mocked(ipc.gitBranchRelease).mockResolvedValue({
      kind: "switched",
      message: "feat/x is free",
    });
    vi.mocked(ipc.gitCheckout).mockResolvedValue({
      kind: "branch_in_worktree",
      holder: holder(),
    });

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "branch", branch: "feat/x" }),
    );
    await click("Move the branch here");

    expect(ipc.gitBranchRelease).toHaveBeenCalledWith("/repo", "feat/x");
    expect(ipc.gitCheckout).toHaveBeenCalledTimes(2);
    // A second refusal is a second question, not a dead end.
    expect(screen.getByText("This branch is busy")).toBeTruthy();
    expect(box.result).toBeUndefined();

    await click("Cancel");
    expect(box.result).toEqual({ kind: "cancelled" });
  });

  it("carries a pull request's changes through gh, not through the branch", async () => {
    mount();
    const gh = vi.mocked(ipc.ghPrCheckout);
    gh.mockResolvedValueOnce({
      kind: "local_changes",
      files: ["a.ts"],
      untracked: false,
      detail: "",
    });
    gh.mockResolvedValueOnce({ kind: "switched", message: "Switched to feat/x" });

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "pr", number: 142, branch: "feat/x" }),
    );
    await click("Carry them over safely");

    // A fork's branch may not exist locally at all, so the branch-shaped carry
    // would be switching to nothing.
    expect(ipc.gitCheckoutCarry).not.toHaveBeenCalled();
    expect(gh).toHaveBeenLastCalledWith("/repo", 142, true);
    expect(box.result).toMatchObject({ kind: "settled", path: "/repo" });
  });
});

describe("git that wouldn't run at all", () => {
  it("shows the last-resort dialog and refuses without the caller reporting it again", async () => {
    mount();
    vi.mocked(ipc.gitCheckout).mockRejectedValue(new Error("boom"));

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "branch", branch: "feat/x" }),
    );
    expect(screen.getByText("Couldn't switch to feat/x")).toBeTruthy();
    expect(box.result).toBeUndefined();

    await click("Close");
    expect(box.result).toEqual({ kind: "refused", detail: "Error: boom" });
  });
});

describe("two things asking at once", () => {
  it("never steals a question the user is mid-answer on", async () => {
    const { onNotice } = mount();
    vi.mocked(ipc.gitCheckout).mockResolvedValue({
      kind: "branch_in_worktree",
      holder: holder(),
    });

    const first = await begin(() =>
      api.switchTo("/repo", { kind: "branch", branch: "feat/x" }),
    );
    expect(screen.getByText("This branch is busy")).toBeTruthy();

    const second = await begin(() =>
      api.switchTo(
        "/repo",
        { kind: "workspace", branch: "feat/y" },
        { because: "The review loop" },
      ),
    );

    expect(second.result).toEqual({ kind: "cancelled" });
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining("The review loop"),
      "info",
    );
    // The first question is untouched, and nothing ran for the second.
    expect(screen.getByText("This branch is busy")).toBeTruthy();
    expect(ipc.gitWorktreeAdd).not.toHaveBeenCalled();
    expect(first.result).toBeUndefined();

    await click("Cancel");
    expect(first.result).toEqual({ kind: "cancelled" });
  });
});

describe("a workspace of its own", () => {
  it("reuses one already holding the branch rather than stacking another", async () => {
    mount();
    vi.mocked(ipc.gitWorktrees).mockResolvedValue([
      {
        path: "/repo-wt-feat-x",
        name: "repo-wt-feat-x",
        head: "abc1234",
        branch: "feat/x",
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
        is_main: false,
        dirty: 0,
      },
    ]);

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "workspace", branch: "feat/x" }),
    );
    expect(ipc.gitWorktreeAdd).not.toHaveBeenCalled();
    expect(box.result).toMatchObject({
      kind: "settled",
      path: "/repo-wt-feat-x",
      created: false,
    });
  });

  it("puts a new one beside the repo and registers it, saying it created it", async () => {
    mount();
    vi.mocked(ipc.gitWorktreeAdd).mockResolvedValue({
      kind: "switched",
      message: "Preparing worktree",
    });

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "workspace", branch: "feat/x", create: true }),
    );
    expect(ipc.gitWorktreeAdd).toHaveBeenCalledWith(
      "/repo",
      "/repo-wt-feat-x",
      "feat/x",
      true,
    );
    expect(ipc.workspaceAdd).toHaveBeenCalledWith("/repo-wt-feat-x");
    expect(box.result).toMatchObject({
      kind: "settled",
      path: "/repo-wt-feat-x",
      created: true,
    });
  });

  it("never claims a pull request's workspace has the branch checked out", async () => {
    mount();
    vi.mocked(ipc.gitWorktreeAddPr).mockResolvedValue({
      kind: "switched",
      message: "Preparing worktree",
    });

    const box = await begin(() =>
      api.switchTo("/repo", { kind: "pr-workspace", number: 177, branch: "feat/x" }),
    );
    expect(ipc.gitWorktreeAddPr).toHaveBeenCalledWith(
      "/repo",
      "/repo-wt-pr-177",
      177,
      "feat/x",
    );
    expect(box.result).toMatchObject({ detached: true, branch: null });
  });
});

describe("clearing the workspaces whose folders are gone", () => {
  it("asks when git keeps one, and 'try again' runs the same clear-up again", async () => {
    const { onNotice } = mount();
    const prune = vi.mocked(ipc.gitWorktreePrune);
    prune.mockRejectedValueOnce(new Error("fatal: cannot prune 'agent-a1'"));
    prune.mockResolvedValueOnce("Removing worktrees/agent-a1");

    const box: { done?: boolean } = {};
    await act(async () => {
      void api.cleanupWorkspaces("/repo").then(() => {
        box.done = true;
      });
    });

    // A refusal here used to be git's stderr in a toast, from a button that
    // could not answer it.
    expect(screen.getByText("Couldn't clear the missing workspaces")).toBeTruthy();
    expect(box.done).toBeUndefined();

    await click("Try again");

    expect(prune).toHaveBeenCalledTimes(2);
    expect(onNotice).toHaveBeenCalledWith("Removing worktrees/agent-a1", "success");
    expect(box.done).toBe(true);
    expect(screen.queryByText("Couldn't clear the missing workspaces")).toBeNull();
  });
});

describe("a switch that worked but left commits behind", () => {
  it("saves them where you are, without moving you off it", async () => {
    const { onNotice } = mount();
    vi.mocked(ipc.gitCheckout).mockResolvedValue({
      kind: "switched_with_leftovers",
      message: "Switched to main",
      commits: ["6ccd544 orphan"],
      detail: "raw",
    });
    vi.mocked(ipc.gitBranchAt).mockResolvedValue("Saved as saved-6ccd544");
    const box = await begin(() =>
      api.switchTo("/repo", { kind: "branch", branch: "main" }),
    );
    await click("Save it to a branch");
    // `git branch <name> <sha>`, not a second checkout: the switch just
    // asked for must survive the rescue.
    expect(ipc.gitBranchAt).toHaveBeenCalledWith("/repo", "saved-6ccd544", "6ccd544");
    expect(box.result).toMatchObject({ kind: "settled", branch: "main" });
    expect(onNotice).toHaveBeenCalledWith("Saved as saved-6ccd544.", "success");
  });
});

describe("a name nothing here answers to", () => {
  it("turns 'start it here' into a branch, not a second look at nothing", async () => {
    mount();
    vi.mocked(ipc.gitCheckoutDetached).mockResolvedValue({
      kind: "nothing_called",
      name: "feat/x",
      can_create: true,
      detail: "raw",
    });
    vi.mocked(ipc.gitCheckout).mockResolvedValue({
      kind: "switched",
      message: "Switched to feat/x",
    });
    const box = await begin(() =>
      api.switchTo("/repo", { kind: "ref", ref: "feat/x", label: "feat/x" }),
    );
    await click("Start it here instead");
    expect(ipc.gitCheckout).toHaveBeenCalledWith("/repo", "feat/x", true);
    expect(box.result).toMatchObject({ kind: "settled", detached: false });
  });
});

describe("ask", () => {
  it("puts any other question in the same single dialog", async () => {
    mount();
    const box: { action?: string } = {};
    await act(async () => {
      void api
        .ask({
          title: "Remove this workspace?",
          body: "Its folder and everything in it goes.",
          choices: [
            { action: "cleanup", label: "Remove it" },
            { action: "cancel", label: "Keep it" },
          ],
        })
        .then((a) => {
          box.action = a;
        });
    });
    expect(screen.getByText("Remove this workspace?")).toBeTruthy();
    await click("Remove it");
    expect(box.action).toBe("cleanup");
    expect(screen.queryByText("Remove this workspace?")).toBeNull();
  });
});

/** The case issue #212 opens with. The dialog stays scoped to its project on
 *  purpose, so a project that is mounted but off screen asks into nothing —
 *  and, because the funnel refuses to stack a second question over a pending
 *  one, every later switch there returns `cancelled` with no symptom. What
 *  moves is the question, not the dialog. */
describe("a question raised in a project you are not looking at", () => {
  const busy = () =>
    vi.mocked(ipc.gitCheckout).mockResolvedValue({
      kind: "branch_in_worktree",
      holder: holder(),
    });

  const waiting = () => outstandingQuestions(attentionItems());

  it("posts a question naming the project, linked back to it", async () => {
    busy();
    mount({ projectId: "p1", projectName: "canopy", visible: false });
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));

    expect(waiting()).toHaveLength(1);
    expect(waiting()[0]).toMatchObject({
      kind: "question",
      // The dialog's own words, so the notification says what is being asked
      // rather than that something is.
      title: "This branch is busy",
      source: "project",
      projectId: "p1",
      projectName: "canopy",
      where: { kind: "project", projectId: "p1" },
    });
    expect(waiting()[0].body).toContain("canopy");
  });

  it("says nothing while you are looking at the project", async () => {
    busy();
    mount({ projectId: "p1", projectName: "canopy", visible: true });
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));

    expect(screen.getByText("This branch is busy")).toBeTruthy();
    expect(waiting()).toHaveLength(0);
  });

  it("announces a question you left open and tabbed away from", async () => {
    busy();
    const p = mount({ projectId: "p1", projectName: "canopy", visible: true });
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));
    expect(waiting()).toHaveLength(0);

    await p.show(false);
    expect(waiting()).toHaveLength(1);
  });

  it("keeps one question however often you come and go", async () => {
    busy();
    const p = mount({ projectId: "p1", projectName: "canopy", visible: false });
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));

    // Returning does not retire it: something is still waiting on you until
    // the dialog closes, and the count has to keep saying so.
    await p.show(true);
    expect(waiting()).toHaveLength(1);
    await p.show(false);
    expect(waiting()).toHaveLength(1);
  });

  it("stops waiting once the dialog is answered", async () => {
    busy();
    const p = mount({ projectId: "p1", projectName: "canopy", visible: false });
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));
    expect(waiting()).toHaveLength(1);

    await p.show(true);
    await click("Open it there");

    expect(waiting()).toHaveLength(0);
    expect(attentionItems()[0].resolution).toBe("answered");
  });

  it("counts a cancel as answered — you did decide", async () => {
    busy();
    mount({ projectId: "p1", projectName: "canopy", visible: false });
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));

    await click("Cancel");

    expect(waiting()).toHaveLength(0);
    expect(attentionItems()[0].resolution).toBe("answered");
  });

  it("withdraws when the project closes, rather than stranding it", async () => {
    busy();
    const p = mount({ projectId: "p1", projectName: "canopy", visible: false });
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));
    expect(waiting()).toHaveLength(1);

    // Nothing can answer it now — and an outstanding question nobody can
    // resolve sits in the waiting count for good.
    p.unmount();

    expect(waiting()).toHaveLength(0);
    expect(attentionItems()[0].resolution).toBe("withdrawn");
  });

  it("still works with no project — the dialog is the point, the notice is extra", async () => {
    busy();
    mount();
    await begin(() => api.switchTo("/repo", { kind: "branch", branch: "feat/x" }));

    expect(screen.getByText("This branch is busy")).toBeTruthy();
    expect(waiting()).toHaveLength(0);
  });
});

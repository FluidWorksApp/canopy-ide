// @vitest-environment jsdom
//
// The prune screen's claim: everything the repo is holding is on it, the safe
// pile is already ticked, and nothing that exists only here gets ticked for
// you. The rules themselves are covered in prune.test.ts — these cover the
// wiring, which is where a correct rule still ends up deleting the wrong thing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PruneDialog } from "./PruneDialog";
import * as ipc from "../ipc";
import type * as ipcTypes from "../ipc";

vi.mock("../ipc", () => ({
  gitWorkAudit: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  gitBranchDelete: vi.fn(),
  gitBranchDeleteRemote: vi.fn(),
  workspaceRemove: vi.fn(),
}));

vi.mock("../workspaces", () => ({ releaseLease: vi.fn() }));

const work = (
  over: Partial<ipcTypes.BranchWork> & { branch: string },
): ipcTypes.BranchWork => ({
  worktree: null,
  is_main: false,
  prunable: false,
  current: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  upstream: "origin/x",
  upstream_gone: false,
  merged: false,
  protected: false,
  last_commit: "1700000000",
  age_days: 5,
  subject: "a commit",
  author: "someone",
  ...over,
});

const AUDIT: ipcTypes.WorkAudit = {
  base: "origin/main",
  counts_degraded: false,
  items: [
    work({ branch: "main", protected: true, merged: true, current: true }),
    work({ branch: "feat/landed", merged: true, worktree: "/w/landed", age_days: 30 }),
    work({ branch: "feat/squashed", upstream_gone: true, age_days: 20 }),
    work({ branch: "feat/open", age_days: 2 }),
    work({ branch: "feat/unpushed", ahead: 3, upstream: null, age_days: 60 }),
    work({ branch: "feat/dirty", worktree: "/w/dirty", dirty: 2, merged: true }),
    work({ branch: "feat/live", worktree: "/w/live", merged: true, age_days: 40 }),
  ],
};

const onNotice = vi.fn();
const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.gitWorkAudit).mockResolvedValue(AUDIT);
  vi.mocked(ipc.gitWorktreeRemove).mockResolvedValue("");
  vi.mocked(ipc.gitBranchDelete).mockResolvedValue("");
  vi.mocked(ipc.gitBranchDeleteRemote).mockResolvedValue("");
  vi.mocked(ipc.workspaceRemove).mockResolvedValue(undefined as never);
});

const open = () =>
  render(
    <PruneDialog
      open
      repo="/repo"
      busy={["/w/live/app"]}
      onNotice={onNotice}
      onChanged={onChanged}
      onClose={() => {}}
    />,
  );

/** The row a branch name sits on — the label carrying its checkbox. */
const row = (branch: string) =>
  screen.getByText(branch).closest("label") as HTMLLabelElement;
const box = (branch: string) => row(branch).querySelector("input") as HTMLInputElement;

describe("PruneDialog", () => {
  it("ticks the disposable pile and leaves everything else alone", async () => {
    open();
    // Two safe branches: merged, and remote-gone. The third merged one has a
    // live agent in its folder, so it is listed and not ticked.
    await screen.findByText("Prune 2");
    expect(box("feat/landed").checked).toBe(true);
    expect(box("feat/squashed").checked).toBe(true);
    expect(box("feat/live").checked).toBe(false);
    expect(box("feat/open").checked).toBe(false);
    expect(box("feat/unpushed").checked).toBe(false);
    expect(box("feat/dirty").checked).toBe(false);
  });

  it("says what it will and won't cost", async () => {
    open();
    await screen.findByText(
      "2 branches, 1 workspace go. Nothing is lost — every one of them is already on origin/main or on the remote.",
    );
  });

  it("lists what it will never touch, with the reason", async () => {
    open();
    await screen.findByText("Never offered");
    expect(box("main").disabled).toBe(true);
    expect(screen.getByText("the base branch — never pruned")).toBeTruthy();
  });

  it("names the workspace something is running in without blocking it", async () => {
    open();
    await screen.findByText("Prune 2");
    expect(row("feat/live").textContent).toContain("in use");
    expect(box("feat/live").disabled).toBe(false);
  });

  it("removes each folder before its branch, and touches nothing else", async () => {
    open();
    fireEvent.click(await screen.findByText("Prune 2"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(ipc.gitWorktreeRemove).toHaveBeenCalledTimes(1);
    expect(ipc.gitWorktreeRemove).toHaveBeenCalledWith("/repo", "/w/landed", 0);
    expect(vi.mocked(ipc.gitBranchDelete).mock.calls).toEqual([
      ["/repo", "feat/landed", true],
      ["/repo", "feat/squashed", true],
    ]);
    // Off by default and never part of a preset: the local prune is yours, the
    // remote one is everybody's.
    expect(ipc.gitBranchDeleteRemote).not.toHaveBeenCalled();
  });

  it("deletes the remote copies only when that is switched on", async () => {
    open();
    await screen.findByText("Prune 2");
    fireEvent.click(screen.getByText("Also delete them on origin"));
    fireEvent.click(screen.getByText("Prune 2"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // feat/squashed has no remote branch left, so only the one with an upstream.
    expect(vi.mocked(ipc.gitBranchDeleteRemote).mock.calls).toEqual([
      ["/repo", "feat/landed"],
    ]);
  });

  it("forces past uncommitted files only for a row that was ticked by hand", async () => {
    open();
    await screen.findByText("Prune 2");
    fireEvent.click(box("feat/dirty"));
    const button = await screen.findByText("Prune 3");
    // The cost is restated before the click, not after it.
    expect(
      screen.getByText(
        "3 branches, 2 workspaces go. 2 uncommitted files go with them, and exist nowhere else afterwards.",
      ),
    ).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(ipc.gitWorktreeRemove).toHaveBeenCalledWith("/repo", "/w/dirty", 1);
  });

  it("keeps a refusal on screen, ticked, with git's reason in words", async () => {
    vi.mocked(ipc.gitBranchDelete).mockImplementation(async (_r, b) => {
      if (b === "feat/squashed")
        throw new Error("error: the branch is checked out at '/w/elsewhere'");
      return "";
    });
    open();
    fireEvent.click(await screen.findByText("Prune 2"));
    await screen.findByText("Pruned 1 branch. 1 was left alone — each one says why below.");
    expect(screen.getByText("it's open in elsewhere")).toBeTruthy();
    // Left ticked, because it is what there is still to deal with.
    expect(box("feat/squashed").checked).toBe(true);
  });

  it("presets pick by kind, and never reach anything that would lose work", async () => {
    open();
    await screen.findByText("Prune 2");
    fireEvent.click(screen.getByText("Untouched 30d"));
    // Only feat/landed. The 60-day unpushed branch and the 40-day one with an
    // agent in it are both old enough for the rule and both refused by it, and
    // the 20-day squashed one drops out for being too recent.
    await screen.findByText("Prune 1");
    expect(box("feat/landed").checked).toBe(true);
    expect(box("feat/squashed").checked).toBe(false);
    expect(box("feat/unpushed").checked).toBe(false);
    expect(box("feat/live").checked).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "None" }));
    await screen.findByText("Nothing selected.");
    expect(screen.getByRole("button", { name: "Prune" })).toBeTruthy();
  });

  it("owns up to a selection the filter is hiding", async () => {
    open();
    await screen.findByText("Prune 2");
    fireEvent.change(screen.getByPlaceholderText("Filter branches…"), {
      target: { value: "landed" },
    });
    // Still two ticked; one of them is off screen, and the list says so rather
    // than letting the count go unaccountable.
    await screen.findByText("Prune 2");
    expect(
      screen.getByText(/1 selected branch is hidden by the filter/),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Show everything"));
    await waitFor(() => expect(screen.queryByText(/hidden by the filter/)).toBeNull());
  });
});

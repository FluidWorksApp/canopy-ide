// Native git management for a project's repos: branch switching, staging,
// commit, sync with the remote, and pull requests. Everything runs through the
// system `git`/`gh` in the Rust core — the same tools the user's terminal uses,
// so hooks, credential helpers and SSH config all behave identically.
import { useCallback, useEffect, useMemo, useState } from "react";
import { askDialog, heldBadge, heldBranches } from "../branchSwitch";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { useBranchSwitch } from "../useBranchSwitch";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { RestartIcon } from "./icons";
import { LooseEnds } from "./LooseEnds";

/** `askDialog` speaks the switch dialog's vocabulary of actions, which has no
 *  generic "yes" — it never needed one. These two stand in for it. The ids are
 *  internal (only labels are ever seen) and every question below offers each at
 *  most once, so the answer still comes back unambiguous. */
const YES = "cleanup" as const;
const YES_ANYWAY = "force-cleanup" as const;

interface GitPanelProps {
  /** False while another side tab is in front. The panel stays mounted (so
   *  your section, commit message draft and scroll survive a switch away) but
   *  stops polling git — nobody is looking. */
  visible: boolean;
  components: { label: string; path: string }[];
  /** Open a file's diff in the main area. */
  /** Open a pull request in the main area. */
  /** Open a branch's work in the main area. */
  onOpenBranch: (repo: string, branch: ipc.BranchWork) => void;
  /** Open a commit in the main area. */
  onOpenCommit: (
    repo: string,
    commit: { hash: string; short: string; subject: string },
  ) => void;
  /** Open a terminal in a directory (used to work inside a worktree). */
  onOpenTerminal: (cwd: string, label: string) => void;
  /** Worktree currently backing the project's files, if any. */
  activeWorktree: string | null;
  onNotice: Notify;
  /** One-shot agent jobs off the context menus: push a branch and open its PR;
   *  review a PR and post the findings. The agent reports and its terminal
   *  closes itself. */
  /** The "Tasks ▸" submenu for a right-clicked branch or PR, built by the
   *  owner (it knows the task registry). Omitted where tasks don't apply. */
  branchTaskMenu?: (
    repo: string,
    branch: string,
    worktree: string | null,
    merged: boolean,
  ) => MenuItem;
}

type Section = "branches" | "worktrees" | "loose" | "history";



export function GitPanel({
  visible,
  components,
  onOpenCommit,
  onOpenBranch,
  onOpenTerminal,
  activeWorktree,
  onNotice,
  branchTaskMenu,
}: GitPanelProps) {
  const [repos, setRepos] = useState<ipc.RepoInfo[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [status, setStatus] = useState<ipc.RepoStatus | null>(null);
  const [branches, setBranches] = useState<ipc.BranchInfo[]>([]);
  const [log, setLog] = useState<ipc.CommitInfo[]>([]);
  const [worktrees, setWorktrees] = useState<ipc.WorktreeInfo[]>([]);
  const [wtBranch, setWtBranch] = useState("");
  const [section, setSection] = useState<Section>("branches");
  const [busy, setBusy] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  // Every switch, and every question that isn't one, goes through the one
  // funnel mounted above this panel — so a refusal is answerable from here
  // whether or not this panel is the surface still on screen.
  const { switchTo, openThere, cleanupWorkspaces, ask, version } = useBranchSwitch();
  const ctx = useContextMenu();

  const key = components.map((c) => c.path).join("\n");

  // Discover the repos backing this project. Several components often share one
  // repo (monorepo), so this is grouped rather than one entry per component.
  useEffect(() => {
    void ipc
      .gitRepos(components.map((c) => [c.label, c.path] as [string, string]))
      .then((r) => {
        setRepos(r);
        setRepo((cur) => (cur && r.some((x) => x.path === cur) ? cur : (r[0]?.path ?? null)));
      })
      .catch(() => setRepos([]));
  }, [key]);

  const refresh = useCallback(async () => {
    if (!repo) return;
    await Promise.all([
      ipc.gitRepoStatus(repo).then(setStatus).catch(() => setStatus(null)),
      ipc.gitBranches(repo).then(setBranches).catch(() => setBranches([])),
      ipc.gitLog(repo, 40).then(setLog).catch(() => setLog([])),
    ]);
  }, [repo]);

  // Keep status live against edits made by agents in the terminals — while the
  // panel is actually in front. Coming back re-runs this, so what you see is
  // never the state from whenever you last looked. `version` is the funnel
  // saying something moved: a switch answered in its dialog lands here without
  // the funnel having to know this panel exists.
  useEffect(() => {
    if (!repo || !visible) return;
    void refresh();
    const sub = ipc.onFsChange(() => void refresh());
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(poll);
      void sub.then((fn) => fn());
    };
  }, [repo, refresh, visible, version]);

  /** Something that wasn't a switch wouldn't run — a fetch, a delete, a prune.
   *  It still ends in the same dialog rather than a toast of raw stderr: git's
   *  own words folded away, one thing to click. `what` completes "Couldn't …". */
  const failed = useCallback(
    async (what: string, err: unknown) => {
      await ask(
        askDialog({
          title: `Couldn't ${what}`,
          body: "Git wouldn't do that just now. The details below are its own.",
          detail: String(err),
          choices: [{ action: "cancel", label: "Close" }],
        }),
      );
    },
    [ask],
  );

  // Worktrees are loaded on demand, never polled: listing them costs one
  // `git status` per worktree to get dirty counts, and a repo can easily have
  // 20+ agent worktrees — polling that every few seconds would spawn a storm
  // of git processes for a panel nobody is looking at.
  const loadWorktrees = useCallback(
    async (quiet = false) => {
      if (!repo) return;
      if (!quiet) setBusy("worktrees");
      try {
        setWorktrees(await ipc.gitWorktrees(repo));
      } catch (err) {
        if (!quiet) void failed("list the workspaces", err);
      } finally {
        if (!quiet) setBusy(null);
      }
    },
    [repo, failed],
  );

  // The branches list wants them too — a branch another workspace holds is
  // badged as such, so the conflict is visible before the click. Same one-shot
  // load, quietly: the badge is decoration, not the reason you're here.
  useEffect(() => {
    if (section === "worktrees") void loadWorktrees();
    else if (section === "branches") void loadWorktrees(true);
  }, [section, loadWorktrees, version]);

  const held = useMemo(() => heldBranches(worktrees, repo), [worktrees, repo]);

  /** Run a git action, surface its real output, and refresh. Used for the
   *  heavier, less frequent operations (sync, delete, prune) where the user is
   *  waiting on the result anyway. Switches don't come through here — they have
   *  the funnel, which can ask about a refusal rather than only report it. */
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    let failure: unknown = null;
    try {
      const out = await fn();
      // git's own first line of output — a result, not a fault.
      if (typeof out === "string" && out.trim())
        onNotice(out.trim().split("\n")[0], "success");
      await refresh();
    } catch (err) {
      failure = err;
    }
    // Let go of the spinner before the question: nothing is running while the
    // user reads it.
    setBusy(null);
    if (failure) await failed(label, failure);
  };

  /** Removing a workspace, asked once for the two places that offer it. The
   *  folder goes; nothing that was committed in it does. */
  const askRemoveWorktree = async (w: ipc.WorktreeInfo) => {
    if (!repo) return;
    const dirty =
      w.dirty > 0
        ? ` It has ${w.dirty} uncommitted change${
            w.dirty === 1 ? "" : "s"
          } that exist nowhere else.`
        : "";
    const go = await ask(
      askDialog({
        title: "Remove this workspace?",
        body: w.prunable
          ? // Its folder is already gone; only the claim on the branch is left.
            `${w.path} is already gone from disk — this drops what still claims it.`
          : `The folder ${w.path} is deleted.${dirty}`,
        // `force` counts rather than toggles, and a claimed workspace is the
        // one case git insists on being told twice.
        detail: `git worktree remove${w.locked ? " --force --force" : w.dirty > 0 ? " --force" : ""} ${w.path}${
          w.locked ? `\nlocked: ${w.locked}` : ""
        }`,
        choices: [
          {
            action: YES,
            label: "Remove it",
            sub:
              w.dirty > 0
                ? "Those changes go with it. This cannot be undone."
                : "Branches and commits stay; only the folder goes.",
          },
          { action: "cancel", label: "Keep it", recommended: true },
        ],
      }),
    );
    if (go !== YES) return;
    const force: 0 | 1 | 2 = w.locked ? 2 : w.dirty > 0 ? 1 : 0;
    await act("remove workspace", async () => {
      const r = await ipc.gitWorktreeRemove(repo, w.path, force);
      await ipc.workspaceRemove(w.path).catch(() => {});
      await loadWorktrees();
      return r;
    });
  };

  /** The heavier of the two branch deletes, offered from two places: chosen
   *  outright, or as the way through when the safe one is refused. */
  const forceDeleteDialog = (name: string, detail?: string) =>
    askDialog({
      title: `${name} has work of its own`,
      body: "Deleting it drops commits that are on no other branch. Nothing here can bring them back.",
      detail,
      choices: [
        {
          action: YES_ANYWAY,
          label: "Delete it anyway",
          sub: "Those commits are lost. This cannot be undone.",
        },
        { action: "cancel", label: "Keep it", recommended: true },
      ],
    });

  /** Deleting a branch. Git holding it back because the commits live nowhere
   *  else is not an error to report — it's the next question, with the answer
   *  the old copy only named. */
  const askDeleteBranch = async (name: string) => {
    if (!repo) return;
    const go = await ask(
      askDialog({
        title: `Delete the branch ${name}?`,
        body: "The name goes from this project. Commits it shares with another branch are untouched.",
        detail: `git branch -d ${name}`,
        choices: [
          {
            action: YES,
            label: "Delete it",
            sub: "If it holds work that's nowhere else, you'll be asked again before anything goes.",
          },
          { action: "cancel", label: "Keep it", recommended: true },
        ],
      }),
    );
    if (go !== YES) return;
    setBusy("delete branch");
    let refusal: unknown = null;
    try {
      const out = await ipc.gitBranchDelete(repo, name, false);
      if (out.trim()) onNotice(out.trim().split("\n")[0], "success");
    } catch (err) {
      refusal = err;
    }
    setBusy(null);
    await refresh();
    if (!refusal) return;
    if ((await ask(forceDeleteDialog(name, String(refusal)))) === YES_ANYWAY)
      await act("force delete branch", () => ipc.gitBranchDelete(repo, name, true));
  };

  /** "Use" on a workspace whose folder is gone would point the project at
   *  nothing. Ask through the flow instead — the branch that workspace still
   *  claims is exactly what the cleanup question is about. */
  const adoptWorkspace = (w: ipc.WorktreeInfo) => {
    if (!repo) return;
    if (w.prunable && w.branch) void switchTo(repo, { kind: "branch", branch: w.branch });
    else void openThere(repo, w.path, w.branch ?? w.name);
  };

  /** Optimistic file action: move the row to where it will land *now*, run the
   *  git command in the background, then reconcile against the real status.
   *  That reconcile doubles as the rollback — a failed stage/discard simply
   *  reappears where it was, with the error surfaced. No busy spinner: the
   *  point is that the click feels instant. `to` is the bucket the file moves
   *  to, or null when it leaves the working tree entirely (discard/untracked). */


  // Right-click menus. Each is one plain-language label per real git/gh command,
  // with the command itself shown as a dimmed hint — the point is that a casual
  // coder can read what a row will run and learn the underlying operation.

  const branchMenu = (b: ipc.BranchInfo): MenuItem[] => {
    if (!repo) return [];
    const items: MenuItem[] = [];
    if (!b.current) {
      items.push({
        label: b.remote_only ? "Check out from GitHub" : "Switch to this branch",
        hint: "git checkout",
        onClick: () => void switchTo(repo, { kind: "branch", branch: b.name }),
      });
      items.push({
        label: "Test a snapshot of it",
        hint: "git checkout --detach",
        onClick: () => void switchTo(repo, { kind: "ref", ref: b.name, label: b.name }),
      });
    }
    if (branchTaskMenu) {
      items.push(branchTaskMenu(repo, b.name, null, b.protected));
    }

    // You're standing on it, so the only delete is one that moves you off
    // first. The old copy named that remedy and then refused to perform it;
    // this performs it — one branch away, then the same delete question as
    // anywhere else.
    if (b.current) {
      items.push({ separator: true });
      const base = branches.find((x) => !x.current && x.protected && !x.remote_only);
      if (base && !b.protected)
        items.push({
          label: `Go to ${base.name}, then delete this one`,
          hint: "git checkout",
          danger: true,
          onClick: () =>
            void (async () => {
              const r = await switchTo(repo, { kind: "branch", branch: base.name });
              // Only when we actually landed on the base *here*: "open it
              // there" settles somewhere else, where this delete isn't ours
              // to make.
              if (r.kind === "settled" && r.path === repo && !r.detached)
                await askDeleteBranch(b.name);
            })(),
        });
      else items.push({ label: "You're on this branch", disabled: true });
      return items;
    }
    // Protected branches never offer a delete — say why rather than dangling a
    // menu item that would always be refused.
    if (b.protected) {
      items.push({ separator: true });
      items.push({ label: "Protected branch — can't delete", disabled: true });
      return items;
    }

    items.push({ separator: true });

    if (!b.remote_only) {
      // Safe delete: git holds a branch back if it has commits that are on no
      // other branch, so this one can never quietly drop work — and when it
      // does hold back, the question comes round again with the heavier answer.
      items.push({
        label: "Delete branch",
        hint: "git branch -d",
        danger: true,
        onClick: () => void askDeleteBranch(b.name),
      });
      items.push({
        label: "Force delete branch",
        hint: "git branch -D",
        danger: true,
        onClick: () =>
          void (async () => {
            if ((await ask(forceDeleteDialog(b.name))) === YES_ANYWAY)
              await act("force delete branch", () =>
                ipc.gitBranchDelete(repo, b.name, true),
              );
          })(),
      });
    }

    if (b.remote_only || b.synced) {
      items.push({
        label: "Delete on GitHub",
        hint: "git push origin --delete",
        danger: true,
        onClick: () =>
          void (async () => {
            const go = await ask(
              askDialog({
                title: `Delete ${b.name} on GitHub?`,
                body: "It goes from the remote for everyone. Anyone who still has it can push it back.",
                detail: `git push origin --delete ${b.name}`,
                choices: [
                  {
                    action: YES,
                    label: "Delete it on GitHub",
                    sub: b.remote_only
                      ? "You don't have a copy here, so this is the last one."
                      : "Your copy here stays exactly as it is.",
                  },
                  { action: "cancel", label: "Keep it", recommended: true },
                ],
              }),
            );
            if (go === YES)
              await act("delete branch on GitHub", () =>
                ipc.gitBranchDeleteRemote(repo, b.name),
              );
          })(),
      });
    }
    return items;
  };

  const worktreeMenu = (w: ipc.WorktreeInfo): MenuItem[] => {
    const items: MenuItem[] = [];
    // A workspace whose folder is gone keeps the item: what it needs is the
    // question the flow asks, not an affordance quietly taken away.
    if (activeWorktree !== w.path && !w.bare) {
      items.push({
        label: "Use as project files",
        onClick: () => adoptWorkspace(w),
      });
    }
    items.push({
      label: "Open terminal here",
      onClick: () => onOpenTerminal(w.path, w.branch ?? w.name),
    });
    items.push({
      label: "Reveal in Finder",
      onClick: () => void ipc.fsReveal(w.path).catch(() => {}),
    });
    if (!w.is_main) {
      items.push({ separator: true });
      items.push({
        label: "Remove this workspace",
        hint: "git worktree remove",
        danger: true,
        onClick: () => void askRemoveWorktree(w),
      });
    }
    return items;
  };

  /** A commit in the history is a place you can stand, not only a tab you can
   *  read — the same snapshot a branch row offers, from the other list. */
  const commitMenu = (c: ipc.CommitInfo): MenuItem[] => {
    if (!repo) return [];
    return [
      {
        label: "Open this commit",
        onClick: () =>
          onOpenCommit(repo, { hash: c.hash, short: c.short, subject: c.subject }),
      },
      {
        label: "Test a snapshot of it",
        hint: "git checkout --detach",
        onClick: () =>
          void switchTo(repo, { kind: "ref", ref: c.hash, label: c.short }),
      },
    ];
  };


  if (repos.length === 0) {
    return (
      <div className="side-panel">
        <div className="side-panel-head">
          <span>Git</span>
        </div>
        <div className="tree-empty">
          No git repository in this project's components.
        </div>
      </div>
    );
  }


  return (
    <div className="side-panel git-panel">
      <div className="side-panel-head">
        <span>Git</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()}>
          <RestartIcon size={13} />
        </button>
      </div>

      {/* Repo picker — only when the project actually spans several repos. */}
      {repos.length > 1 && (
        <div className="git-repos">
          {repos.map((r) => (
            <button
              key={r.path}
              className={`git-repo-chip ${r.path === repo ? "git-repo-chip-on" : ""}`}
              title={`${r.path}\ncomponents: ${r.components.join(", ")}`}
              onClick={() => setRepo(r.path)}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}

      {/* Branch + sync */}
      <div className="git-branchbar">
        <button
          className="git-branch"
          title={
            status?.detached
              ? "You're looking at a snapshot, not a branch. Click here, then click any branch to go back — nothing was lost. (git: detached HEAD)"
              : `branch${status?.upstream ? ` · tracking ${status.upstream}` : " · no upstream"}`
          }
          onClick={() => setSection("branches")}
        >
          {status?.detached ? "⚠ snapshot" : `⎇ ${status?.branch ?? "—"}`}
        </button>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-counts" title={`${status.ahead} to push · ${status.behind} to pull`}>
            {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
          </span>
        )}
        <span className="git-spacer" />
        <button
          className="btn-mini"
          disabled={busy != null}
          title="git fetch --prune"
          onClick={() => repo && void act("fetch", () => ipc.gitFetch(repo))}
        >
          Fetch
        </button>
        <button
          className="btn-mini"
          disabled={busy != null}
          title="git pull --ff-only"
          onClick={() => repo && void act("pull", () => ipc.gitPull(repo))}
        >
          Pull
        </button>
        <button
          className="btn-mini"
          disabled={busy != null || status?.detached}
          title={
            // Greyed out in a snapshot: say where the way back is, not what an
            // upstream is.
            status?.detached
              ? "Nothing to push from a snapshot — click any branch to go back first."
              : status?.upstream
                ? "git push"
                : "git push --set-upstream origin (no upstream yet)"
          }
          onClick={() => repo && void act("push", () => ipc.gitPush(repo, !status?.upstream))}
        >
          Push
        </button>
      </div>

      <div className="git-tabs">
        {(["branches", "worktrees", "loose", "history"] as Section[]).map((s) => (
          <button
            key={s}
            className={`git-tab ${section === s ? "git-tab-on" : ""}`}
            onClick={() => setSection(s)}
          >
            {/* Names only. A count in a tab label is a number you can't act on,
                and it shifts the tabs sideways as it changes. */}
            {s === "loose" ? "Loose ends" : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {busy && <div className="git-busy">{busy}…</div>}

      {section === "branches" && (
        <div className="git-scroll">
          {/* Detached HEAD is the one state where the way out is not obvious.
              Say what it is and how to leave it, right where the exit is. */}
          {status?.detached && (
            <div className="git-snapshot-note">
              You're looking at a snapshot of the code. Click any branch below to go
              back — nothing you had is lost.
            </div>
          )}
          <div className="git-branch-new">
            <input
              className="git-branch-input"
              placeholder="Filter or new branch name…"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
            />
            {branchFilter.trim() && !branches.some((b) => b.name === branchFilter.trim()) && (
              <button
                className="btn-mini"
                onClick={() => {
                  if (!repo) return;
                  const name = branchFilter.trim();
                  // A name already taken is its own question now ("open the one
                  // that's already there"), not a failed switch to a branch
                  // that doesn't exist.
                  void switchTo(repo, { kind: "branch", branch: name, create: true }).then(
                    (r) => r.kind === "settled" && setBranchFilter(""),
                  );
                }}
              >
                Create
              </button>
            )}
          </div>
          {branches
            .filter((b) => b.name.toLowerCase().includes(branchFilter.toLowerCase()))
            // Current branch first, then your local ones (by recency), then the
            // "on GitHub" branches you haven't pulled down — sort is stable, so
            // the backend's recency order is preserved within each group.
            .slice()
            .sort(
              (a, b) =>
                (a.current === b.current ? 0 : a.current ? -1 : 1) ||
                (a.remote_only === b.remote_only ? 0 : a.remote_only ? 1 : -1),
            )
            .map((b) => {
              // A branch another workspace has checked out: badge it, so the
              // conflict is something you can see rather than something you
              // discover by clicking.
              const busyIn = b.current ? undefined : held.get(b.name);
              const badge = busyIn && heldBadge(busyIn);
              return (
                <div
                  key={b.name}
                  className={`git-branch-row ${b.current ? "git-branch-current" : ""} ${b.remote_only ? "git-branch-remote" : ""}`}
                  title={
                    b.current
                      ? `${b.name} — you're on this branch\n${b.subject}`
                      : badge
                        ? `${badge.title}\n${b.subject}`
                        : b.remote_only
                          ? `${b.name} — on GitHub. Click to check it out here.\n${b.subject}`
                          : b.synced
                            ? `${b.name} — click to switch\n${b.subject}`
                            : `${b.name} — local only, not pushed yet. Click to switch.\n${b.subject}`
                  }
                  onClick={() =>
                    !b.current &&
                    repo &&
                    // A remote-only name (no origin/ prefix) checks out and starts
                    // tracking it — the same DWIM git does for `git checkout x`.
                    void switchTo(repo, { kind: "branch", branch: b.name })
                  }
                  onContextMenu={(e) => repo && ctx.open(e, branchMenu(b))}
                >
                  <span className="git-branch-mark">{b.current ? "●" : b.remote_only ? "☁" : "○"}</span>
                  <span className="git-branch-name">{b.name}</span>
                  {badge ? (
                    <span className="git-branch-tag git-branch-tag-busy">{badge.label}</span>
                  ) : b.remote_only ? (
                    <span className="git-branch-tag git-branch-tag-remote">on GitHub</span>
                  ) : (
                    !b.synced && <span className="git-branch-tag">not pushed</span>
                  )}
                  <span className="git-branch-subject">{b.subject}</span>
                </div>
              );
            })}
        </div>
      )}

      {/* Worktrees: one checkout per agent, so several can work the same repo
          on different branches at once. */}
      {section === "worktrees" && (
        <div className="git-scroll">
          <div className="git-branch-new">
            <input
              className="git-branch-input"
              placeholder="New branch for a worktree…"
              value={wtBranch}
              onChange={(e) => setWtBranch(e.target.value)}
            />
            <button
              className="btn-mini"
              disabled={!wtBranch.trim() || busy != null}
              title="Create a worktree alongside the repo, on a new branch"
              onClick={() => {
                if (!repo) return;
                // Where it goes, and making it readable by the file tree, both
                // belong to the funnel now — so do the questions a folder that
                // already exists or a name already taken raise.
                void switchTo(repo, {
                  kind: "workspace",
                  branch: wtBranch.trim(),
                  create: true,
                }).then((r) => r.kind === "settled" && setWtBranch(""));
              }}
            >
              Create
            </button>
          </div>

          {worktrees.map((w) => (
            <div
              key={w.path}
              className={`git-worktree ${w.prunable ? "git-worktree-gone" : ""} ${
                activeWorktree === w.path ? "git-worktree-active" : ""
              }`}
              title={`${w.path}\n${w.head}${w.locked ? `\nlocked: ${w.locked}` : ""}${
                w.prunable ? `\nprunable: ${w.prunable}` : ""
              }`}
              onContextMenu={(e) => ctx.open(e, worktreeMenu(w))}
            >
              <div className="git-worktree-top">
                <span className="git-worktree-mark">{w.is_main ? "★" : w.prunable ? "⚠" : "⑂"}</span>
                <span className="git-worktree-branch">
                  {/* "snapshot", not "detached": the same state the note above
                      this list and the agent banner already call that. */}
                  {w.branch ?? (w.detached ? `snapshot @ ${w.head}` : w.head)}
                </span>
                {w.is_main && <span className="git-worktree-tag">main</span>}
                {w.locked && <span className="git-worktree-tag">locked</span>}
                {w.prunable && <span className="git-worktree-tag git-tag-warn">missing</span>}
                {w.dirty > 0 && (
                  <span className="git-worktree-dirty" title={`${w.dirty} uncommitted changes`}>
                    ±{w.dirty}
                  </span>
                )}
              </div>
              <div className="git-worktree-path">{w.path}</div>
              <div className="git-worktree-actions">
                {activeWorktree === w.path ? (
                  <span className="wt-inuse" title="Project files are using this worktree">
                    in use
                  </span>
                ) : (
                  !w.bare && (
                    <button
                      className="btn-mini"
                      title="Point this project's files, search and new terminals at this workspace"
                      onClick={() => adoptWorkspace(w)}
                    >
                      Use
                    </button>
                  )
                )}
                <button
                  className="btn-mini"
                  title="Open a terminal in this worktree — run an agent here"
                  onClick={() => onOpenTerminal(w.path, w.branch ?? w.name)}
                >
                  Terminal
                </button>
                {!w.is_main && (
                  <button
                    className="btn-mini"
                    title={
                      w.dirty > 0
                        ? `${w.dirty} uncommitted changes would be lost`
                        : "Remove this workspace"
                    }
                    onClick={() => void askRemoveWorktree(w)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}

          {worktrees.some((w) => w.prunable) && (
            <div className="git-branch-new">
              <button
                className="btn-mini"
                title="Forget the workspaces whose folders are gone. Nothing on disk is touched."
                onClick={() =>
                  // Not a switch, but the same command the funnel's "clear it"
                  // choice runs — so it goes through the funnel too, and its
                  // refusal arrives as the same question. The version it bumps
                  // is what reloads this list.
                  repo && void cleanupWorkspaces(repo)
                }
              >
                Prune missing ({worktrees.filter((w) => w.prunable).length})
              </button>
            </div>
          )}
        </div>
      )}

      {section === "loose" && (
        <LooseEnds
          repo={repo}
          onOpenBranch={onOpenBranch}
          onOpenTerminal={onOpenTerminal}
          onNotice={onNotice}
          taskMenuFor={
            branchTaskMenu && repo
              ? (b) => branchTaskMenu(repo, b.branch, b.worktree, b.merged)
              : undefined
          }
        />
      )}

      {section === "history" && (
        <div className="git-scroll">
          {log.map((c) => (
            <div
              key={c.hash}
              className="git-commit-row git-commit-row-click"
              title={`${c.hash}\n${c.author} · ${c.date}\n\nClick to open this commit · right-click to stand on it`}
              onClick={() =>
                repo &&
                onOpenCommit(repo, { hash: c.hash, short: c.short, subject: c.subject })
              }
              onContextMenu={(e) => repo && ctx.open(e, commitMenu(c))}
            >
              <span className="git-commit-hash">{c.short}</span>
              <span className="git-commit-subject">{c.subject}</span>
              <span className="git-commit-meta">{c.date}</span>
            </div>
          ))}
          {log.length === 0 && <div className="tree-empty">No commits yet.</div>}
        </div>
      )}


      {/* No dialog is mounted here. Every question this panel asks — a switch
          git refused, a workspace being removed, a branch being deleted — is
          put on screen by the one dialog above us, so it stays answerable even
          when another side tab takes this panel off screen. */}

      {ctx.menu && (
        <ContextMenu x={ctx.menu.x} y={ctx.menu.y} items={ctx.menu.items} onClose={ctx.close} />
      )}
    </div>
  );
}

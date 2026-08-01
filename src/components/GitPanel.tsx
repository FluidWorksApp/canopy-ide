// Native git management for a project's repos: branch switching, staging,
// commit, sync with the remote, and pull requests. Everything runs through the
// system `git`/`gh` in the Rust core — the same tools the user's terminal uses,
// so hooks, credential helpers and SSH config all behave identically.
import { useCallback, useEffect, useMemo, useState } from "react";
import { askDialog } from "../branchSwitch";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import type { Notify } from "../types";
import { useBranchSwitch } from "../useBranchSwitch";
import {
  ensureLeases,
  releaseLease,
  workspaceRows,
  type AgentRef,
  type WorkspaceRow,
} from "../workspaces";
import { AgentChip } from "./AgentChip";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { RestartIcon } from "./icons";
import { LooseEnds } from "./LooseEnds";
import { PruneDialog } from "./PruneDialog";
import { Button } from "./ui";

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
  /** Working directory of every live run, anywhere in the project — how a row
   *  knows a server is up in its folder without asking git anything. */
  serverCwds: string[];
  /** Working directory of every live agent terminal, same idea. */
  agentCwds: string[];
  /** The agents in a folder, by name and state. The same answer the Servers
   *  panel puts on a workspace's run line — a branch list that can't say who
   *  is on a branch sends you to another panel to find out. */
  agentsAt?: (dir: string) => AgentRef[];
  /** Bring an agent's terminal to the front, from the chip that names it. */
  onOpenAgent?: (ptyId: number) => void;
  /** Open a URL in the preview tab — the port chip's click. */
  onOpenPreview: (url: string) => void;
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

type Section = "branches" | "loose" | "history";



export function GitPanel({
  visible,
  components,
  onOpenCommit,
  onOpenBranch,
  onOpenTerminal,
  activeWorktree,
  serverCwds,
  agentCwds,
  agentsAt,
  onOpenAgent,
  onOpenPreview,
  onNotice,
  branchTaskMenu,
}: GitPanelProps) {
  const [repos, setRepos] = useState<ipc.RepoInfo[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [status, setStatus] = useState<ipc.RepoStatus | null>(null);
  const [branches, setBranches] = useState<ipc.BranchInfo[]>([]);
  const [log, setLog] = useState<ipc.CommitInfo[]>([]);
  const [worktrees, setWorktrees] = useState<ipc.WorktreeInfo[]>([]);
  /** Workspace folder -> the port its runs are given. Allocated when the list
   *  loads, never during a render: taking a lease writes to settings. */
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [section, setSection] = useState<Section>("branches");
  const [busy, setBusy] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const [pruning, setPruning] = useState(false);
  /** Bumped when a bulk prune finishes. The lists here refresh off `refresh()`
   *  and `loadWorktrees()`, but Loose ends reads its own audit — this is how it
   *  is told that ninety of the rows it is showing have just gone. */
  const [pruned, setPruned] = useState(0);
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
  //
  // Watched, not polled. This ran three git subprocesses every five seconds for
  // as long as the panel was open, whether or not anything had happened; the
  // fs:change subscription beside it couldn't replace them, because a commit or
  // a branch switch writes only inside .git, which that event filters out.
  // `git:change` is the signal that covers both, already debounced in Rust.
  useEffect(() => {
    if (!repo || !visible) return;
    void refresh();
    const sub = ipc.onGitChange(() => void refresh());
    return () => {
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
      if (!quiet) setBusy("workspaces");
      try {
        const list = await ipc.gitWorktrees(repo);
        setWorktrees(list);
        setPorts(ensureLeases(repo, list));
      } catch (err) {
        if (!quiet) void failed("list the workspaces", err);
      } finally {
        if (!quiet) setBusy(null);
      }
    },
    [repo, failed],
  );

  // The one list is a join of branches and workspaces, so the workspaces are
  // no longer a section you have to go to — they load whenever it is on screen.
  useEffect(() => {
    if (section === "branches") void loadWorktrees(true);
  }, [section, loadWorktrees, version]);

  /** The list itself: every branch, wherever it lives, with what is happening
   *  in its folder. `workspaces.ts` owns the join and the ordering. */
  const rows = useMemo(
    () =>
      repo
        ? workspaceRows(branches, worktrees, {
            repo,
            activePath: activeWorktree,
            serverCwds,
            agentCwds,
            agentsAt,
            ports,
          })
        : [],
    [branches, worktrees, repo, activeWorktree, serverCwds, agentCwds, agentsAt, ports],
  );

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
      // Hand its port back, so a repo worked on for a year doesn't drift its
      // workspaces into numbers nobody recognises.
      releaseLease(repo, w.path);
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

  /** One click on a row. Which git command that turns out to be is the panel's
   *  problem, not yours: a branch with a folder of its own is opened there, one
   *  without is switched to here, and one whose folder is gone goes through the
   *  question that clears the record first. */
  const openRow = async (r: WorkspaceRow) => {
    if (!repo || r.active) return;
    if (r.missing) {
      await switchTo(repo, { kind: "branch", branch: r.branch });
      await loadWorktrees(true);
      return;
    }
    if (r.path && !r.main) {
      await openThere(repo, r.path, r.branch);
      return;
    }
    await switchTo(repo, { kind: "branch", branch: r.branch });
  };

  /**
   * Start a feature: a branch, a folder of its own, and everything that folder
   * needs to actually run.
   *
   * The setup is the part that used to be missing. `git worktree add` hands you
   * tracked files and nothing else, so the first `npm run dev` in a new
   * workspace died on a missing `node_modules` — which read as "worktrees are
   * broken" rather than "nobody installed anything". Now the dependencies are
   * cloned (copy-on-write, so it costs about a second) and the gitignored
   * config is carried over, and when neither is possible the install runs in
   * the RUNS rail where you can watch it.
   */
  const startFeature = async (name: string) => {
    if (!repo) return;
    const r = await switchTo(repo, { kind: "workspace", branch: name, create: true });
    if (r.kind !== "settled") return;
    setBranchFilter("");
    await loadWorktrees(true);
    if (!r.path || !getSettings().workspaceBootstrap) return;

    setBusy("setting up");
    let report: ipc.BootstrapReport | null = null;
    try {
      report = await ipc.gitWorktreeBootstrap(repo, r.path);
    } catch (err) {
      // A workspace that exists but isn't set up is still a workspace. Say what
      // didn't happen and leave it standing rather than tearing it down.
      onNotice(`${name} is ready, but setting it up failed: ${String(err)}`, "error");
    } finally {
      setBusy(null);
    }
    if (!report) return;

    if (report.install) {
      // Deliberately a run tab, not a silent background command: an install is
      // minutes long and fails in ways only its own output explains.
      onOpenTerminal(r.path, name);
      onNotice(
        `${name} is ready. ${report.note ?? ""} Run \`${report.install}\` in it before starting a server.`.trim(),
        "info",
      );
      return;
    }
    const parts: string[] = [];
    if (report.cloned.length)
      parts.push(
        `${report.cloned.length} dependency folder${report.cloned.length === 1 ? "" : "s"} cloned`,
      );
    if (report.carried.length) parts.push(`${report.carried.join(", ")} carried over`);
    onNotice(
      parts.length ? `${name} is set up — ${parts.join(", ")}.` : `${name} is ready.`,
      "success",
    );
  };

  /** The row's tooltip: the git-level facts, where they teach rather than
   *  block. The row itself says none of this. */
  const workspaceTitle = (r: WorkspaceRow) => {
    const lines = [r.branch];
    if (r.missing) lines.push(`${r.path} — this folder is gone; the branch is stuck until it's cleared`);
    else if (r.path && !r.main) lines.push(r.path);
    else if (r.remoteOnly) lines.push("On GitHub. Click to check it out here.");
    else if (r.path) lines.push("This project's own checkout");
    else lines.push("No folder yet. Click to switch to it here.");
    if (r.port != null)
      lines.push(r.running > 0 ? `Serving on port ${r.port}` : `Port ${r.port} held for it`);
    if (r.locked) lines.push("locked");
    if (r.subject) lines.push(r.subject);
    return lines.join("\n");
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

  /**
   * A row's right-click menu: what you can do with this feature, then what you
   * can do with the branch under it.
   *
   * The two used to be separate menus on two separate lists, which meant "give
   * this branch a workspace" and "remove this workspace" could never appear
   * together even though they are the same decision seen from either end.
   */
  const rowMenu = (r: WorkspaceRow): MenuItem[] => {
    if (!repo) return [];
    const items: MenuItem[] = [];
    const wt = worktrees.find((w) => w.path === r.path) ?? null;

    if (r.missing && wt) {
      items.push({
        label: "Clear the missing workspace",
        hint: "git worktree prune",
        onClick: () => void adoptWorkspace(wt),
      });
    } else if (r.path && !r.active) {
      items.push({
        label: r.main ? "Work in the main checkout" : "Work in this workspace",
        onClick: () => void openRow(r),
      });
    }

    // The one route that makes a workspace out of a branch that hasn't got one.
    // Offered from the same menu as everything else it competes with.
    if (!r.path && !r.remoteOnly) {
      items.push({
        label: "Give it a workspace of its own",
        hint: "git worktree add",
        onClick: () => void startFeature(r.branch),
      });
    }

    if (r.path && !r.missing) {
      items.push({
        label: "Open terminal here",
        onClick: () => onOpenTerminal(r.path!, r.branch),
      });
      if (r.port != null && r.running > 0) {
        items.push({
          label: `Open its preview (:${r.port})`,
          onClick: () => onOpenPreview(`http://localhost:${r.port}`),
        });
      }
      items.push({
        label: "Reveal in Finder",
        onClick: () => void ipc.fsReveal(r.path!).catch(() => {}),
      });
    }

    // Everything about the branch itself — switch, snapshot, tasks, delete —
    // is unchanged and still lives on the BranchInfo it was written against.
    const b = branches.find((x) => x.name === r.branch);
    if (b) {
      items.push({ separator: true });
      items.push(...branchMenu(b));
    }

    if (wt && !wt.is_main) {
      items.push({ separator: true });
      items.push({
        label: "Remove this workspace",
        hint: "git worktree remove",
        danger: true,
        onClick: () => void askRemoveWorktree(wt),
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
        <Button icon title="Refresh" onClick={() => void refresh()}>
          <RestartIcon size={13} />
        </Button>
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
        <Button size="sm"
          disabled={busy != null}
          title="git fetch --prune"
          onClick={() => repo && void act("fetch", () => ipc.gitFetch(repo))}>
          Fetch
        </Button>
        <Button size="sm"
          disabled={busy != null}
          title="git pull --ff-only"
          onClick={() => repo && void act("pull", () => ipc.gitPull(repo))}>
          Pull
        </Button>
        <Button size="sm"
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
          onClick={() => repo && void act("push", () => ipc.gitPush(repo, !status?.upstream))}>
          Push
        </Button>
      </div>

      <div className="git-tabs">
        {(["branches", "loose", "history"] as Section[]).map((s) => (
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
        <span className="git-spacer" />
        {/* On the tab strip rather than inside one section, because it is about
            the repo and not about whichever list you happen to be reading —
            Branches, Loose ends and the Servers panel's workspace rows are all
            long for the same reason, and this is the one thing that shortens
            all three. */}
        <Button size="sm" variant="ghost"
          disabled={!repo}
          title="Review every branch and workspace at once, and take the leftovers away"
          onClick={() => setPruning(true)}>
          Prune…
        </Button>
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
              placeholder="Filter, or name a new feature…"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
            />
            {branchFilter.trim() && !rows.some((r) => r.branch === branchFilter.trim()) && (
              <Button size="sm" variant="accent"
                disabled={busy != null}
                title="Start a branch in a workspace of its own, set up and ready to run"
                onClick={() => void startFeature(branchFilter.trim())}>
                Start
              </Button>
            )}
          </div>

          {rows
            .filter((r) => r.branch.toLowerCase().includes(branchFilter.toLowerCase()))
            .map((r) => (
              <div
                key={r.path ?? r.branch}
                className={`ws-row ${r.active ? "ws-row-active" : ""} ${
                  r.missing ? "ws-row-gone" : ""
                } ${r.remoteOnly ? "ws-row-remote" : ""}`}
                title={workspaceTitle(r)}
                onClick={() => void openRow(r)}
                onContextMenu={(e) => repo && ctx.open(e, rowMenu(r))}
              >
                {/* Five marks, all of them glyphs a system font actually has.
                    "Has a workspace" is deliberately not one of them — the
                    tag beside the name already says it, and the fork character
                    that used to be here rendered as a box on some machines. */}
                <span className="ws-mark">
                  {r.active ? "◉" : r.current ? "●" : r.missing ? "⚠" : r.remoteOnly ? "☁" : "○"}
                </span>
                <span className="ws-name">{r.branch}</span>

                {/* Where it lives and what state it is in. A row says at most
                    two of these — past that it stops being readable at a
                    glance, which is the only thing this list is for. */}
                {r.missing ? (
                  <span className="ws-tag ws-tag-warn">folder gone</span>
                ) : r.remoteOnly ? (
                  <span className="ws-tag ws-tag-remote">on GitHub</span>
                ) : r.path && !r.main ? (
                  <span className="ws-tag">own space</span>
                ) : (
                  r.unpushed && <span className="ws-tag">not pushed</span>
                )}

                <span className="ws-state">
                  {r.dirty > 0 && (
                    <span className="ws-dirty" title={`${r.dirty} uncommitted changes`}>
                      ±{r.dirty}
                    </span>
                  )}
                  {/* Who is in there, named — the same chip the Servers panel
                      puts on this workspace's run line, so "claude is on
                      feat/x" reads identically wherever you meet it. The bare
                      count is the fallback for an agent terminal no digest
                      covers: something is in there either way. */}
                  {r.agentList.length > 0 ? (
                    <AgentChip agents={r.agentList} onOpen={onOpenAgent} />
                  ) : (
                    r.agents > 0 && (
                      <span
                        className="ws-agents"
                        title={`${r.agents} agent terminals here`}
                      >
                        ⌁{r.agents}
                      </span>
                    )
                  )}
                  {/* The port is the whole point of parallel workspaces, so it
                      is on the row rather than behind a menu — and it opens
                      the preview, because a number you can't click is trivia. */}
                  {r.port != null && !r.missing && r.running > 0 && (
                    <button
                      className="ws-port ws-port-live"
                      title={`Serving on ${r.port} — open its preview`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPreview(`http://localhost:${r.port}`);
                      }}
                    >
                      :{r.port}
                    </button>
                  )}
                  {r.port != null && !r.missing && r.running === 0 && (
                    <span
                      className="ws-port"
                      title={`Port ${r.port} is held for this workspace — anything you run here serves on it.`}
                    >
                      :{r.port}
                    </span>
                  )}
                </span>

                <span className="ws-subject">{r.subject}</span>
              </div>
            ))}

          {rows.some((r) => r.missing) && (
            <div className="git-branch-new">
              <Button size="sm"
                title="Forget the workspaces whose folders are gone. Nothing on disk is touched."
                onClick={() => repo && void cleanupWorkspaces(repo)}>
                Clear {rows.filter((r) => r.missing).length} missing
              </Button>
            </div>
          )}
        </div>
      )}

      {section === "loose" && (
        <LooseEnds
          repo={repo}
          refreshKey={pruned}
          onPrune={() => setPruning(true)}
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


      {/* The one dialog this panel does mount. Every *question* it asks — a
          switch git refused, a workspace being removed, a branch being deleted
          — still goes to the funnel above us, so it stays answerable when
          another side tab takes this panel off screen. Pruning is not a
          question: it is a working surface with a filter, a selection and a
          list you scroll, and it belongs to the panel you opened it from. */}
      <PruneDialog
        open={pruning}
        repo={repo}
        busy={[...serverCwds, ...agentCwds]}
        onNotice={onNotice}
        onChanged={() => {
          setPruned((n) => n + 1);
          void refresh();
          void loadWorktrees(true);
        }}
        onClose={() => setPruning(false)}
      />

      {ctx.menu && (
        <ContextMenu x={ctx.menu.x} y={ctx.menu.y} items={ctx.menu.items} onClose={ctx.close} />
      )}
    </div>
  );
}

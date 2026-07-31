// "Loose ends": every branch and worktree in the repo, sorted by what you'd
// lose if it vanished. Agents create worktrees faster than anyone tracks them
// and abandon them mid-thought when context runs out; afterwards an orphan is
// indistinguishable from live work at a glance.
//
// The organising question is NOT "merged or not" — it's "does this work exist
// anywhere else". Uncommitted files live only in that directory; unpushed
// commits live only in this clone. Those are the states where deleting loses
// work permanently, so they sort to the top. Merge status decides clutter, and
// clutter sorts last (oldest first — the most-forgotten is the most deletable).
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import { askDialog, heldBadge } from "../branchSwitch";
import { useBranchSwitch } from "../useBranchSwitch";
import type { Notify } from "../types";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { Button } from "./ui";

interface LooseEndsProps {
  repo: string | null;
  /** Open this branch's work as a tab — the point of the panel. */
  onOpenBranch: (repo: string, branch: ipc.BranchWork) => void;
  onOpenTerminal: (cwd: string, label: string) => void;
  onNotice: Notify;
  /** The "Tasks ▸" submenu for a right-clicked branch, built by the owner (it
   *  knows the task registry). Omitted where tasks don't apply. */
  taskMenuFor?: (b: ipc.BranchWork) => MenuItem;
}

type Bucket = "uncommitted" | "unpushed" | "open" | "cleanable";

const BUCKETS: { id: Bucket; label: string; hint: string }[] = [
  {
    id: "uncommitted",
    label: "Uncommitted work",
    hint: "Changes that exist only in that directory. Deleting loses them.",
  },
  {
    id: "unpushed",
    label: "Unpushed commits",
    hint: "Committed, but only in this clone — nothing on the remote yet.",
  },
  {
    id: "open",
    label: "Pushed, not merged",
    hint: "Safe from loss — still open work.",
  },
  {
    id: "cleanable",
    label: "Safe to clean up",
    hint: "Merged (or its remote branch is gone) with nothing left behind.",
  },
];

function bucketOf(b: ipc.BranchWork, countsDegraded: boolean): Bucket {
  if (b.dirty > 0) return "uncommitted";
  if (b.merged) return "cleanable";
  // No upstream means it was never pushed anywhere, so `ahead` is counted
  // against the base branch instead — and that count needs git 2.41+. Where
  // it is unavailable every upstream-less branch reports 0, which would file
  // commits that exist ONLY in this clone under "Safe from loss". That is the
  // one lie this panel must never tell, so assume unpushed and let the banner
  // explain the missing count.
  // git.rs counts `ahead` against the BASE BRANCH (not an upstream) whenever
  // `upstream.is_none() || upstream_gone` — and that count needs git 2.41+.
  // Where it is unavailable it reports 0 for exactly those branches, so
  // trusting it files commits that exist only in this clone under "safe to
  // clean up", next to a delete button. Mirror git.rs's condition exactly:
  // guarding only the no-upstream half left branches whose remote was deleted
  // still being called safe.
  if ((!b.upstream || b.upstream_gone) && countsDegraded) return "unpushed";
  if (b.ahead > 0) return "unpushed";
  if (!b.upstream) return "open";
  return b.upstream_gone ? "cleanable" : "open";
}

const ago = (days: number) =>
  days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;

/** The folder's own name — what a person calls a workspace. */
const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const files = (n: number) => `${n} uncommitted file${n === 1 ? "" : "s"}`;

/** Why git kept a branch, in words. Only the two refusals a bulk cleanup
 *  actually meets are worth naming; anything else keeps git's own first line,
 *  which is better than the silence this used to keep. */
function whyRefused(err: string): string {
  const at = /checked out at '([^']+)'/.exec(err)?.[1];
  if (at) return `it's open in ${baseName(at)}`;
  if (/not fully merged/i.test(err))
    return `it still has commits that aren't on the base branch`;
  return (
    err
      .split("\n")
      .map((l) => l.replace(/^(error|fatal|warning):\s*/i, "").trim())
      .find(Boolean) ?? "git wouldn't say why"
  );
}

export function LooseEnds({
  repo,
  onOpenBranch,
  onOpenTerminal,
  onNotice,
  taskMenuFor,
}: LooseEndsProps) {
  const ctx = useContextMenu();
  const { switchTo, openThere, ask, version } = useBranchSwitch();
  const [audit, setAudit] = useState<ipc.WorkAudit | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  /** After a cleanup that git partly refused: the branches it kept, so "Show
   *  me" has somewhere to take you. Null means the whole audit. */
  const [leftAlone, setLeftAlone] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    if (!repo) return;
    setBusy(true);
    try {
      // Even "we couldn't read the repo" ends in an action. A toast of git's
      // stderr leaves the panel showing a dash and no way forward.
      for (;;) {
        try {
          setAudit(await ipc.gitWorkAudit(repo));
          return;
        } catch (err) {
          const again = await ask(
            askDialog({
              title: "Couldn't read this project's branches",
              body: "Git wouldn't answer the question this panel asks, so there's nothing to show yet.",
              detail: String(err),
              choices: [
                {
                  action: "retry",
                  label: "Try again",
                  sub: "Runs the same check again. Nothing here changes either way.",
                  recommended: true,
                },
                { action: "cancel", label: "Leave it for now" },
              ],
            }),
          );
          if (again !== "retry") return;
        }
      }
    } finally {
      setBusy(false);
    }
  }, [repo, ask]);

  // `version` bumps after anything that moves a ref or a workspace, wherever it
  // was started — so this list stops going stale behind the shared dialog.
  useEffect(() => {
    void load();
  }, [load, version]);

  // A different repo is a different audit; the "left alone" filter can't follow.
  useEffect(() => {
    setLeftAlone(null);
  }, [repo]);

  if (!repo) return <div className="tree-empty">No repository.</div>;
  // "Leave it for now" on the read failure lands here, so this can't be a bare
  // dash: the way back in stays on screen.
  if (!audit)
    return (
      <div className="tree-empty">
        {busy ? (
          "Auditing…"
        ) : (
          <>
            Nothing read yet.{" "}
            <Button size="sm" onClick={() => void load()}>
              Check again
            </Button>
          </>
        )}
      </div>
    );

  const groups = BUCKETS.map((b) => {
    let items = audit.items.filter((x) => bucketOf(x, audit.counts_degraded) === b.id);
    // main/develop/the base compare as "merged" against themselves, so they'd
    // land in the deletable group and sit next to a delete button. They are
    // never loose ends — keep them out of cleanup entirely.
    if (b.id === "cleanable") items = items.filter((x) => !x.protected);
    if (leftAlone) items = items.filter((x) => leftAlone.includes(x.branch));
    // Danger groups newest-first (that's what you were just doing); the
    // cleanup group oldest-first, because the most forgotten is the most
    // deletable and that's the whole point of the view.
    items.sort((x, y) =>
      b.id === "cleanable" ? y.age_days - x.age_days : x.age_days - y.age_days,
    );
    return { ...b, items };
  }).filter((g) => g.items.length > 0);

  const risky = audit.items.filter((b) => {
    const k = bucketOf(b, audit.counts_degraded);
    return k === "uncommitted" || k === "unpushed";
  }).length;
  const cleanable = audit.items.filter(
    (b) => !b.protected && bucketOf(b, audit.counts_degraded) === "cleanable",
  ).length;
  // The subset we can delete right now: merged/remote-gone branches with no
  // worktree checked out (git won't delete a branch that's checked out — those
  // use Remove-worktree first). The audit already guarantees these hold no
  // unpushed unique work, so a force delete is safe and reliable (a plain -d
  // refuses squash-merged branches and ones merged into base but not HEAD).
  const cleanableBranches =
    groups.find((g) => g.id === "cleanable")?.items.filter((b) => !b.worktree) ?? [];
  const visible = showAll ? groups : groups.filter((g) => g.id !== "cleanable");

  /** Take a workspace away. `force` counts rather than toggles: 1 drops
   *  uncommitted work, 2 also overrides a lock — and a lock is what this panel
   *  meets most, because an agent may still be running in there. Every step up
   *  is asked for, never assumed. Answers whether the folder actually went, so
   *  a caller waiting on it doesn't press on after a "Keep it". */
  const removeWorktree = async (b: ipc.BranchWork): Promise<boolean> => {
    if (!repo || !b.worktree) return false;
    const path = b.worktree;
    const dirty = b.dirty > 0;
    const go = await ask(
      askDialog({
        title: "Remove this workspace?",
        body: dirty
          ? `${baseName(path)} goes, and with it ${files(b.dirty)} that exist nowhere else.`
          : `${baseName(path)} goes. ${b.branch} itself stays — it's only the folder holding it that's removed.`,
        detail: path,
        choices: [
          // With work in there, the safest way out is the one that keeps it;
          // with nothing to lose, lead with what they just clicked.
          { action: "cleanup", label: "Remove it", recommended: !dirty },
          { action: "cancel", label: "Keep it", recommended: dirty },
        ],
      }),
    );
    if (go !== "cleanup") return false;

    let force: 0 | 1 | 2 = dirty ? 1 : 0;
    for (;;) {
      try {
        onNotice(await ipc.gitWorktreeRemove(repo, path, force), "success");
        void load();
        return true;
      } catch (err) {
        const text = String(err);
        // The two things git refuses over, each with the one heavier hand that
        // answers it — named plainly, and never taken without being asked for.
        const harder: { title: string; body: string; label: string; to: 1 | 2 } | null =
          /locked/i.test(text) && force < 2
            ? {
                title: "Something still claims this workspace",
                body: `${baseName(path)} is held open — an agent working there is the usual reason.`,
                label: "Remove it anyway",
                to: 2,
              }
            : /--force|modified or untracked/i.test(text) && force < 1
              ? {
                  title: "There's unsaved work in this workspace",
                  body: `${baseName(path)} has changes that exist nowhere else.`,
                  label: "Remove it and lose them",
                  to: 1,
                }
              : null;
        if (!harder) {
          await ask(
            askDialog({
              title: "Couldn't remove that workspace",
              body: "Git wouldn't take it away. The details below are its own.",
              detail: text,
              choices: [{ action: "cancel", label: "Leave it as it is" }],
            }),
          );
          return false;
        }
        const on = await ask(
          askDialog({
            title: harder.title,
            body: harder.body,
            detail: text,
            choices: [
              { action: "force-cleanup", label: harder.label },
              { action: "cancel", label: "Keep it", recommended: true },
            ],
          }),
        );
        if (on !== "force-cleanup") return false;
        force = harder.to;
      }
    }
  };

  /** Delete a local branch. The only operation here that can drop commits, so
   *  the refusal it actually meets — the branch is open somewhere — gets the
   *  ways out git's own message only hints at. */
  const deleteBranch = async (b: ipc.BranchWork) => {
    if (!repo || b.protected) return;
    const go = await ask(
      askDialog({
        title: `Delete ${b.branch}?`,
        body: `Its work is already on ${audit.base}, so nothing is lost — only the name goes.`,
        detail: `git branch -D ${b.branch}`,
        choices: [
          { action: "cleanup", label: "Delete it" },
          { action: "cancel", label: "Keep it", recommended: true },
        ],
      }),
    );
    if (go !== "cleanup") return;
    try {
      onNotice(await ipc.gitBranchDelete(repo, b.branch, true), "success");
      void load();
    } catch (err) {
      await branchDeleteRefused(b, String(err));
    }
  };

  /** git wouldn't delete it. Almost always because it is open in a workspace —
   *  a question with two real ways through, neither of which git offers. */
  const branchDeleteRefused = async (b: ipc.BranchWork, text: string) => {
    if (!repo) return;
    // The audit can be a moment out of date, so take git's word for where it is.
    const held =
      b.worktree ?? /checked out at '([^']+)'/.exec(text)?.[1] ?? null;
    if (!held) {
      await ask(
        askDialog({
          title: `Couldn't delete ${b.branch}`,
          body: "Git wouldn't take the name away. The details below are its own.",
          detail: text,
          choices: [{ action: "cancel", label: "Leave it as it is" }],
        }),
      );
      return;
    }
    const action = await ask(
      askDialog({
        title: `${b.branch} is still open somewhere`,
        body: `${baseName(held)} has it checked out, and git won't delete a branch someone is standing on.`,
        detail: `${held}\n\n${text}`,
        choices: [
          {
            action: "open-there",
            label: "Open the workspace that has it",
            sub: `Point this project's files at ${baseName(held)}. Nothing moves, nothing is lost.`,
            recommended: true,
          },
          {
            action: "force-cleanup",
            label: "Remove that workspace first",
            sub: "Asks about the folder, then comes back to the branch.",
          },
          { action: "cancel", label: "Leave it for now" },
        ],
      }),
    );
    if (action === "open-there") {
      await openThere(repo, held, b.branch);
    } else if (action === "force-cleanup") {
      // Only come back to the branch if the folder actually went — otherwise
      // this would ask the same refused question a second time.
      if (await removeWorktree({ ...b, worktree: held }))
        void deleteBranch({ ...b, worktree: null });
    }
  };

  /** Delete the whole cleanable group. Git refuses some of them for reasons a
   *  person can act on, so the refusals are collected and asked about — a bare
   *  success count over swallowed failures is not an account of anything. */
  const cleanupAll = async () => {
    if (!repo || cleanableBranches.length === 0) return;
    const n = cleanableBranches.length;
    const go = await ask(
      askDialog({
        title: `Delete ${n} merged branch${n === 1 ? "" : "es"}?`,
        body: `Their work is already on ${audit.base}, so nothing is lost — only the names go.`,
        detail: cleanableBranches.map((b) => b.branch).join("\n"),
        choices: [
          { action: "cleanup", label: `Delete ${n === 1 ? "it" : "them"}` },
          { action: "cancel", label: "Keep them", recommended: true },
        ],
      }),
    );
    if (go !== "cleanup") return;

    let ok = 0;
    const refused: { branch: string; why: string }[] = [];
    for (const b of cleanableBranches) {
      try {
        await ipc.gitBranchDelete(repo, b.branch, true);
        ok++;
      } catch (err) {
        refused.push({ branch: b.branch, why: whyRefused(String(err)) });
      }
    }
    if (ok > 0)
      onNotice(`Cleaned up ${ok} branch${ok === 1 ? "" : "es"}.`, "success");
    void load();
    if (refused.length === 0) return;

    const m = refused.length;
    const show = await ask(
      askDialog({
        title: `${m} branch${m === 1 ? " was" : "es were"} left alone`,
        body: refused.map((r) => `${r.branch} — ${r.why}`).join("\n"),
        detail: refused.map((r) => r.branch).join("\n"),
        choices: [
          {
            // ask() only needs a token to tell the choices apart, and "look at
            // it without changing anything" is exactly what this one does.
            action: "snapshot",
            label: `Show me ${m === 1 ? "it" : "them"}`,
            sub: "Narrows the list to those branches so you can deal with each one.",
            recommended: true,
          },
          { action: "cancel", label: "That's fine" },
        ],
      }),
    );
    if (show === "snapshot") {
      setLeftAlone(refused.map((r) => r.branch));
      setShowAll(true);
    }
  };

  /** Right-click a branch row. Going to the branch leads, because this is the
   *  longest branch list in the app and a row that can only be read is a dead
   *  row. Below it: what a click can't do — hand this branch to a one-shot
   *  agent, or the directory actions that otherwise need the hover buttons. */
  const rowMenu = (b: ipc.BranchWork): MenuItem[] => {
    const items: MenuItem[] = [];
    // Both go through the one funnel, so a branch that's busy elsewhere asks
    // its question here exactly as it would anywhere else.
    if (!b.current) {
      items.push({
        label: "Switch to this branch",
        onClick: () => void switchTo(repo, { kind: "branch", branch: b.branch }),
      });
      items.push({
        label: "Test a snapshot of it",
        onClick: () =>
          void switchTo(repo, { kind: "ref", ref: b.branch, label: b.branch }),
      });
      items.push({ separator: true });
    }
    items.push({
      label: "Open branch work",
      onClick: () => onOpenBranch(repo, b),
    });
    if (taskMenuFor) items.push(taskMenuFor(b));
    if (b.worktree && !b.prunable) {
      items.push({ separator: true });
      items.push({
        label: "Open terminal here",
        onClick: () => onOpenTerminal(b.worktree as string, b.branch),
      });
      if (!b.is_main) {
        items.push({
          label: "Open it there",
          onClick: () => void openThere(repo, b.worktree as string, b.branch),
        });
      }
    }
    return items;
  };

  return (
    <div className="git-scroll loose-ends">
      {ctx.menu && (
        <ContextMenu x={ctx.menu.x} y={ctx.menu.y} items={ctx.menu.items} onClose={ctx.close} />
      )}
      <div className="loose-summary">
        <span>
          <strong>{risky}</strong> hold work that exists nowhere else
        </span>
        <span className="loose-sep">·</span>
        <span>
          <strong>{cleanable}</strong> safe to remove
        </span>
        <span className="git-spacer" />
        <Button size="sm" onClick={() => void load()} disabled={busy}>
          {busy ? "…" : "Recheck"}
        </Button>
      </div>
      <div className="loose-base">
        Merge status measured against <code>{audit.base}</code>. Squash-merged
        branches can still read as unmerged — their remote being gone is the
        better hint.
        {audit.counts_degraded && " (This git is too old to count commits against the base branch.)"}
      </div>
      {leftAlone && (
        <div className="loose-base">
          Showing only the {leftAlone.length} branch
          {leftAlone.length === 1 ? "" : "es"} the cleanup left alone.{" "}
          <Button size="sm" onClick={() => setLeftAlone(null)}>
            Show everything again
          </Button>
        </div>
      )}

      {visible.map((g) => (
        <div key={g.id} className="loose-group">
          <div className={`loose-head loose-head-${g.id}`} title={g.hint}>
            {g.label}
            <span className="badge">{g.items.length}</span>
            {g.id === "cleanable" && cleanableBranches.length > 0 && (
              <>
                <span className="git-spacer" />
                <Button size="sm" variant="danger"
                  title={`Delete ${cleanableBranches.length} merged local branch${cleanableBranches.length === 1 ? "" : "es"}`}
                  onClick={() => void cleanupAll()}>
                  Clean up {cleanableBranches.length}
                </Button>
              </>
            )}
          </div>
          {g.items.map((b) => (
            <div
              key={b.branch}
              className="loose-row loose-row-click"
              title={`${b.worktree ?? "no workspace of its own"}\n\nClick to see what's in this branch\nRight-click to switch to it`}
              onClick={() => onOpenBranch(repo, b)}
              onContextMenu={(e) => ctx.open(e, rowMenu(b))}
            >
              <div className="loose-main">
                <span className="loose-branch">
                  {b.branch}
                  {b.current && <span className="loose-chip">current</span>}
                </span>
                <span className="loose-subject">{b.subject}</span>
              </div>
              <div className="loose-meta">
                {b.dirty > 0 && (
                  <span className="loose-dirty" title={`${b.dirty} uncommitted files`}>
                    ±{b.dirty}
                  </span>
                )}
                {b.ahead > 0 && (
                  <span className="loose-ahead" title="commits not on the remote">
                    ↑{b.ahead}
                  </span>
                )}
                {b.upstream_gone && (
                  <span className="loose-chip" title="its remote branch was deleted">
                    remote gone
                  </span>
                )}
                {!b.upstream && !b.upstream_gone && (
                  <span className="loose-chip" title="never pushed anywhere">
                    local only
                  </span>
                )}
                {/* One badge for where this branch lives, in the words every
                    other surface uses — three states written three ways is how
                    "main worktree" and "dir missing" got here in the first
                    place. */}
                {b.worktree || b.prunable ? (
                  <span
                    className={`loose-chip ${b.prunable ? "loose-chip-warn" : ""}`}
                    title={heldBadge(b).title}
                  >
                    {heldBadge(b).label}
                  </span>
                ) : (
                  <span className="loose-chip" title="nothing has this branch open">
                    no workspace
                  </span>
                )}
                <span className="loose-age">{ago(b.age_days)}</span>
                <span className="loose-actions" onClick={(e) => e.stopPropagation()}>
                  {b.worktree && !b.prunable && (
                    <>
                      <Button size="sm"
                        title="Open a terminal in this workspace"
                        onClick={() => onOpenTerminal(b.worktree as string, b.branch)}>
                        Terminal
                      </Button>
                      {!b.is_main && (
                        <Button size="sm"
                          title="Point this project's files at this workspace. Nothing moves, nothing is lost."
                          onClick={() =>
                            void openThere(repo, b.worktree as string, b.branch)
                          }>
                          Open it there
                        </Button>
                      )}
                    </>
                  )}
                  {b.worktree && !b.is_main && (
                    <Button size="sm" variant="danger"
                      title="Take this workspace away"
                      onClick={() => void removeWorktree(b)}>
                      Remove
                    </Button>
                  )}
                  {g.id === "cleanable" && !b.worktree && !b.protected && (
                    <Button size="sm" variant="danger"
                      title="Delete this local branch — its work is already on the base"
                      onClick={() => void deleteBranch(b)}>
                      Delete
                    </Button>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      ))}

      {cleanable > 0 && (
        <Button className="loose-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide" : `Show ${cleanable} safe to clean up`}
        </Button>
      )}
      {visible.length === 0 && !showAll && (
        <div className="tree-empty">Nothing left hanging — every branch is merged and clean.</div>
      )}
    </div>
  );
}

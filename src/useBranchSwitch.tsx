// The one funnel. Every route into a ref that moves — a branch switch, a
// snapshot, a pull request's head, a workspace of its own — goes through
// switchTo(). A git refusal is not an error to report; it is a question, asked
// here, once, in the one dialog this provider mounts.
//
// It lives in a provider rather than a hook that hands each caller a node to
// render, because the question must outlive the surface that asked it: a PR
// tab's "check it out locally" has to stay answerable while the Git panel —
// where this logic used to live — is not even mounted.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import * as ipc from "./ipc";
import {
  askDialog,
  errorDialog,
  savedBranchName,
  switchDialog,
  workspaceDialog,
  type CheckoutOutcome,
  type SwitchAction,
  type SwitchDialog,
} from "./branchSwitch";
import { BranchSwitchDialog } from "./components/BranchSwitchDialog";
import { postAttention, resolveAttentionByKey } from "./attention";
import { prWorktree } from "./prs";
import { useEscape } from "./useEscape";
import type { Notify } from "./types";
import { basename } from "./paths";

/** What the caller wants to be looking at. */
export type SwitchTarget =
  /** A branch, here, in this checkout. `create` starts it from HEAD. */
  | { kind: "branch"; branch: string; create?: boolean }
  /** A commit, tag or branch to look at without moving anything. */
  | { kind: "ref"; ref: string; label?: string }
  /** A pull request's head, here, in this checkout. */
  | { kind: "pr"; number: number; branch: string }
  /** A branch in a workspace of its own. `path` defaults to the canonical
   *  `${repo}-wt-${slug(branch)}`; `create` starts the branch from HEAD. */
  | { kind: "workspace"; branch: string; path?: string; create?: boolean }
  /** A PR's head in a workspace of its own — reuses one already holding it,
   *  otherwise fetches the PR's head into a new one, detached. */
  | { kind: "pr-workspace"; number: number; branch: string; path?: string };

export interface SwitchOptions {
  /** Who asked, for the copy — "the review loop", "the ticket you started".
   *  Shown when a dialog opens for something the user did not just click. */
  because?: string;
  /** Suppress the success notice; the caller posts its own. */
  quiet?: boolean;
}

export type SwitchResult =
  /** You are where you asked to be. `path` is the checkout to work in — the
   *  repo root, or the workspace we landed in / created. `created` says
   *  whether we made that workspace (so the caller knows to tear it down). */
  | {
      kind: "settled";
      path: string;
      branch: string | null;
      detached: boolean;
      created: boolean;
      message: string;
    }
  /** The question was closed without taking a way through. Not an error. */
  | { kind: "cancelled" }
  /** We asked, showed the detail, and there was no way through. Already on
   *  screen — the caller does not report it again. */
  | { kind: "refused"; detail: string };

export interface BranchSwitch {
  /** THE function. Runs the operation, turns any refusal into the dialog,
   *  runs whatever the user picks, and keeps asking until it settles. Never
   *  throws, and never resolves before the question on screen is answered. */
  switchTo(
    repo: string,
    target: SwitchTarget,
    opts?: SwitchOptions,
  ): Promise<SwitchResult>;

  /** Point this project's files, search and new terminals at a workspace —
   *  the "Open it there" action, with one label and one notice everywhere. */
  openThere(repo: string, path: string, branch: string | null): Promise<void>;

  /** Forget the workspace records whose folders are gone — the same command
   *  the "clear it" choice runs, for the surfaces that offer it outright. */
  cleanupWorkspaces(repo: string): Promise<void>;

  /** Ask any other question in the same shape, in the same single dialog.
   *  Resolves with the action chosen ("cancel" on backdrop/Escape). */
  ask(dialog: SwitchDialog): Promise<SwitchAction>;

  /** Bumped after every operation that moves a ref or a workspace. Put it in a
   *  refresh effect's deps instead of re-plumbing a callback. */
  version: number;
}

// ---------------------------------------------------------------------------
// Where a workspace goes. Written out in three places before this — the branch
// form in the Git panel and in ProjectView, the PR form twice more — so a
// rename of the convention only half-landed. One copy, exported so the guard
// test can see there is only one.

const slug = (branch: string) => branch.replace(/[^a-zA-Z0-9._-]+/g, "-");

/** A sibling of the repo, named after it: predictable, and never inside the
 *  repo itself (which would make the checkout track its own workspace). */
export const workspacePath = (repo: string, branch: string) =>
  `${repo}-wt-${slug(branch)}`;

/** The PR form. `taskHistory` reads this shape back to recognise a throwaway
 *  workspace, so the `-wt-pr-<n>` tail is load-bearing. */
export const prWorkspacePath = (repo: string, number: number) =>
  `${repo}-wt-pr-${number}`;

const baseName = (path: string) => basename(path.replace(/\/+$/, "")) || path;

/** The branch a target is about, for the copy and for "give it a workspace of
 *  its own". A bare ref is about no branch. */
const branchOf = (t: SwitchTarget): string | null =>
  t.kind === "ref" ? null : t.branch;

/** What the dialogs call this target. */
const nameOf = (t: SwitchTarget): string =>
  t.kind === "ref" ? (t.label ?? t.ref) : t.branch;

const isWorkspace = (t: SwitchTarget) =>
  t.kind === "workspace" || t.kind === "pr-workspace";

/** One attempt at a target: what came back, and where success would put us. */
interface Round {
  outcome: CheckoutOutcome;
  path: string;
  branch: string | null;
  detached: boolean;
  created: boolean;
}

// ---------------------------------------------------------------------------

const FALLBACK: BranchSwitch = {
  async switchTo() {
    console.warn("switchTo called outside a BranchSwitchProvider");
    return { kind: "refused", detail: "No branch-switch dialog is mounted." };
  },
  async openThere() {
    console.warn("openThere called outside a BranchSwitchProvider");
  },
  async cleanupWorkspaces() {
    console.warn("cleanupWorkspaces called outside a BranchSwitchProvider");
  },
  async ask() {
    console.warn("ask called outside a BranchSwitchProvider");
    return "cancel";
  },
  version: 0,
};

const Ctx = createContext<BranchSwitch | null>(null);

export function useBranchSwitch(): BranchSwitch {
  // Reading it outside the provider is survivable (a panel rendered on its own
  // in a test); *using* it is not, and says so in the console rather than
  // silently doing nothing.
  return useContext(Ctx) ?? FALLBACK;
}

export function BranchSwitchProvider({
  onNotice,
  onUseWorktree,
  projectId,
  projectName,
  visible = true,
  children,
}: {
  onNotice: Notify;
  /** ProjectView's redirection of the project's files at a workspace. The
   *  provider owns the copy and the notice; this only performs it. */
  onUseWorktree: (repo: string, path: string, branch: string) => void;
  /** The project this funnel belongs to, as two primitives rather than the
   *  record: the withdraw below is an unmount cleanup, and a prop whose
   *  identity changes every time the project is touched would fire it on a
   *  rename. Absent when the provider is mounted outside a project (a panel on
   *  its own in a test), which costs only the notification — the dialog still
   *  works. */
  projectId?: string;
  projectName?: string;
  /** Whether that project is the one on screen. The dialog is deliberately
   *  scoped to its project and goes off screen with it, so this is what tells
   *  the funnel its question has nobody looking at it. */
  visible?: boolean;
  children: ReactNode;
}): ReactElement {
  const [dialog, setDialog] = useState<SwitchDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  /** Set while a question is on screen: what to hand the waiting loop. */
  const answer = useRef<((a: SwitchAction) => void) | null>(null);
  /** A question is being asked right now — a second switch must not steal it. */
  const held = useRef(false);

  /** Put a question on screen and wait for it. The dialog stays mounted while
   *  the chosen operation runs, so a second refusal replaces the copy in place
   *  rather than flickering the whole thing away and back. */
  const present = useCallback(
    (d: SwitchDialog) =>
      new Promise<SwitchAction>((resolve) => {
        answer.current = resolve;
        setDialog(d);
        setBusy(false);
      }),
    [],
  );

  const close = useCallback(() => {
    answer.current = null;
    setDialog(null);
    setBusy(false);
  }, []);

  /** The question, said somewhere it can be seen.
   *
   *  The dialog stays inside its project on purpose — a switch question is
   *  about one repo, and answering it moves that checkout — so a project that
   *  is mounted but `display: none` asks into nothing. That was a stall with no
   *  symptom: the funnel refuses to stack a second question over a pending one,
   *  so every later switch in that project returned `cancelled` and nothing
   *  said why.
   *
   *  So the dialog does not move; the *question* is posted to the attention
   *  channel, naming the project and carrying a link back to it. Clicking it
   *  activates that tab, where the dialog has been waiting all along.
   *
   *  Posted on pending-and-hidden rather than at the moment it is raised, so
   *  tabbing away from a question you left open announces it too. The
   *  `dedupeKey` is the project's funnel, not this posting: coming back and
   *  leaving again updates one item instead of queueing a second.
   *
   *  Deliberately *not* withdrawn when the project becomes visible. Something
   *  is still waiting on you until the dialog closes, and the outstanding count
   *  should say so — retiring it on a mere glance is how the stall became
   *  invisible in the first place. */
  useEffect(() => {
    if (!projectId) return;
    const key = `switch:${projectId}`;
    if (dialog) {
      if (!visible)
        postAttention({
          kind: "question",
          // A git refusal is a question, not a fault. Urgency is `high` by
          // construction anyway — every question is — so the tone only picks
          // how it reads.
          tone: "warn",
          title: dialog.title,
          body: `${projectName ?? "A project you aren't looking at"} is waiting on an answer before it can go any further.`,
          source: "project",
          projectId,
          projectName,
          where: { kind: "project", projectId },
          dedupeKey: key,
        });
      return;
    }
    // The dialog is gone, so a choice was made — including "cancel", which is
    // an answer. Nothing is waiting any more.
    resolveAttentionByKey(key, "answered");
  }, [dialog, visible, projectId, projectName]);

  /** The project closed with a question still on screen. Nothing can answer it
   *  now, and an outstanding question nobody can resolve sits in the waiting
   *  count for good — worse than one that goes quiet. */
  useEffect(() => {
    if (!projectId) return;
    const key = `switch:${projectId}`;
    return () => resolveAttentionByKey(key, "withdrawn");
  }, [projectId]);

  const choose = useCallback((action: SwitchAction) => {
    const resolve = answer.current;
    if (!resolve) return; // a choice is already running
    answer.current = null;
    setBusy(true);
    resolve(action);
  }, []);

  const cancel = useCallback(() => choose("cancel"), [choose]);
  useEscape(cancel, dialog != null);

  const openThere = useCallback(
    async (repo: string, path: string, branch: string | null) => {
      onUseWorktree(repo, path, branch ?? "");
      // The dialog promises "nothing moves, nothing is lost"; say so afterwards
      // too, because the redirection is otherwise entirely silent.
      onNotice(
        `Files, search and new terminals now come from ${baseName(path)}. Your own checkout hasn't moved.`,
        "success",
      );
      setVersion((v) => v + 1);
    },
    [onNotice, onUseWorktree],
  );

  const ask = useCallback(
    async (d: SwitchDialog) => {
      if (held.current) return "cancel" as SwitchAction;
      held.current = true;
      try {
        return await present(d);
      } finally {
        close();
        held.current = false;
      }
    },
    [present, close],
  );

  /** The "Prune missing" button's operation. Not a switch, but the same command
   *  the "clear it" choice runs — so it lives here, where a refusal is a
   *  question in the one dialog instead of git's stderr in a toast. The version
   *  bump is what makes the lists that offered it redraw. */
  const cleanupWorkspaces = useCallback(
    async (repo: string) => {
      try {
        // "Try again" re-enters here, so a second refusal is a second question
        // rather than a dead end — the same shape switchTo keeps.
        for (;;) {
          try {
            const out = await ipc.gitWorktreePrune(repo);
            // git's own first line — a result, not a fault.
            if (out.trim()) onNotice(out.trim().split("\n")[0], "success");
            return;
          } catch (err) {
            const again = await ask(
              askDialog({
                title: "Couldn't clear the missing workspaces",
                body: "Git held on to at least one of them, so nothing was forgotten. The detail below is its own — it names the one it kept.",
                detail: String(err),
                choices: [
                  {
                    action: "retry",
                    label: "Try again",
                    sub: "Runs the same clear-up again. Nothing on disk is touched either way.",
                  },
                  { action: "cancel", label: "Leave them" },
                ],
              }),
            );
            if (again !== "retry") return;
          }
        }
      } finally {
        setVersion((v) => v + 1);
      }
    },
    [onNotice, ask],
  );

  const switchTo = useCallback(
    async (
      repo: string,
      target: SwitchTarget,
      opts: SwitchOptions = {},
    ): Promise<SwitchResult> => {
      if (held.current) {
        // Something the user did not click (the review loop arming itself) has
        // arrived on top of a question they are mid-answer on. Say who wanted
        // what; do not throw a second modal over the first.
        onNotice(
          `${opts.because ?? "Something"} wanted to open ${nameOf(target)}, but there's a question waiting for you. Answer it, then try again.`,
          "info",
        );
        return { kind: "cancelled" };
      }
      held.current = true;

      /** What we are trying now — rewritten by the choices that change the
       *  request itself ("start it here", "give it its own folder"). */
      let t: SwitchTarget = target;
      /** Run before the next attempt: the one explicit git operation a choice
       *  maps to. Every branch below is exactly one, and none of them discards
       *  anything silently. */
      let before: (() => Promise<CheckoutOutcome | void>) | null = null;
      /** Carry this checkout's uncommitted changes across on the next attempt. */
      let carry = false;

      /** One attempt: run the target's operation, say where success lands. */
      const attempt = async (): Promise<Round> => {
        switch (t.kind) {
          case "branch": {
            const out = carry
              ? await ipc.gitCheckoutCarry(repo, t.branch)
              : await ipc.gitCheckout(repo, t.branch, t.create ?? false);
            return {
              outcome: out,
              path: repo,
              branch: t.branch,
              detached: false,
              created: false,
            };
          }
          case "ref": {
            const out = await ipc.gitCheckoutDetached(repo, t.ref);
            return {
              outcome: out,
              path: repo,
              branch: null,
              detached: true,
              created: false,
            };
          }
          case "pr": {
            // A fork's branch may not exist locally at all, so carrying changes
            // across has to go through gh's own checkout, not the branch-shaped
            // one — the branch-shaped carry would be switching to nothing.
            const out = await ipc.ghPrCheckout(repo, t.number, carry);
            return {
              outcome: out,
              path: repo,
              branch: t.branch,
              detached: false,
              created: false,
            };
          }
          case "workspace": {
            // Bound before the closure below: `t` is rewritten between rounds,
            // so its narrowing doesn't survive into a callback.
            const want = t;
            const worktrees = await ipc.gitWorktrees(repo).catch(() => []);
            // One already holding it is the answer — a second checkout of the
            // same branch is not something git would allow anyway.
            const existing = worktrees.find(
              (w) => !w.is_main && w.branch === want.branch,
            );
            if (existing)
              return {
                outcome: {
                  kind: "switched",
                  message: `${t.branch} is already open in ${existing.name}`,
                  path: existing.path,
                },
                path: existing.path,
                branch: t.branch,
                detached: false,
                created: false,
              };
            const path = t.path ?? workspacePath(repo, t.branch);
            const out = await ipc.gitWorktreeAdd(repo, path, t.branch, t.create ?? false);
            if (out.kind === "switched") await ipc.workspaceAdd(path).catch(() => {});
            return {
              outcome: out,
              path,
              branch: t.branch,
              detached: false,
              created: out.kind === "switched",
            };
          }
          case "pr-workspace": {
            const worktrees = await ipc.gitWorktrees(repo).catch(() => []);
            // prWorktree only reads `branch`, and it is the tested answer to
            // "is one of these already holding this PR" — reuse it rather than
            // writing a second, subtly different match here.
            const existing = prWorktree(
              { branch: t.branch } as unknown as ipc.PrInfo,
              worktrees,
            );
            const path = t.path ?? existing?.path ?? prWorkspacePath(repo, t.number);
            if (existing)
              return {
                outcome: {
                  kind: "switched",
                  message: `#${t.number} is already open in ${existing.name}`,
                  path: existing.path,
                },
                path: existing.path,
                branch: null,
                // A PR workspace never claims the branch — git allows it in one
                // place at a time and that place is usually this checkout, so
                // the agent working there needs the detached push line.
                detached: true,
                created: false,
              };
            const out = await ipc.gitWorktreeAddPr(repo, path, t.number, t.branch);
            if (out.kind === "switched") await ipc.workspaceAdd(path).catch(() => {});
            return {
              outcome: out,
              path,
              branch: null,
              detached: true,
              created: out.kind === "switched",
            };
          }
        }
      };

      const settle = (r: Round, message: string): SwitchResult => {
        if (!opts.quiet) onNotice(message, "success");
        return {
          kind: "settled",
          path: r.path,
          branch: r.branch,
          detached: r.detached,
          created: r.created,
          message,
        };
      };

      try {
        // Keep asking until it settles. Every choice re-enters this loop, so a
        // second refusal is a second question rather than a dead end.
        for (;;) {
          let round: Round;
          try {
            // The step a choice runs *before* the switch can be refused too —
            // a locked workspace won't hand its branch over. Ask about that,
            // rather than about a switch we never got as far as running.
            let refused: CheckoutOutcome | undefined;
            if (before) {
              const run = before;
              before = null;
              const pre = await run();
              if (pre && pre.kind !== "switched") refused = pre;
            }
            round = refused
              ? {
                  outcome: refused,
                  path: repo,
                  branch: branchOf(t),
                  detached: false,
                  created: false,
                }
              : await attempt();
          } catch (err) {
            // The backend only throws when it couldn't run git at all.
            await present(errorDialog(nameOf(t), err));
            return { kind: "refused", detail: String(err) };
          } finally {
            carry = false;
          }

          const out = round.outcome;
          const d = isWorkspace(t)
            ? workspaceDialog(
                {
                  branch: branchOf(t) ?? nameOf(t),
                  pr: t.kind === "pr-workspace" ? t.number : undefined,
                },
                out,
              )
            : switchDialog(nameOf(t), out);

          // The three outcomes that mean you *are* where you asked to be. Two
          // of them still have something to say first.
          // `path` is set when the backend landed us somewhere other than the
          // repo root, and is what makes SwitchResult.path honest.
          if (out.kind === "switched")
            return settle({ ...round, path: out.path ?? round.path }, out.message);
          if (out.kind === "switched_with_leftovers") {
            const action = d ? await present(d) : "cancel";
            if (action === "keep-leftovers") {
              const sha = (out.commits[0] ?? "").trim().split(/\s+/)[0] ?? "";
              try {
                await ipc.gitBranchAt(repo, savedBranchName(sha), sha);
                onNotice(`Saved as ${savedBranchName(sha)}.`, "success");
              } catch (err) {
                await present(errorDialog(savedBranchName(sha), err));
              }
            }
            return settle(round, out.message);
          }
          if (out.kind === "changes_stashed") {
            // The switch happened — the changes simply wouldn't reapply. Saying
            // "cancelled" here would leave the caller believing nothing moved.
            if (d) await present(d);
            return settle(
              round,
              `You're on ${nameOf(t)}. Your changes are saved to one side.`,
            );
          }

          if (!d) return settle(round, "Done");

          const holder = out.kind === "branch_in_worktree" ? out.holder : null;
          const action = await present(d);

          switch (action) {
            case "cancel":
              return { kind: "cancelled" };

            case "open-there": {
              if (!holder) return { kind: "cancelled" };
              await openThere(repo, holder.path, holder.branch);
              return {
                kind: "settled",
                path: holder.path,
                branch: holder.branch,
                detached: false,
                created: false,
                message: `Opened ${baseName(holder.path)}.`,
              };
            }

            case "reuse-workspace": {
              const path = out.kind === "path_in_use" ? out.path : round.path;
              await ipc.workspaceAdd(path).catch(() => {});
              return settle(
                { ...round, path, created: false },
                `Using ${baseName(path)}.`,
              );
            }

            case "move-here": {
              const name = nameOf(t);
              before = () => ipc.gitBranchRelease(repo, name);
              break;
            }

            case "cleanup":
              before = async () => void (await ipc.gitWorktreePrune(repo));
              break;

            case "force-cleanup": {
              const path = holder?.path;
              before = async () => {
                // -f -f: the record is both missing and still claimed, and a
                // plain prune skips a claimed entry without a word.
                if (path) await ipc.gitWorktreeRemove(repo, path, 2);
                await ipc.gitWorktreePrune(repo);
              };
              break;
            }

            case "snapshot":
              // For a workspace request this is "make one at the pull request's
              // head instead" — the same command, at the PR form of the path.
              // Everywhere else a snapshot is a look from here that moves
              // nothing.
              t =
                t.kind === "pr-workspace"
                  ? { ...t, path: t.path ?? prWorkspacePath(repo, t.number) }
                  : { kind: "ref", ref: nameOf(t), label: nameOf(t) };
              break;

            case "carry":
              carry = true;
              break;

            case "open-elsewhere": {
              const branch = branchOf(t);
              if (!branch) return { kind: "cancelled" };
              t =
                t.kind === "pr"
                  ? { kind: "pr-workspace", number: t.number, branch }
                  : { kind: "workspace", branch };
              break;
            }

            case "stop-operation":
              before = async () => void (await ipc.gitOperationQuit(repo));
              break;

            case "retry":
              break;

            case "fetch-retry":
              before = async () => void (await ipc.gitFetch(repo));
              break;

            case "create-here":
              // A snapshot is the usual way here — "there's nothing called x"
              // comes from the look-without-moving path — and starting it here
              // means a branch, not a second look at a name that resolves to
              // nothing. Rewriting the request is the whole point of the loop.
              if (t.kind === "ref")
                t = { kind: "branch", branch: nameOf(t), create: true };
              else if (t.kind === "branch" || t.kind === "workspace")
                t = { ...t, create: true };
              break;

            case "switch-existing":
              if (t.kind === "branch" || t.kind === "workspace")
                t = { ...t, create: false };
              break;

            case "keep-leftovers":
              // Only reachable from the leftovers outcome, handled above.
              return { kind: "cancelled" };
          }
        }
      } finally {
        close();
        held.current = false;
        setVersion((v) => v + 1);
      }
    },
    [onNotice, openThere, present, close],
  );

  const value = useMemo<BranchSwitch>(
    () => ({ switchTo, openThere, cleanupWorkspaces, ask, version }),
    [switchTo, openThere, cleanupWorkspaces, ask, version],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* One dialog, mounted once, above every surface that can ask. */}
      {dialog && (
        <BranchSwitchDialog dialog={dialog} busy={busy} onChoose={choose} />
      )}
    </Ctx.Provider>
  );
}

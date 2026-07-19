// The issue-tracker provider registry. Adding a tracker (Jira, GitLab, …) is:
// one object here (+ a Rust fetch command if it needs one). The Trackers
// panel renders whatever this array contains and knows nothing about any
// specific tracker.
//
// Two kinds of provider so far, and the design keeps both cheap:
//   - CLI-inherited (GitHub): shells out to a tool the user already
//     authenticated (`gh`), zero configuration, on by default.
//   - Key-based (Linear): opt-in via a secret the user pastes once, stored in
//     local settings only (trackerKeys) and sent nowhere except the tracker's
//     own API, straight from this machine.
import * as ipc from "./ipc";
import { getSettings, updateSettings } from "./settings";

export interface TrackerAvailability {
  ok: boolean;
  /** Why not, phrased for the panel ("needs the GitHub CLI", "connect…"). */
  reason?: string;
}

export interface TrackerProvider {
  id: string;
  name: string;
  /** Per-repo tickets (GitHub) get called once per project repo; global
   *  trackers (Linear) get called once with the first repo. */
  scope: "repo" | "global";
  available(repos: string[]): Promise<TrackerAvailability>;
  fetch(repo: string): Promise<ipc.TicketInfo[]>;
  /** Present when the provider needs a pasted secret to activate. */
  config?: { label: string; placeholder: string; help: string };
}

export const trackerKey = (id: string): string =>
  getSettings().trackerKeys[id] ?? "";

export const setTrackerKey = (id: string, key: string) =>
  updateSettings({ trackerKeys: { ...getSettings().trackerKeys, [id]: key } });

const github: TrackerProvider = {
  id: "github",
  name: "GitHub Issues",
  scope: "repo",
  // Inherits `gh` auth exactly like the PR panel — no token of our own.
  available: async () =>
    (await ipc.ghAvailable())
      ? { ok: true }
      : {
          ok: false,
          reason:
            "Needs the GitHub CLI: brew install gh, then gh auth login in a terminal.",
        },
  fetch: (repo) => ipc.ghIssueList(repo),
};

const linear: TrackerProvider = {
  id: "linear",
  name: "Linear",
  scope: "global",
  available: async () =>
    trackerKey("linear")
      ? { ok: true }
      : { ok: false, reason: "connect" },
  fetch: () => ipc.linearIssues(trackerKey("linear")),
  config: {
    label: "Personal API key",
    placeholder: "lin_api_…",
    help:
      "Create one under Linear → Settings → Security & access → Personal API keys. " +
      "Stored locally on this machine only; sent nowhere except api.linear.app.",
  },
};

export const TRACKERS: TrackerProvider[] = [github, linear];

/** The worktree already holding this ticket's work, if any. Providers with a
 *  suggested branch (Linear's branchName) match it exactly; number-id
 *  trackers (GitHub #42) match the "42-slug" convention GitHub's own
 *  "create a branch" uses. */
export function ticketWorktree(
  ticket: ipc.TicketInfo,
  worktrees: ipc.WorktreeInfo[],
): ipc.WorktreeInfo | undefined {
  return worktrees.find((w) => {
    if (!w.branch || w.is_main) return false;
    if (ticket.branch) {
      return w.branch === ticket.branch || w.branch.endsWith(`/${ticket.branch}`);
    }
    const num = ticket.id.replace(/^#/, "");
    if (!/^\d+$/.test(num)) return false;
    const tail = w.branch.split("/").pop() ?? w.branch;
    return new RegExp(`^${num}([^0-9]|$)`).test(tail) || tail === `issue-${num}`;
  });
}

/** The branch to start work on: the tracker's suggestion, else the GitHub
 *  convention derived from id + title. */
export function ticketBranch(ticket: ipc.TicketInfo): string {
  if (ticket.branch) return ticket.branch;
  const num = ticket.id.replace(/^#/, "");
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${num}-${slug}` : `issue-${num}`;
}

/** The opening context typed into the agent when work starts on a ticket.
 *  Single-quoted for the shell. */
export function ticketCommand(ticket: ipc.TicketInfo): string {
  const ctx =
    `Pick up ticket ${ticket.id}: "${ticket.title}" (${ticket.url}). ` +
    `Read the ticket, look around the code, propose a plan, then start working.`;
  return `claude '${ctx.replaceAll("'", `'\\''`)}'`;
}

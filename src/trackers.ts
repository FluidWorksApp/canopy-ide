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

export const setTrackerKey = (id: string, key: string) => {
  updateSettings({ trackerKeys: { ...getSettings().trackerKeys, [id]: key } });
  // The Issues panel refreshes itself on this — connecting a tracker in
  // Settings shows its issues without a manual reload.
  window.dispatchEvent(new CustomEvent("canopy:trackers-changed"));
};

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

/** The opening context an agent gets when a ticket is handed to it. */
export function ticketContext(ticket: ipc.TicketInfo): string {
  return (
    `Pick up ticket ${ticket.id}: "${ticket.title}" (${ticket.url}). ` +
    `Read the ticket, look around the code, propose a plan, then start working.`
  );
}

// Starting an agent on a ticket lives in projects.ts (startCommand) so every
// registered CLI can do it — this module used to hardcode `claude`.

// ---------- unified status ----------
// Every tracker's states fold into four buckets so the panel can present ONE
// status-grouped list regardless of source. Provider state_type values:
// GitHub: open/closed; Linear: triage/backlog/unstarted/started (completed/
// canceled are filtered out at fetch). New providers map here too.

export type UnifiedStatus = "in_progress" | "todo" | "backlog" | "done";

export const STATUS_ORDER: UnifiedStatus[] = ["in_progress", "todo", "backlog", "done"];

export const STATUS_LABELS: Record<UnifiedStatus, string> = {
  in_progress: "In progress",
  todo: "Todo",
  backlog: "Backlog",
  done: "Done",
};

export function unifiedStatus(t: ipc.TicketInfo): UnifiedStatus {
  switch (t.state_type) {
    case "started":
      return "in_progress";
    case "backlog":
      return "backlog";
    case "closed":
    case "completed":
    case "canceled":
      return "done";
    default:
      return "todo"; // open, unstarted, triage — actionable but not started
  }
}

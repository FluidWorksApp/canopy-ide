// A git link clicked somewhere that belongs to no one project — team chat —
// and the project that can actually open it.
//
// Every link click is answered by the project in front (links.ts → the
// visible ProjectView → openGitLink). That is right for a link inside a
// project: a PR body, a terminal, a review comment are all about that
// project's repos. Team chat is not. It is mounted inside whichever project
// happens to be in front, but a teammate's "can you look at
// github.com/acme/api/pull/812" is about acme/api wherever that is checked
// out — and when it is checked out in another open project, the native PR tab
// over there beats a web page here.
//
// So for those links only (OpenUrlDetail.anyProject), a link the project in
// front cannot open is offered to App, which asks each *other* open project
// the same question resolveGitLink already answers, and switches to the first
// that says yes. Nobody says yes → the caller's fallback runs, which is the
// preview page it would have opened anyway. A link is never swallowed.
import {
  parseGitLink,
  pathInRepo,
  resolveGitLink,
  type GitLinkLookups,
} from "./gitLinks";
import * as ipc from "./ipc";

/** ProjectView → App: "I can't open this natively; can another project?"
 *  Cancelled by App when it takes the question — then App runs `fallback`
 *  itself if no project can. Not cancelled means no App listener: the caller
 *  falls back on the spot. */
export const ROUTE_GIT_LINK_EVENT = "canopy:route-git-link";

/** App → one ProjectView: open this URL, natively if you can. */
export const OPEN_GIT_LINK_EVENT = "canopy:open-git-link";

export interface RouteGitLinkDetail {
  url: string;
  /** The project that already said no — not asked again. */
  from: string;
  fallback: () => void;
}

export interface OpenGitLinkDetail {
  projectId: string;
  url: string;
}

/** What App knows about an open project: enough to build its lookups. */
export interface RoutableProject {
  id: string;
  repos: readonly string[];
}

/** The first project that can open this URL as a native tab, or null. Only
 *  PR / issue / commit / file URLs are considered; anything else is null
 *  without a single lookup. Projects are asked in the order given. */
export async function projectForGitLink(
  url: string,
  projects: readonly RoutableProject[],
  lookupsFor: (repos: readonly string[]) => GitLinkLookups,
): Promise<string | null> {
  if (!parseGitLink(url)) return null;
  for (const project of projects) {
    if (!project.repos.length) continue;
    const action = await resolveGitLink(url, lookupsFor(project.repos)).catch(
      () => null,
    );
    if (action) return project.id;
  }
  return null;
}

/** ProjectView side: offer a link this project couldn't open to the other open
 *  projects. Returns false when nothing took the question — the caller then
 *  falls back itself, synchronously. */
export function routeGitLinkElsewhere(
  url: string,
  from: string,
  fallback: () => void,
): boolean {
  if (!parseGitLink(url)) return false;
  return !window.dispatchEvent(
    new CustomEvent<RouteGitLinkDetail>(ROUTE_GIT_LINK_EVENT, {
      detail: { url, from, fallback },
      cancelable: true,
    }),
  );
}

// ---------- share cards ----------
// A card in team chat has already resolved to a checkout (resolveShareCard)
// when its button is clicked, so the question is only *which open project*
// holds that checkout. ChatCard → App (ROUTE) → the project → ProjectView
// (OPEN), on the same 80ms hand-off as a link.

/** ChatCard → App: open this resolved card in the project that has `repo`. */
export const ROUTE_SHARE_ACTION_EVENT = "canopy:route-share-action";
/** App → one ProjectView: open this resolved card. */
export const OPEN_SHARE_ACTION_EVENT = "canopy:open-share-action";

/** The native things a card can open in a project. */
export type ShareOpen =
  | { do: "pr"; repo: string; pr: ipc.PrInfo }
  | { do: "commit"; repo: string; commit: ipc.CommitDetail }
  | { do: "file"; repo: string; path: string; line?: number };

export interface RouteShareActionDetail {
  action: ShareOpen;
  /** Runs when no open project holds the checkout any more. */
  fallback: () => void;
}
export interface OpenShareActionDetail {
  projectId: string;
  action: ShareOpen;
}

/** The open project holding `repo` (a component path), preferring the one in
 *  front. */
export function projectForRepo(
  repo: string,
  projects: readonly RoutableProject[],
  activeId?: string | null,
): string | null {
  const holds = (p: RoutableProject) => p.repos.includes(repo);
  const active = projects.find((p) => p.id === activeId && holds(p));
  return (active ?? projects.find(holds))?.id ?? null;
}

/** ChatCard side: ask App to open a resolved card. False when nothing is
 *  listening — the caller then shows the page instead. */
export function routeShareAction(action: ShareOpen, fallback: () => void): boolean {
  return !window.dispatchEvent(
    new CustomEvent<RouteShareActionDetail>(ROUTE_SHARE_ACTION_EVENT, {
      detail: { action, fallback },
      cancelable: true,
    }),
  );
}

/** The lookups openGitLink has always used, for any set of checkouts — one
 *  copy, so the project in front and App's cross-project question can never
 *  disagree about whether a link is "here". */
export function ipcGitLinkLookups(repos: readonly string[]): GitLinkLookups {
  return {
    repos,
    remoteUrl: (repo) => ipc.gitRemoteUrl(repo),
    prs: (repo) => ipc.ghPrList(repo),
    issues: (repo) => ipc.ghIssueList(repo),
    commit: (repo, hash) => ipc.gitCommitDetail(repo, hash),
    fileExists: (repo, path) => {
      const full = pathInRepo(repo, path);
      return full ? ipc.fsStat(full).then((s) => !s.is_dir) : Promise.resolve(false);
    },
  };
}

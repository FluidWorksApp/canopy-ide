// A link to a pull request, a commit, an issue or a file, pointed at a git
// host — and what Canopy already has a native tab for.
//
// Every one of these arrived as a URL and left as a web page: a "#1363" in a
// PR body, a commit URL in a review comment, a blob link in an agent's report
// all opened a preview of github.com rather than the PR tab, the commit tab and
// the editor sitting one panel away. The rendering is worse and the page is
// dead — no diff of your own, no comment box that posts through `gh`, no
// jumping to the symbol.
//
// So this module answers two questions and opens nothing: what is this URL
// about (parseGitLink), and is that thing actually here (resolveGitLink). The
// view does the opening — it owns the tabs — and falls back to a preview page
// for every URL these two decline (see openGitLink in ProjectView).
//
// Recognising a shape is never a promise that the thing exists. A PR number
// from a fork, a commit that was never fetched, a blob path on a branch we
// don't have: all of them are checked before a tab is promised, because a link
// that lands on the wrong thing is worse than one that opens a web page.
import type * as ipc from "./ipc";
import { repoLabel } from "./prs";
import {
  cardUrl,
  validCardPath,
  validRepo,
  type Card,
  type RepoRef,
} from "./teamMessaging/cardSchema";

/** What a git-host URL is about. `slug` is the host's own `owner/name` —
 *  matched against a checkout's origin, never used as a path. */
export type GitLink =
  | { kind: "pr"; slug: string; number: number }
  | { kind: "issue"; slug: string; number: number }
  | { kind: "commit"; slug: string; hash: string }
  /** `path` is repo-relative; `line` is the `#L12` anchor if there was one. */
  | { kind: "file"; slug: string; path: string; line?: number };

/** The segment that says what the rest of the path means. GitLab puts a `-`
 *  before it and calls a PR a merge request; the shapes are otherwise the
 *  same, and a self-hosted GitHub Enterprise host is identical to github.com. */
const MARKERS = new Set([
  "pull",
  "pulls",
  "merge_requests",
  "issues",
  "issue",
  "commit",
  "commits",
  "blob",
]);

const HEX = /^[0-9a-f]{7,40}$/i;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `#L12`, `#L12-L20`, `#L12-20` — the first line is the one to reveal. */
function lineFromHash(hash: string): number | undefined {
  const m = /^#L(\d+)/i.exec(hash);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Control characters, and the bidi overrides/isolates that make a name render
// as something it isn't (U+202A–U+202E, U+2066–U+2069).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

/** A blob link's path, joined from already-decoded segments — or null when any
 *  segment could step outside the checkout or hide what it is.
 *
 *  Segments are decoded one by one (`decode`), so `..%2F..%2Fetc%2Fhosts` is a
 *  single segment that *becomes* `../../etc/hosts`; the WHATWG parser's own
 *  dot-segment handling never saw it. A teammate's link must not be able to
 *  open a file outside the repo it names, so this refuses rather than repairs:
 *  `.`/`..`, an embedded `/` or `\`, control and bidi characters, a drive
 *  letter, and anything inside `.git`. Null means "open the page instead". */
export function safeRepoPath(segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return null;
    if (seg.includes("/") || seg.includes("\\")) return null;
    if (UNSAFE_CHARS.test(seg)) return null;
    if (seg.toLowerCase() === ".git") return null;
  }
  if (/^[a-z]:/i.test(segments[0])) return null;
  return segments.join("/");
}

/** `repo/path`, only when `path` is a plain relative path that stays inside
 *  `repo` — the last check before anything on disk is touched. */
export function pathInRepo(repo: string, path: string): string | null {
  if (!path || path.startsWith("/") || path.startsWith("\\")) return null;
  const rel = safeRepoPath(path.split("/"));
  if (!rel) return null;
  const root = repo.replace(/[/\\]+$/, "");
  if (!root) return null;
  return `${root}/${rel}`;
}

/** What this URL is about, or null for every URL that is not one of these four
 *  things — a repo's home page, a wiki, a release, anything on another site.
 *  Null is the ordinary answer, not a failure: the caller opens a page. */
export function parseGitLink(href: string): GitLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const segs = url.pathname.split("/").filter(Boolean).map(decode);
  // Owner and name come first, so a marker can never be earlier than the third
  // segment. Search from there rather than from zero: a repo actually named
  // `commit` or `issues` is legal, and its own URLs must not read as a target.
  const at = segs.findIndex((s, i) => i >= 2 && MARKERS.has(s));
  if (at < 0) return null;

  // GitLab's `-` separates the repo path from the route; it is punctuation, not
  // part of the slug. Nested groups keep every segment — the match downstream
  // compares the last two, which is what an origin URL carries anyway.
  const owner = segs.slice(0, at).filter((s) => s !== "-");
  if (owner.length < 2) return null;
  const slug = owner.join("/");
  const rest = segs.slice(at + 1);
  if (rest.length === 0) return null;

  switch (segs[at]) {
    case "pull":
    case "pulls":
    case "merge_requests": {
      // Trailing `/files`, `/commits`, a `#discussion_r…` anchor: still the PR.
      const n = Number(rest[0]);
      return Number.isInteger(n) && n > 0 ? { kind: "pr", slug, number: n } : null;
    }
    case "issues":
    case "issue": {
      const n = Number(rest[0]);
      return Number.isInteger(n) && n > 0 ? { kind: "issue", slug, number: n } : null;
    }
    case "commit":
    case "commits":
      // `/commits/main` is a branch listing, not a commit — only a hash counts.
      return HEX.test(rest[0]) ? { kind: "commit", slug, hash: rest[0] } : null;
    case "blob": {
      // `blob/<ref>/<path…>`. A branch with a slash in it (`feat/x`) is
      // indistinguishable from the path here, so the first segment is taken as
      // the ref and the guess degrades honestly: the path won't exist on disk
      // and the caller opens the page instead of the wrong file.
      const path = safeRepoPath(rest.slice(1));
      if (!path) return null;
      return { kind: "file", slug, path, line: lineFromHash(url.hash) };
    }
    default:
      return null;
  }
}

/** Is this checkout's origin the repo the link names? Compared on the last two
 *  segments — `git@github.com:owner/name.git`, `https://host/owner/name` and a
 *  nested GitLab group all reduce to the same `owner/name`. */
export function remoteMatchesSlug(remoteUrl: string, slug: string): boolean {
  const remote = repoLabel(remoteUrl, "").toLowerCase();
  if (!remote.includes("/")) return false;
  return remote === slug.split("/").slice(-2).join("/").toLowerCase();
}

// ---------- resolution ----------
// Shape alone opens nothing. Between "this URL is a PR" and "open this tab"
// sits the only question that matters: is that thing *here*, now — in a repo
// this project has checked out, in a list `gh` still returns, at a path on
// disk. Every no lands back in the browser.
//
// The lookups are injected rather than imported so this stays a decision and
// not a side effect: the view passes its ipc calls, a test passes a fixture,
// and the fallbacks (a fork's PR, an unfetched commit, a /issues/ URL that is
// really a PR) are covered without a GitHub round trip.

/** What the view should open. Null means "nothing native fits — show the page". */
export type GitLinkAction =
  | { do: "pr"; repo: string; pr: ipc.PrInfo }
  | { do: "ticket"; repo: string; ticket: ipc.TicketInfo }
  | { do: "commit"; repo: string; commit: ipc.CommitDetail }
  | { do: "file"; repo: string; path: string; line?: number };

export interface GitLinkLookups {
  /** Checkout paths in the project, in the order they should be tried. */
  repos: readonly string[];
  /** A checkout's origin URL; "" (or a rejection) for one with no remote. */
  remoteUrl(repo: string): Promise<string>;
  /** Open pull requests, as the PRs panel already lists them. */
  prs(repo: string): Promise<ipc.PrInfo[]>;
  issues(repo: string): Promise<ipc.TicketInfo[]>;
  /** Resolve a hash in this checkout — this is also the existence check. */
  commit(repo: string, hash: string): Promise<ipc.CommitDetail>;
  /** True when a repo-relative path is a file here, on the branch checked out. */
  fileExists(repo: string, path: string): Promise<boolean>;
}

const or = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
  p.catch(() => fallback);

/** The one checkout whose origin is the repo this link names, or null. */
async function repoForSlug(
  slug: string,
  look: GitLinkLookups,
): Promise<string | null> {
  for (const repo of look.repos) {
    if (remoteMatchesSlug(await or(look.remoteUrl(repo), ""), slug)) return repo;
  }
  return null;
}

/** What to open for a clicked URL, having checked that it is really here. */
export async function resolveGitLink(
  href: string,
  look: GitLinkLookups,
): Promise<GitLinkAction | null> {
  const link = parseGitLink(href);
  if (!link) return null;
  const repo = await repoForSlug(link.slug, look);
  if (!repo) return null;

  const asPr = async (number: number): Promise<GitLinkAction | null> => {
    const pr = (await or(look.prs(repo), [])).find((p) => p.number === number);
    return pr ? { do: "pr", repo, pr } : null;
  };

  switch (link.kind) {
    case "pr":
      return asPr(link.number);
    case "issue": {
      const ticket = (await or(look.issues(repo), [])).find(
        (t) => t.id === `#${link.number}`,
      );
      if (ticket) return { do: "ticket", repo, ticket };
      // Issues and pull requests share one number line, and GitHub redirects a
      // typed /issues/12 to /pull/12 when 12 is a PR. Follow that here too.
      return asPr(link.number);
    }
    case "commit": {
      const commit = await look.commit(repo, link.hash).catch(() => null);
      return commit ? { do: "commit", repo, commit } : null;
    }
    case "file": {
      // parseGitLink already refused unsafe paths; a GitLink can also be built
      // by hand, so check again before the lookup touches the disk.
      if (!pathInRepo(repo, link.path)) return null;
      const here = await or(look.fileExists(repo, link.path), false);
      return here ? { do: "file", repo, path: link.path, line: link.line } : null;
    }
  }
}

// ---------- share cards ----------
// A teammate's share card (teamMessaging/cardSchema.ts) names a repository by
// host and `owner/name`, never by a path, and its subject by number, full
// commit id and repo-relative path. Resolving one is the same question as a
// link — is that thing here? — asked a little more strictly: the whole slug and
// the host must match, and a file must survive a Rust containment check that
// follows symlinks before anything is offered.

/** `{host, slug}` for an origin URL — ssh, scp-style or https, with or without
 *  `.git` — or null when it is not a URL a card can name (no origin, a local
 *  path, an odd host). Credentials and ssh ports are dropped: a card never
 *  carries either. */
export function repoRefFromRemote(remoteUrl: string): RepoRef | null {
  const raw = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!raw) return null;
  let host = "";
  let path = "";
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!/^(https?|ssh|git|git\+ssh|ssh\+git):$/.test(url.protocol)) return null;
    host = url.hostname.toLowerCase();
    // A web port is part of where the web page is; an ssh port is not.
    if (url.port && /^https?:$/.test(url.protocol)) host += `:${url.port}`;
    path = url.pathname;
  } else if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    return null;
  }
  const slug = path.split("/").filter(Boolean).join("/").replace(/\.git$/i, "");
  const ref = { host, slug };
  return validRepo(ref) ? ref : null;
}

/** Is this checkout's origin the repo a card names? The whole slug, case-
 *  insensitively, and the host — except for an ssh alias (`work:owner/repo`
 *  through ~/.ssh/config), whose "host" is not a hostname at all. */
export function remoteMatchesRepo(remoteUrl: string, repo: RepoRef): boolean {
  const here = repoRefFromRemote(remoteUrl);
  if (!here) return false;
  if (here.slug.toLowerCase() !== repo.slug.toLowerCase()) return false;
  return here.host === repo.host || !here.host.includes(".");
}

/** What a card's buttons do here. `web` means no checkout (or nothing in it)
 *  answers: open the canonical page on the host. `none` means the card is its
 *  own content (terminal output, a report about no PR). */
export type ShareAction =
  | { do: "pr"; repo: string; pr: ipc.PrInfo }
  | { do: "commit"; repo: string; commit: ipc.CommitDetail }
  | {
      do: "file";
      repo: string;
      path: string;
      line?: number;
      /** The commit the card was shared at. */
      rev: string;
      /** This checkout's HEAD ("" when unknown). */
      head: string;
      /** The working copy has the file, inside the repo. */
      exists: boolean;
    }
  | { do: "web"; url: string; host: string; repo?: string }
  | { do: "none" };

export interface ShareCardLookups extends GitLinkLookups {
  /** This checkout's HEAD, full id. */
  head(repo: string): Promise<string>;
  /** The file's real path when it exists and stays inside the repo after
   *  every symlink (fs_repo_path); rejects otherwise. */
  containedPath(repo: string, path: string): Promise<string>;
}

/** The checkout whose origin is the card's repo, or null. */
export async function repoForRef(
  ref: RepoRef,
  look: Pick<GitLinkLookups, "repos" | "remoteUrl">,
): Promise<string | null> {
  for (const repo of look.repos) {
    if (remoteMatchesRepo(await or(look.remoteUrl(repo), ""), ref)) return repo;
  }
  return null;
}

/** What to open for a share card, having checked it is really here. Never
 *  opens anything itself; the card's buttons act on the answer. */
export async function resolveShareCard(
  card: Card,
  look: ShareCardLookups,
): Promise<ShareAction> {
  const ref = "repo" in card ? card.repo : undefined;
  const web = (repo?: string): ShareAction => {
    const url = cardUrl(card);
    return url && ref ? { do: "web", url, host: ref.host, ...(repo ? { repo } : {}) } : { do: "none" };
  };
  if (!ref) return { do: "none" };
  const repo = await repoForRef(ref, look);
  if (!repo) return web();
  const asPr = async (number: number): Promise<ShareAction | null> => {
    const pr = (await or(look.prs(repo), [])).find((p) => p.number === number);
    return pr ? { do: "pr", repo, pr } : null;
  };
  switch (card.type) {
    case "pr":
    case "review-request":
    case "review-outcome":
      return (await asPr(card.number)) ?? web(repo);
    case "report":
      return card.pr ? ((await asPr(card.pr)) ?? web(repo)) : { do: "none" };
    case "handoff":
      // A hand-off names its repo for context only; "Take over" is its action.
      return { do: "none" };
    case "diff": {
      if (card.pr) {
        const pr = await asPr(card.pr);
        if (pr) return pr;
      }
      const commit = await look.commit(repo, card.head).catch(() => null);
      return commit ? { do: "commit", repo, commit } : web(repo);
    }
    case "file": {
      // cardSchema validated the path on arrival; check again before the disk
      // is touched, then let Rust resolve symlinks and hold it to the repo.
      if (!validCardPath(card.path) || !pathInRepo(repo, card.path)) return web(repo);
      const exists = await look
        .containedPath(repo, card.path)
        .then(() => true)
        .catch(() => false);
      const head = await or(look.head(repo), "");
      return { do: "file", repo, path: card.path, line: card.lines?.start, rev: card.rev, head, exists };
    }
    case "terminal":
      return { do: "none" };
  }
}

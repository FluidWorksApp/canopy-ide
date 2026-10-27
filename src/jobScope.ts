// Which project a mesh job belongs in, decided by repository identity alone.
//
// A job crossing machines used to name a workspace by its *name*, and the
// receiver's "Run in" picker fell back to whichever project came first — so a
// job about one repository ran, after an unread approval, in another. Folder
// layouts and project names differ from person to person; the one thing two
// machines agree on is the repository's origin remote. So the sender attaches
// host + `owner/name` (never a local path), plus the folder inside the repo it
// was working in, and the receiver runs the job in its own checkout whose
// origin is that repository — or, when it has none, asks its user.
//
// Nothing here compares project names, folder names or absolute paths.

import { repoRefFromRemote } from "./gitLinks";
import * as ipc from "./ipc";
import {
  MAX_SCOPE_REPOS,
  validJobRepo,
  validJobScope,
  type JobRepo,
  type JobScope,
} from "./teamMessaging/jobSchema";

/** The submitting terminal's checkout, as the bridge read it. */
export interface SenderRepo {
  origin: string;
  path: string;
  branch: string;
}

/** `owner/name`, or `host/owner/name` when the host is known. */
export const repoName = (repo: JobRepo) => repo.slug;
export const repoFullName = (repo: JobRepo) => (repo.host ? `${repo.host}/${repo.slug}` : repo.slug);

/** A clone URL for a repository, when its host is a real hostname. */
export function cloneUrlFor(repo: JobRepo): string | null {
  return repo.host && repo.host.includes(".") ? `https://${repo.host}/${repo.slug}.git` : null;
}

/** A repository an agent named: a clone URL (https, ssh, scp-style), a
 *  `host/owner/name`, or a bare `owner/name`. Null when it is none of them. */
export function parseRepoArg(text: string): JobRepo | null {
  const raw = text.trim();
  if (!raw) return null;
  const fromRemote = repoRefFromRemote(raw);
  if (fromRemote) return fromRemote;
  const parts = raw.replace(/\.git$/i, "").split("/").filter(Boolean);
  // A first segment with a dot is a host (`github.com/acme/api`); otherwise
  // the whole thing is the slug and the host is left unsaid.
  const candidate: JobRepo =
    parts.length >= 3 && parts[0].includes(".")
      ? { host: parts[0].toLowerCase(), slug: parts.slice(1).join("/") }
      : { slug: parts.join("/") };
  return validJobRepo(candidate) ? candidate : null;
}

/** Same repository? The slug case-insensitively; the host too when both
 *  sides know it, except an ssh alias (`work:acme/api`), whose "host" is not a
 *  hostname. */
export function sameRepo(a: JobRepo, b: JobRepo): boolean {
  if (a.slug.toLowerCase() !== b.slug.toLowerCase()) return false;
  if (!a.host || !b.host) return true;
  return a.host === b.host || !a.host.includes(".") || !b.host.includes(".");
}

/** Is this checkout's origin (as git has it) the repository named? A checkout
 *  with no origin, or a local-path origin, never matches. */
export function originMatches(origin: string, repo: JobRepo): boolean {
  const here = repoRefFromRemote(origin);
  return !!here && sameRepo(here, repo);
}

/** The scope a submitted job carries: the repositories the agent named, else
 *  the one its terminal is in. The folder and branch go along only when they
 *  describe the job's first repository. Throws on a name that is not a
 *  repository, so the agent hears it rather than the receiver guessing. */
export function buildScope(sender: SenderRepo | null | undefined, named: readonly string[] = []): JobScope | undefined {
  const own = sender?.origin ? repoRefFromRemote(sender.origin) : null;
  const repos: JobRepo[] = [];
  for (const text of named) {
    const repo = parseRepoArg(text);
    if (!repo) throw new Error(`"${text}" isn't a repository — name it as owner/name or by its clone URL.`);
    if (!repos.some((r) => sameRepo(r, repo))) repos.push(repo);
  }
  if (repos.length > MAX_SCOPE_REPOS) throw new Error(`A job names at most ${MAX_SCOPE_REPOS} repositories.`);
  if (!repos.length) {
    if (!own) return undefined;
    repos.push(own);
  }
  // The terminal's own checkout fills in the host the agent left out.
  const primaryIsOwn = !!own && sameRepo(repos[0], own);
  if (primaryIsOwn && !repos[0].host) repos[0] = own;
  const scope: JobScope = { repos };
  if (primaryIsOwn && sender) {
    const path = sender.path.replace(/^\/+|\/+$/g, "");
    if (path) scope.path = path;
    if (sender.branch) scope.branch = sender.branch;
  }
  // Anything odd about the folder or branch (a control character, a `..`) is
  // dropped rather than refusing the job: they are hints, the repo is the scope.
  if (validJobScope(scope)) return scope;
  const bare: JobScope = { repos };
  return validJobScope(bare) ? bare : undefined;
}

/** One of the receiver's project components and the checkout it lives in. */
export interface Checkout {
  /** The project, by name: what the card shows and startSession takes. */
  project: string;
  /** The component's directory: where the job's agent starts. */
  dir: string;
  /** The component's folder inside its repository ("" for the repo root). */
  rel: string;
  /** origin's URL as git has it; "" when there is none. */
  origin: string;
  /** The repository's main checkout rather than a linked worktree. */
  main: boolean;
}

/** Where an incoming job runs:
 *  - matched: a checkout here is the job's repository; `choices` are all such
 *    checkouts, best first (the first is where it runs unless changed).
 *  - missing: the job names a repository that no project here has.
 *  - none: the job carries no repository (an older sender, or a terminal
 *    outside any checkout). */
export type Placement =
  | { kind: "matched"; repo: JobRepo; choices: Checkout[] }
  | { kind: "missing"; repo: JobRepo }
  | { kind: "none" };

const within = (rel: string, path: string) => !rel || path === rel || path.startsWith(`${rel}/`);

/** Match a job's scope against this machine's checkouts by origin remote. */
export function place(scope: JobScope | undefined, checkouts: readonly Checkout[]): Placement {
  const repo = scope?.repos[0];
  if (!repo) return { kind: "none" };
  const path = scope?.path ?? "";
  const seen = new Set<string>();
  const matches = checkouts.filter((c) => {
    if (seen.has(c.dir) || !originMatches(c.origin, repo)) return false;
    seen.add(c.dir);
    return true;
  });
  if (!matches.length) return { kind: "missing", repo };
  // The component holding the sender's folder first (the deepest such), then
  // the main checkout over a worktree of it.
  const rank = (c: Checkout) => (within(c.rel, path) ? 10_000 : 0) + (c.main ? 5_000 : 0) + c.rel.length;
  const choices = [...matches].sort((a, b) => rank(b) - rank(a));
  return { kind: "matched", repo, choices };
}

/** The lines an incoming job's agent is told about where its work is. */
export function scopeBrief(scope: JobScope | undefined, placement: Placement): string {
  if (!scope) return "";
  const [first, ...others] = scope.repos;
  const lines = [`Repository: ${repoFullName(first)}${scope.branch ? ` (the sender was on branch ${scope.branch})` : ""}.`];
  if (scope.path && placement.kind === "matched") lines.push(`Work in the \`${scope.path}\` folder of that repository.`);
  if (others.length) lines.push(`It also involves: ${others.map(repoFullName).join(", ")} — those are other checkouts, not this one.`);
  return lines.join(" ");
}

/** The lookups projectCheckouts needs, injectable for tests. */
export interface CheckoutLookups {
  share: (path: string) => Promise<{ root: string; rel: string; origin: string }>;
  worktrees: (repo: string) => Promise<{ path: string; is_main: boolean }[]>;
}

/** Every component of these projects with its checkout's origin and whether
 *  it is the main checkout. A component that is not a checkout (or that git
 *  cannot read) is left out: it can never match, so it is never guessed at. */
export async function projectCheckouts(
  projects: readonly { name: string; components: readonly { path: string }[] }[],
  look: CheckoutLookups = { share: ipc.gitShareContext, worktrees: ipc.gitWorktrees },
): Promise<Checkout[]> {
  const mains = new Map<string, Promise<boolean>>();
  const isMain = (root: string) => {
    let known = mains.get(root);
    if (!known) {
      known = look
        .worktrees(root)
        .then((list) => list.find((w) => w.path === root)?.is_main ?? true)
        .catch(() => true);
      mains.set(root, known);
    }
    return known;
  };
  const rows = await Promise.all(
    projects.flatMap((p) =>
      p.components.map(async (c): Promise<Checkout | null> => {
        const ctx = await look.share(c.path).catch(() => null);
        if (!ctx?.origin) return null;
        return { project: p.name, dir: c.path, rel: ctx.rel, origin: ctx.origin, main: await isMain(ctx.root) };
      }),
    ),
  );
  return rows.filter((r): r is Checkout => !!r);
}

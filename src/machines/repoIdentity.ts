// Which repository a folder on a machine belongs to.
//
// Two machines agree on very little: folder layouts differ, project names are
// whatever each person typed, project ids are minted per machine. The one
// thing they share is the repository's origin remote. So "the same work on two
// machines" is decided here, by origin (host + `owner/name`), and by nothing
// else: never a project name, a folder name or an absolute path.
//
// The "All workspaces" tab strip joins another machine's terminals to a
// project through this, and the machine channel (sync, run, copy) finds a
// repository's checkout on the other machine with it.
import { repoRefFromRemote } from "../gitLinks";

export interface RepoId {
  /** The remote's host, lower-cased ("github.com"); an ssh alias when the origin uses one. */
  host: string;
  /** `owner/name`, without `.git`. */
  slug: string;
}

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The repository an origin URL names, or null when it names none (no origin,
 *  a local path, something that is not a clone URL). */
export function repoIdFromOrigin(origin: string | null | undefined): RepoId | null {
  if (typeof origin !== "string" || !origin.trim()) return null;
  const ref = repoRefFromRemote(origin);
  return ref && ref.slug ? { host: ref.host, slug: ref.slug } : null;
}

/** Same repository? The slug case-insensitively; the host too when both are
 *  real hostnames. An ssh alias (`work:acme/api`) is not a hostname, so it
 *  never makes two checkouts of one repository look different. The same rule
 *  mesh jobs use (jobScope.ts `sameRepo`). */
export function sameRepoId(a: RepoId, b: RepoId): boolean {
  if (a.slug.toLowerCase() !== b.slug.toLowerCase()) return false;
  if (!a.host || !b.host) return true;
  return a.host === b.host || !a.host.includes(".") || !b.host.includes(".");
}

export const repoIdLabel = (repo: RepoId): string => (repo.host && repo.host.includes(".") ? `${repo.host}/${repo.slug}` : repo.slug);

/** One of a machine's saved project checkouts (`git_project_checkouts`, desktop only). */
interface SavedCheckout {
  dir: string;
  root?: string;
  rel?: string;
  origin: string;
}

export interface RepoMachine {
  /** "local", "this-mac", "remote:<id>", "primary": only a cache key. */
  env: string;
  invoke: Invoke;
  /** A desktop also lists its saved checkouts, which answers for folders its
   *  path scope would refuse (a worktree beside the repository, a project that
   *  is not open). A workspace host does not serve that list. */
  desktop?: boolean;
}

/** A known answer is kept this long; a folder's repository does not change. */
const KNOWN_TTL_MS = 10 * 60_000;
/** "Not a repository" is asked again sooner: `git init` and `git remote add` happen. */
const UNKNOWN_TTL_MS = 60_000;

const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root.replace(/\/+$/, "")}/`);

/** The checkout a folder belongs to: the folder is the component, is inside
 *  it, is inside its repository, or is one of the repository's `-wt-<name>`
 *  worktrees (Canopy's own naming, teleport/deps.ts). */
export function checkoutFor(dir: string, checkouts: readonly SavedCheckout[]): SavedCheckout | undefined {
  let best: SavedCheckout | undefined;
  let bestLength = -1;
  for (const c of checkouts) {
    const root = (c.root || c.dir).replace(/\/+$/, "");
    const matches = inside(dir, c.dir) || inside(dir, root) || dir.startsWith(`${root}-wt-`);
    // The deepest root wins: a repository nested in another is its own.
    if (matches && root.length > bestLength) {
      best = c;
      bestLength = root.length;
    }
  }
  return best;
}

/** Folder → repository, per machine, remembered. */
export class RepoResolver {
  private readonly known = new Map<string, { at: number; repo: RepoId | null }>();
  private readonly pending = new Map<string, Promise<RepoId | null>>();
  private readonly checkouts = new Map<string, { at: number; list: Promise<SavedCheckout[]> }>();

  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** The repository `dir` on `machine` is a checkout of, or null. Never rejects:
   *  a machine that cannot answer is "unknown", which matches nothing. */
  repoOf(machine: RepoMachine, dir: string): Promise<RepoId | null> {
    if (!dir || !dir.startsWith("/")) return Promise.resolve(null);
    const key = `${machine.env}\n${dir}`;
    const hit = this.known.get(key);
    if (hit && this.now() - hit.at < (hit.repo ? KNOWN_TTL_MS : UNKNOWN_TTL_MS)) return Promise.resolve(hit.repo);
    const running = this.pending.get(key);
    if (running) return running;
    const run = this.resolve(machine, dir)
      .catch(() => null)
      .then((repo) => {
        this.known.set(key, { at: this.now(), repo });
        return repo;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }

  private async resolve(machine: RepoMachine, dir: string): Promise<RepoId | null> {
    const direct = await machine.invoke<string | null>("git_remote_url", { repo: dir }).catch(() => null);
    const fromGit = repoIdFromOrigin(direct);
    if (fromGit) return fromGit;
    if (!machine.desktop) return null;
    const found = checkoutFor(dir, await this.savedCheckouts(machine));
    return found ? repoIdFromOrigin(found.origin) : null;
  }

  private savedCheckouts(machine: RepoMachine): Promise<SavedCheckout[]> {
    const hit = this.checkouts.get(machine.env);
    if (hit && this.now() - hit.at < UNKNOWN_TTL_MS) return hit.list;
    const list = machine
      .invoke<SavedCheckout[]>("git_project_checkouts")
      .then((rows) => (Array.isArray(rows) ? rows.filter((r) => r && typeof r.dir === "string" && typeof r.origin === "string") : []))
      .catch(() => []);
    this.checkouts.set(machine.env, { at: this.now(), list });
    return list;
  }

  /** Forget everything: an account or machine change. */
  clear(): void {
    this.known.clear();
    this.pending.clear();
    this.checkouts.clear();
  }
}

/** One resolver for the window: answers are worth sharing between projects. */
export const repoResolver = new RepoResolver();

/** The distinct repositories of a set of folders on one machine. */
export async function reposOf(machine: RepoMachine, dirs: readonly string[], resolver: RepoResolver = repoResolver): Promise<RepoId[]> {
  const found = await Promise.all([...new Set(dirs)].map((dir) => resolver.repoOf(machine, dir)));
  const out: RepoId[] = [];
  for (const repo of found) if (repo && !out.some((r) => sameRepoId(r, repo))) out.push(repo);
  return out;
}

/** The sessions that run inside a checkout of one of `repos`. A session with
 *  no folder, or in a folder that is no repository, belongs to no project and
 *  is left out; with no `repos` nothing can match. */
export async function sessionsInRepos<S extends { cwd?: string }>(
  sessions: readonly S[],
  repos: readonly RepoId[],
  repoOf: (dir: string) => Promise<RepoId | null>,
): Promise<S[]> {
  if (!repos.length || !sessions.length) return [];
  const dirs = [...new Set(sessions.map((s) => s.cwd).filter((cwd): cwd is string => !!cwd))];
  const answers = new Map<string, RepoId | null>();
  await Promise.all(dirs.map(async (dir) => answers.set(dir, await repoOf(dir).catch(() => null))));
  return sessions.filter((s) => {
    const repo = s.cwd ? answers.get(s.cwd) : null;
    return !!repo && repos.some((r) => sameRepoId(r, repo));
  });
}

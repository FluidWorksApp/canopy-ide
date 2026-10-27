// Which other live agents a finished turn may have affected.
//
// Pure: the engine (engine.ts) gathers the evidence — the finishing agent's
// files, every other live agent's claims, edit journal and touched files, and
// which files reference the symbols the turn changed — and this decides what
// counts as an overlap and how strong it is. Everything is compared as a
// repo-relative path, so an agent in a linked worktree of the same repository
// overlaps one in the main checkout: two worktrees that both edit
// `src/checkout.ts` collide at merge time even though their absolute paths
// never meet.

/** Another live agent on the same repository, as overlap detection sees it. */
export interface PeerAgent {
  sessionId: string;
  ptyId: number;
  /** Agent registry id. */
  cli: string;
  cwd: string;
  /** What the person calls it (its tab name). */
  name: string;
  /** What it says it is doing (canopy_name_task), else its opening prompt. */
  task: string | null;
  /** Repo-relative files it has touched this session (its digest). */
  files: string[];
  /** Repo-relative files from its edit journal, with when (ms). */
  recent: { path: string; ts: number }[];
  /** Repo-relative paths it holds a claim on (files or directories). */
  claims: string[];
}

/** Why a file counts, strongest first. */
export type OverlapWhy = "claimed" | "recent-edit" | "same-file" | "references";

const STRENGTH: Record<OverlapWhy, number> = {
  claimed: 0,
  "recent-edit": 1,
  "same-file": 2,
  references: 3,
};

export const OVERLAP_LABEL: Record<OverlapWhy, string> = {
  claimed: "it has claimed",
  "recent-edit": "it edited recently",
  "same-file": "it has touched",
  references: "uses a changed symbol",
};

export interface FileOverlap {
  path: string;
  why: OverlapWhy;
  /** For `references`: the changed symbol this file uses. */
  symbol?: string;
}

export interface Overlap {
  peer: PeerAgent;
  files: FileOverlap[];
}

/** Same file, or one inside the other's directory (claims may name a dir). */
export function relOverlap(a: string, b: string): boolean {
  const x = a.replace(/\/+$/, "");
  const y = b.replace(/\/+$/, "");
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Turn a path into the repo-relative form, given every checkout of the
 *  repository (main checkout + linked worktrees). A path that is already
 *  relative is taken as repo-relative (that is what the journal records for a
 *  checkout Canopy has open); an absolute path outside every checkout is not
 *  this repository's and yields null. The longest checkout wins, because a
 *  worktree can live inside the main checkout's directory. */
export function toRepoRel(path: string, checkouts: readonly string[]): string | null {
  if (!path) return null;
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
    return path.replace(/^\.\//, "").replace(/\/+$/, "") || null;
  }
  let best: string | null = null;
  for (const raw of checkouts) {
    const top = raw.replace(/\/+$/, "");
    if (!top) continue;
    if ((path === top || path.startsWith(`${top}/`)) && (!best || top.length > best.length)) best = top;
  }
  if (!best) return null;
  return path.slice(best.length + 1).replace(/\/+$/, "") || null;
}

export interface OverlapInput {
  /** The finishing agent's repo-relative files. */
  touched: string[];
  peers: PeerAgent[];
  /** Repo-relative files that reference a symbol the turn changed. */
  references?: { symbol: string; files: string[] }[];
  now: number;
  /** How far back a journal edit still counts as "recent". */
  recentMs: number;
}

/** Every peer with at least one overlapping file, most-overlapping first.
 *  One row per file per peer, keeping the strongest reason. */
export function computeOverlaps(input: OverlapInput): Overlap[] {
  const { touched, peers, references = [], now, recentMs } = input;
  const out: Overlap[] = [];
  for (const peer of peers) {
    const found = new Map<string, FileOverlap>();
    const add = (o: FileOverlap) => {
      const prev = found.get(o.path);
      if (!prev || STRENGTH[o.why] < STRENGTH[prev.why]) found.set(o.path, o);
    };
    const recent = peer.recent.filter((e) => now - e.ts <= recentMs);
    /** How the peer is involved with a file, strongest reason first. */
    const involvement = (path: string): OverlapWhy | null => {
      if (peer.claims.some((c) => relOverlap(c, path))) return "claimed";
      if (recent.some((e) => e.path === path)) return "recent-edit";
      if (peer.files.includes(path)) return "same-file";
      return null;
    };
    for (const path of touched) {
      const why = involvement(path);
      if (why) add({ path, why });
    }
    // Symbol-level: the turn changed `quote`, and the peer is working in a
    // file that calls it — a collision no path comparison sees.
    for (const ref of references) {
      for (const path of ref.files) {
        if (touched.includes(path)) continue;
        if (involvement(path)) add({ path, why: "references", symbol: ref.symbol });
      }
    }
    if (found.size) {
      out.push({
        peer,
        files: [...found.values()].sort(
          (a, b) => STRENGTH[a.why] - STRENGTH[b.why] || a.path.localeCompare(b.path),
        ),
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.files.length - a.files.length ||
      STRENGTH[a.files[0].why] - STRENGTH[b.files[0].why] ||
      a.peer.ptyId - b.peer.ptyId,
  );
}

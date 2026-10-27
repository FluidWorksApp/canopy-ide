// Hotspot files: the few files in a repository that many changes pass through
// — route tables, registries, central config, the app's wiring — where two
// agents writing at once is how parallel work collides.
//
// Kept deliberately simple, and the whole rule is here:
//
//  1. Churn. `git log` over the last 30 days (awareness.rs). A file changed in
//     at least CHURN_MIN commits, and among the CHURN_TOP most-changed, is a
//     hotspot.
//  2. Shape. A file whose name says it is shared wiring (routes, a registry,
//     package.json, a settings module, an app/lib entry point …) is a hotspot
//     once it has changed at all lately — and is treated as one at check time
//     even with no history, because a fresh route table is still a route table.
//  3. Conflict history. Any path a claim was ever refused on (the claim store
//     records each refusal) — agents have collided there before.
//  4. The person's override (Settings → per project, on the team board)
//     replaces all of the above for that repository.
//
// Lockfiles are excluded: they churn constantly and are regenerated, never
// merged by hand.

export interface Hotspot {
  /** Repo-relative file, or a directory prefix (override only). */
  path: string;
  /** Plain-language reasons, for the board's tooltip. */
  reasons: string[];
  /** Sort key: commits + weight for shape and conflicts. */
  score: number;
}

export const CHURN_DAYS = 30;
export const CHURN_MIN = 8;
export const CHURN_TOP = 15;
export const MAX_HOTSPOTS = 40;

const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|composer\.lock|uv\.lock)$/;

/** File shapes that are shared wiring by convention, with how to say so. */
const SHAPES: { re: RegExp; reason: string }[] = [
  { re: /(^|\/)(routes?|router|urls)(\.[\w]+)?$/i, reason: "a route table" },
  { re: /(^|\/)routes\/index\.[\w]+$/i, reason: "a route table" },
  { re: /(^|\/)[\w.-]*(registry|registries)[\w.-]*$/i, reason: "a registry" },
  { re: /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod|Gemfile|requirements\.txt)$/, reason: "the project manifest" },
  { re: /(^|\/)(tsconfig[\w.-]*\.json|[\w-]+\.config\.(js|cjs|mjs|ts)|tauri\.conf\.json|docker-compose\.ya?ml|Dockerfile|Makefile|\.env[\w.-]*)$/, reason: "shared config" },
  { re: /(^|\/)(settings|config)\.(ts|tsx|js|py|rs)$/i, reason: "shared config" },
  { re: /(^|\/)(App\.(tsx|jsx|vue|svelte)|main\.(ts|tsx|rs|go|py)|lib\.rs|mod\.rs|__init__\.py)$/, reason: "the app's wiring" },
  { re: /(^|\/)(schema\.[\w]+|[\w-]*\.schema\.[\w]+)$/i, reason: "a shared schema" },
  { re: /(^|\/)migrations\//i, reason: "a database migration" },
];

/** Why a file's name alone marks it as shared wiring, or null. */
export function shapeReason(path: string): string | null {
  if (LOCKFILE.test(path)) return null;
  return SHAPES.find((s) => s.re.test(path))?.reason ?? null;
}

export interface HotspotEvidence {
  churn: { path: string; commits: number }[];
  /** Repo-relative paths claims were refused on (each refusal once). */
  refusals?: string[];
}

/** The inferred list, strongest first. `override` (when non-null) wins. */
export function inferHotspots(evidence: HotspotEvidence, override?: string[] | null): Hotspot[] {
  if (override) {
    return override
      .map((p) => p.trim().replace(/^\.\//, ""))
      .filter(Boolean)
      .slice(0, MAX_HOTSPOTS * 2)
      .map((path) => ({ path, reasons: ["you marked it as a hotspot"], score: 1000 }));
  }
  const byPath = new Map<string, Hotspot>();
  const put = (path: string, reason: string, score: number) => {
    const hit = byPath.get(path) ?? { path, reasons: [], score: 0 };
    if (!hit.reasons.includes(reason)) hit.reasons.push(reason);
    hit.score += score;
    byPath.set(path, hit);
  };
  const churn = evidence.churn.filter((c) => !LOCKFILE.test(c.path));
  const ranked = [...churn].sort((a, b) => b.commits - a.commits);
  ranked.forEach((c, i) => {
    if (c.commits >= CHURN_MIN && i < CHURN_TOP) {
      put(c.path, `changed in ${c.commits} commits in the last ${CHURN_DAYS} days`, c.commits);
    }
  });
  for (const c of churn) {
    const shape = shapeReason(c.path);
    if (shape && c.commits >= 2) {
      put(c.path, shape, 4);
      const hit = byPath.get(c.path)!;
      if (!hit.reasons.some((r) => r.startsWith("changed in"))) {
        hit.reasons.push(`changed in ${c.commits} commits in the last ${CHURN_DAYS} days`);
        hit.score += c.commits;
      }
    }
  }
  for (const path of new Set(evidence.refusals ?? [])) {
    put(path, "agents have collided on it before", 6);
  }
  return [...byPath.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_HOTSPOTS);
}

/** Whether a repo-relative file is a hotspot: listed (a listed directory
 *  covers what is inside it), or — unless the person overrode the list —
 *  shaped like shared wiring. Returns the reason to quote, or null. */
export function hotspotReason(
  path: string,
  list: readonly Hotspot[],
  overridden: boolean,
): string | null {
  const hit = list.find((h) => {
    const dir = h.path.replace(/\/+$/, "");
    return path === dir || path.startsWith(`${dir}/`);
  });
  if (hit) return hit.reasons[0] ?? "a hotspot";
  if (overridden) return null;
  return shapeReason(path);
}

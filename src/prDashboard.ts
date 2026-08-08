// Deterministic planning for the pull-request dashboard.
//
// The watcher supplies facts and sync.rs supplies pairwise merge evidence. This
// file is deliberately pure: layout and landing order must not change because
// a Map happened to iterate differently or because a component rendered twice.
import type * as ipc from "./ipc";
import { laneOf, prMergeReady } from "./prInbox";

export type DashboardCategory =
  | "build-feature"
  | "build-substrate"
  | "main-feature"
  | "main-substrate"
  | "research"
  | "stack";

export const CATEGORY_ORDER: DashboardCategory[] = [
  "build-feature",
  "build-substrate",
  "main-feature",
  "main-substrate",
  "research",
  "stack",
];

export const CATEGORY_LABEL: Record<DashboardCategory, string> = {
  "build-feature": "Build programme · Features",
  "build-substrate": "Build programme · Substrate",
  "main-feature": "Main · Features",
  "main-substrate": "Main · Substrate",
  research: "Research & documentation",
  stack: "Stacks",
};

const BUILD_BASE = "feat/vibe-build-setup";
const MAIN_BASES = new Set(["main", "master"]);
const RESEARCH_BRANCH = /(^|\/)(research|docs?|spike|explore)(\/|[-_])/i;
const SUBSTRATE_BRANCH =
  /(^|\/)(infra|substrate|shared|runtime|agent|agents|pty|mux|ipc|perf|tooling|refactor|chore)(\/|[-_])/i;

const sameRepo = (a: ipc.PrRow, b: ipc.PrRow) => a.repo === b.repo;

export function categoryOf(row: ipc.PrRow, all: readonly ipc.PrRow[]): DashboardCategory {
  const explicitStack = all.some(
    (parent) => parent.number !== row.number && sameRepo(parent, row) && row.base === parent.branch,
  );
  if (explicitStack || (!MAIN_BASES.has(row.base) && row.base !== BUILD_BASE)) return "stack";
  if (RESEARCH_BRANCH.test(row.branch)) return "research";
  const substrate = SUBSTRATE_BRANCH.test(row.branch);
  if (row.base === BUILD_BASE) return substrate ? "build-substrate" : "build-feature";
  return substrate ? "main-substrate" : "main-feature";
}

export interface DashboardStats {
  count: number;
  ready: number;
  drafts: number;
  additions: number;
  deletions: number;
}

export const statsFor = (rows: readonly ipc.PrRow[]): DashboardStats => ({
  count: rows.length,
  ready: rows.filter(prMergeReady).length,
  drafts: rows.filter((row) => row.draft).length,
  additions: rows.reduce((sum, row) => sum + row.additions, 0),
  deletions: rows.reduce((sum, row) => sum + row.deletions, 0),
});

export interface DashboardGroup {
  id: DashboardCategory;
  label: string;
  rows: ipc.PrRow[];
  stats: DashboardStats;
}

export function dashboardGroups(rows: readonly ipc.PrRow[]): DashboardGroup[] {
  const buckets = new Map<DashboardCategory, ipc.PrRow[]>();
  for (const row of rows) {
    const category = categoryOf(row, rows);
    const bucket = buckets.get(category);
    if (bucket) bucket.push(row);
    else buckets.set(category, [row]);
  }
  return CATEGORY_ORDER.filter((id) => buckets.has(id)).map((id) => {
    const grouped = [...(buckets.get(id) ?? [])].sort(
      (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number,
    );
    return { id, label: CATEGORY_LABEL[id], rows: grouped, stats: statsFor(grouped) };
  });
}

export interface MergeProbeGroup {
  key: string;
  repo: string;
  category: DashboardCategory;
  base: string;
  candidates: ipc.PrMergeCandidate[];
}

const oid = (value?: string): value is string =>
  !!value && (value.length === 40 || value.length === 64) && /^[a-f\d]+$/i.test(value);

/** Bound probing to PRs that share repo, category and target branch. */
export function mergeProbeGroups(rows: readonly ipc.PrRow[]): MergeProbeGroup[] {
  const buckets = new Map<string, MergeProbeGroup>();
  for (const row of rows) {
    if (!oid(row.head_sha) || !oid(row.base_sha)) continue;
    const category = categoryOf(row, rows);
    const identity = `${row.repo}\0${category}\0${row.base}`;
    let group = buckets.get(identity);
    if (!group) {
      group = { key: "", repo: row.repo, category, base: row.base, candidates: [] };
      buckets.set(identity, group);
    }
    group.candidates.push({
      number: row.number,
      branch: row.branch,
      base: row.base,
      base_sha: row.base_sha,
      head_sha: row.head_sha,
    });
  }
  return [...buckets.values()]
    .map((group) => {
      group.candidates.sort((a, b) => a.number - b.number);
      group.key = `${group.repo}\0${group.category}\0${group.base}\0${group.candidates
        .map((candidate) => `${candidate.number}:${candidate.base_sha}:${candidate.head_sha}`)
        .join("|")}`;
      return group;
    })
    .filter((group) => group.candidates.length > 1)
    .sort((a, b) => a.key.localeCompare(b.key));
}

export type ProbeIndex = ReadonlyMap<string, ipc.PrMergePairProbe>;

export const pairKey = (repo: string, a: number, b: number): string =>
  `${repo}\0${Math.min(a, b)}\0${Math.max(a, b)}`;

export function indexProbes(
  groups: readonly { repo: string; probe: ipc.PrMergePlanProbe }[],
): Map<string, ipc.PrMergePairProbe> {
  const index = new Map<string, ipc.PrMergePairProbe>();
  for (const { repo, probe } of groups) {
    for (const pair of probe.pairs) index.set(pairKey(repo, pair.first, pair.second), pair);
  }
  return index;
}

function pairFor(index: ProbeIndex, a: ipc.PrRow, b: ipc.PrRow): ipc.PrMergePairProbe | undefined {
  return sameRepo(a, b) ? index.get(pairKey(a.repo, a.number, b.number)) : undefined;
}

function firstIsAncestor(pair: ipc.PrMergePairProbe, first: number): boolean {
  return pair.first === first ? pair.first_ancestor_second : pair.second_ancestor_first;
}

function dependencies(row: ipc.PrRow, rows: readonly ipc.PrRow[], probes: ProbeIndex): number[] {
  const deps = new Set<number>();
  for (const other of rows) {
    if (other === row || !sameRepo(row, other)) continue;
    if (row.base === other.branch) deps.add(other.number);
    const pair = pairFor(probes, other, row);
    if (pair && firstIsAncestor(pair, other.number)) deps.add(other.number);
  }
  return [...deps].sort((a, b) => a - b);
}

const stateRank = (row: ipc.PrRow): number => {
  if (prMergeReady(row)) return 0;
  switch (laneOf(row)) {
    case "needs-you": return 1;
    case "waiting": return 2;
    case "blocked": return 3;
    case "draft": return 4;
    default: return 5;
  }
};

export interface MergePlanStep {
  row: ipc.PrRow;
  position: number;
  dependencies: number[];
  conflictsWith: number[];
  evidence: "verified" | "partial" | "unavailable";
  stackAfter?: ipc.PrRow;
}

/** A deterministic topological/compatibility order.
 *
 * Dependencies (already-stacked bases and exact git ancestry) always win.
 * Among eligible heads, landable PRs come first, then the head that remains
 * compatible with the most siblings, then PR number. A conflict cannot be
 * wished away by reversing it, so it is named on the first affected step.
 */
export function recommendMergeOrder(
  rows: readonly ipc.PrRow[],
  probes: ProbeIndex,
): MergePlanStep[] {
  const remaining = new Map(
    [...rows]
      .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)
      .map((row) => [`${row.repo}\0${row.number}`, row]),
  );
  const ordered: ipc.PrRow[] = [];
  const dependencyMap = new Map(
    [...remaining.values()].map((row) => [`${row.repo}\0${row.number}`, dependencies(row, rows, probes)]),
  );

  while (remaining.size) {
    const done = new Set(ordered.map((row) => `${row.repo}\0${row.number}`));
    let eligible = [...remaining.values()].filter((row) =>
      (dependencyMap.get(`${row.repo}\0${row.number}`) ?? []).every((number) =>
        done.has(`${row.repo}\0${number}`),
      ),
    );
    // Malformed/cyclic stack metadata must not make the dashboard disappear.
    if (!eligible.length) eligible = [...remaining.values()];
    eligible.sort((a, b) => {
      const aConflict = ordered.some((prior) => pairFor(probes, prior, a)?.clean === false);
      const bConflict = ordered.some((prior) => pairFor(probes, prior, b)?.clean === false);
      if (aConflict !== bConflict) return aConflict ? 1 : -1;
      const state = stateRank(a) - stateRank(b);
      if (state) return state;
      const compatible = (candidate: ipc.PrRow) =>
        [...remaining.values()].filter(
          (other) => other !== candidate && pairFor(probes, candidate, other)?.clean === true,
        ).length;
      const compatibility = compatible(b) - compatible(a);
      return compatibility || a.repo.localeCompare(b.repo) || a.number - b.number;
    });
    const next = eligible[0];
    ordered.push(next);
    remaining.delete(`${next.repo}\0${next.number}`);
  }

  return ordered.map((row, position) => {
    const rowCategory = categoryOf(row, rows);
    const comparable = rows.filter(
      (other) =>
        other !== row &&
        sameRepo(row, other) &&
        other.base === row.base &&
        categoryOf(other, rows) === rowCategory,
    );
    const known = comparable.filter((other) => !!pairFor(probes, row, other));
    const deps = dependencyMap.get(`${row.repo}\0${row.number}`) ?? [];
    const stackNumber = deps.find((number) =>
      rows.some((candidate) => candidate.repo === row.repo && candidate.number === number),
    );
    return {
      row,
      position: position + 1,
      dependencies: deps,
      conflictsWith: ordered
        .slice(0, position)
        .filter((prior) => pairFor(probes, prior, row)?.clean === false)
        .map((prior) => prior.number)
        .sort((a, b) => a - b),
      evidence: !comparable.length ? "unavailable" : known.length === comparable.length ? "verified" : "partial",
      stackAfter: stackNumber === undefined
        ? undefined
        : rows.find((candidate) => candidate.repo === row.repo && candidate.number === stackNumber),
    };
  });
}

export function openAge(created: string, now = Date.now()): string {
  const then = Date.parse(created);
  if (!Number.isFinite(then)) return "age unknown";
  const hours = Math.max(0, Math.floor((now - then) / 3_600_000));
  if (hours < 1) return "<1h open";
  if (hours < 24) return `${hours}h open`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d open`;
  return `${Math.floor(days / 7)}w open`;
}

export const sessionLabel = (edges: readonly ipc.ProvenanceEdge[] | undefined): string => {
  if (!edges?.length) return "session unknown";
  const edge = [...edges].sort((a, b) => b.at - a.at || a.session_id.localeCompare(b.session_id))[0];
  return edge.agent ? `${edge.agent} · ${edge.session_id.slice(0, 8)}` : edge.session_id.slice(0, 8);
};

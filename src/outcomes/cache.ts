// What the Outcomes panel reads from git, kept between reads, so reopening it
// is instant and a recount only reads what is new.
//
//  * The log is incremental by the last commit seen: a short read of the
//    newest commits, joined onto the cached history at that commit. Only a
//    rewritten history (the old head is no longer in reach) reads it all.
//  * Commit dates and content fingerprints never change for a commit id, so
//    they are kept by id — dates on disk, fingerprints in memory.
//  * A PR GitHub says merged or closed stays that way; open ones are asked
//    again, and their content fingerprint is kept so a later rebase or squash
//    merge can be recognised even without the GitHub CLI.
//  * The last report per repository and period is kept, so the panel paints
//    it at once and recounts in the background.
//
// Stored in localStorage (small, per machine, bounded); everything here is a
// cache of git and the ledger, so losing it costs one slow recount.

import { fingerprint, fingerprintKey, type Fingerprint } from "./patchId";
import type { OutcomesReport, ReconcileDeps } from "./reconcile";

type LogRow = { hash: string; subject: string; date: string };

interface RepoCache {
  log: LogRow[];
  dates: Record<string, string>;
  /** PR number → final state, with when it was first seen that way. */
  prs: Record<string, { state: string; at: number }>;
  /** PR number → its content fingerprint key, captured while it was open. */
  prPrints: Record<string, string>;
}

const KEY = "canopy.outcomes.gitCache";
const MAX_REPOS = 12;
const MAX_DATES = 2000;
const MAX_PR_PRINTS = 40;
const MAX_PRINT_BYTES = 24 * 1024;
const MAX_FINGERPRINTS = 3000;
/** Commits read to find where the cached history joins the new head. */
export const INCREMENTAL_READ = 40;

export interface CacheStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browserStore: CacheStore = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Quota or blocked storage: the memory copy still serves this session.
    }
  },
};

const empty = (): RepoCache => ({ log: [], dates: {}, prs: {}, prPrints: {} });

/** Fingerprints by commit id, for this window (patches are too big to keep). */
const prints = new Map<string, Fingerprint>();
const remember = <K, V>(map: Map<K, V>, k: K, v: V, max: number) => {
  map.delete(k);
  map.set(k, v);
  while (map.size > max) map.delete(map.keys().next().value as K);
};

function parsePrint(key: string): Fingerprint {
  const out: Fingerprint = new Map();
  for (const line of key.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out.set(line.slice(i + 1), Number(line.slice(0, i)));
  }
  return out;
}

/** Wrap `base` so its git and GitHub reads are cached per repository. */
export function cachedReconcileDeps(base: ReconcileDeps, store: CacheStore = browserStore): ReconcileDeps {
  let all: Record<string, RepoCache> | null = null;
  const load = (): Record<string, RepoCache> => {
    if (all) return all;
    try {
      const parsed = JSON.parse(store.get(KEY) ?? "{}") as unknown;
      all = parsed && typeof parsed === "object" ? (parsed as Record<string, RepoCache>) : {};
    } catch {
      all = {};
    }
    return all;
  };
  const repo = (r: string): RepoCache => {
    const a = load();
    const hit = a[r];
    if (hit && Array.isArray(hit.log)) return { ...empty(), ...hit };
    return empty();
  };
  const save = (r: string, next: RepoCache) => {
    const a = load();
    delete a[r];
    a[r] = next;
    const keys = Object.keys(a);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REPOS))) delete a[k];
    store.set(KEY, JSON.stringify(a));
  };

  return {
    ...base,
    async gitLog(r, limit) {
      const cached = repo(r);
      const fresh = await base.gitLog(r, Math.min(limit, INCREMENTAL_READ));
      let log: LogRow[];
      const join = cached.log.length ? fresh.findIndex((c) => c.hash === cached.log[0].hash) : -1;
      if (join >= 0) {
        log = [...fresh.slice(0, join), ...cached.log].slice(0, limit);
      } else if (fresh.length < Math.min(limit, INCREMENTAL_READ)) {
        log = fresh; // the whole history fits in the short read
      } else {
        log = await base.gitLog(r, limit);
      }
      save(r, { ...cached, log: log.map((c) => ({ hash: c.hash, subject: c.subject, date: c.date })) });
      return log;
    },
    async commitDate(r, hash) {
      const cached = repo(r);
      if (cached.dates[hash]) return cached.dates[hash];
      const date = await base.commitDate(r, hash);
      if (date) {
        const dates = { ...cached.dates, [hash]: date };
        const keys = Object.keys(dates);
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DATES))) delete dates[k];
        save(r, { ...repo(r), dates });
      }
      return date;
    },
    async commitFingerprint(r, hash) {
      const hit = prints.get(hash);
      if (hit) return hit;
      const fp = base.commitFingerprint
        ? await base.commitFingerprint(r, hash)
        : fingerprint(await base.commitPatch(r, hash));
      remember(prints, hash, fp, MAX_FINGERPRINTS);
      return fp;
    },
    prState: base.prState
      ? async (r, n) => {
          const known = repo(r).prs[String(n)];
          if (known) return known.state;
          const state = await base.prState!(r, n);
          if (state === "MERGED" || state === "CLOSED") {
            const cur = repo(r);
            save(r, { ...cur, prs: { ...cur.prs, [String(n)]: { state, at: Date.now() } } });
          }
          return state;
        }
      : undefined,
    async prFingerprint(r, n) {
      const fp = base.prFingerprint ? await base.prFingerprint(r, n).catch(() => null) : null;
      const cur = repo(r);
      if (fp?.size) {
        const key = fingerprintKey(fp);
        if (key.length <= MAX_PRINT_BYTES && cur.prPrints[String(n)] !== key) {
          const prPrints = { ...cur.prPrints, [String(n)]: key };
          const keys = Object.keys(prPrints);
          for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PR_PRINTS))) delete prPrints[k];
          save(r, { ...cur, prPrints });
        }
        return fp;
      }
      // GitHub can't say now (offline, gh missing): what we saw while it was open.
      const saved = cur.prPrints[String(n)];
      return saved ? parsePrint(saved) : null;
    },
  };
}

// ------------------------------------------------------------ last report

const reports = new Map<string, OutcomesReport>();
const reportKey = (repo: string, days: number) => `${repo}\u0000${days}`;

/** The last report counted for this repository and period, if any. */
export function lastReport(repo: string, days: number): OutcomesReport | null {
  return reports.get(reportKey(repo, days)) ?? null;
}

export function keepReport(repo: string, days: number, report: OutcomesReport): void {
  remember(reports, reportKey(repo, days), report, 24);
}

/** Tests only. */
export function resetOutcomesCacheForTests(): void {
  prints.clear();
  reports.clear();
}

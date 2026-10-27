// What the brain gets to see before it plans: the repo's top level, the files
// that mention the request's words, and what the team's memory says about the
// repo. The brain call is read-only and could look for itself, but every file
// it opens is time the person spends watching "Planning…" — a quick, bounded
// look here is cheaper than letting it wander.
//
// Every source is optional. A failed read is an empty list, never an error:
// a plan from less context beats no plan.

import * as ipc from "../ipc";
import { queryLedger } from "../ledger";
import type { PlanContext } from "./plan";

const STOP = new Set(
  "about after again also because before being could does doing done each from have into just like make more most much need only other over please same should some such than that their them then there these they this those through very want what when where which while will with would your yours the and for are but not you all can her was one our out".split(
    " ",
  ),
);

/** The few words of a request most likely to name code: long, not filler,
 *  identifiers and quoted things first. */
export function requestKeywords(request: string, max = 4): string[] {
  const quoted = [...request.matchAll(/[`"']([A-Za-z0-9_./-]{3,60})[`"']/g)].map((m) => m[1]);
  const words = request
    .split(/[^A-Za-z0-9_]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
  // camelCase / snake_case look like identifiers; rank them ahead of prose.
  const ident = (w: string) => /[a-z][A-Z]|_/.test(w);
  const ranked = [...words].sort((a, b) => Number(ident(b)) - Number(ident(a)) || b.length - a.length);
  const out: string[] = [];
  for (const w of [...quoted, ...ranked]) {
    if (!out.some((o) => o.toLowerCase() === w.toLowerCase())) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

const rel = (dir: string, path: string) => {
  const base = dir.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
};

/** One line for a memory entry, whatever shape the memory feature gave it. */
function memoryLine(e: { subject?: string; data: unknown }): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const text = [d.text, d.summary, d.body, d.note, d.fact, e.subject].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  const line = text ?? JSON.stringify(e.data ?? "");
  return line.replace(/\s+/g, " ").slice(0, 240);
}

export async function gatherPlanContext(dir: string, request: string): Promise<PlanContext> {
  const tree = ipc
    .fsReadDir(dir)
    .then((entries) =>
      entries
        .filter((e) => !e.name.startsWith(".") || e.name === ".github")
        .map((e) => (e.is_dir ? `${e.name}/` : e.name))
        .slice(0, 80),
    )
    .catch(() => [] as string[]);
  const relevant = Promise.all(
    requestKeywords(request).map((k) => ipc.fsSearch([dir], k, 25).catch(() => [] as ipc.SearchHit[])),
  ).then((hits) => {
    // Files hit by more keywords first: they are more likely the ones meant.
    const score = new Map<string, number>();
    for (const list of hits) for (const p of new Set(list.map((h) => h.path))) score.set(p, (score.get(p) ?? 0) + 1);
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => rel(dir, p))
      .slice(0, 40);
  });
  const memory = queryLedger(dir, { kinds: ["memory"], limit: 10 })
    .then((rows) => rows.map(memoryLine).filter(Boolean))
    .catch(() => [] as string[]);
  return { tree: await tree, relevant: await relevant, memory: await memory };
}

// If this goes red, a new surface has started deciding for itself what an agent
// is doing. Do not "fix" it by weakening the assertion or by adding an
// exemption — the point of the test is that there is exactly one place the
// answer comes from. Every name below has a way through `shared/agentLife`:
//
//   digest.state === "working" | "waiting" | "idle" | "ended"
//                                   -> agentLife(evidence).state
//   d.state ?? "idle" / d.state || 'idle'
//                                   -> the ladder's `unknown`, which is not idle
//   stats.total_cpu > N             -> the `cpu` rung, at POLICY.quietCpuPercent
//   effectiveState(...)             -> agentLife(...), and `confidence` for
//                                      anything destructive
//
// The five derivations this replaces all looked local and reasonable where they
// were written: a dot here, a chip there, a heuristic in a stats subscription.
// Together they meant one session could be "working" on its tab, "needs you" in
// its group, "idle" in the panel and "active" to every other agent in the
// project — and no single screen showed the contradiction.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["src", "shared", "portal/src"];

/** The module itself, its tests, and the Rust mirror are where this logic is
 *  allowed to live. There is deliberately no per-file allowlist beyond that: a
 *  surface that needs a state calls the module. */
const isExempt = (rel: string): boolean =>
  rel.startsWith("shared/agentLife/") ||
  rel.endsWith(".test.ts") ||
  rel.endsWith(".test.tsx") ||
  // The one impure edge, which exists to feed the module its arguments.
  rel === "src/agentLifeStore.ts" ||
  // The re-export.
  rel === "src/agentState.ts";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .map((f) => relative(ROOT, f))
  .filter((f) => !isExempt(f));

/** Report every offending line, not just the first — a rename that reintroduces
 *  three of these should say so in one run. */
function offenders(re: RegExp): string[] {
  const hits: string[] = [];
  for (const rel of files) {
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      // Comments describing the old behaviour are the point of the comments.
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (re.test(line)) hits.push(`${rel}:${i + 1}  ${code}`);
    });
  }
  return hits;
}

/** The same sweep, but across line breaks. A formatter splitting
 *  `digest?.state ?? "idle"` over two lines put `.state` on one and the
 *  coercion on the next, and the line-by-line scan above matched neither —
 *  the exact escape this test exists to close. Comments are blanked rather
 *  than stripped, so match indexes still map to real line numbers. */
function offendersAcrossLines(re: RegExp): string[] {
  const hits: string[] = [];
  for (const rel of files) {
    const raw = readFileSync(join(ROOT, rel), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^[ \t]*\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, " "));
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of code.matchAll(g)) {
      const line = code.slice(0, m.index).split("\n").length;
      hits.push(`${rel}:${line}  ${m[0].replace(/\s+/g, " ").trim()}`);
    }
  }
  return hits;
}

describe("nothing outside shared/agentLife decides a lifecycle", () => {
  it("does not compare a raw digest's state against a lifecycle string", () => {
    // Aimed at the receivers that carry a *recorded* state — a digest straight
    // off disk, a workspace row joined from one. Comparing a value the module
    // already returned (`life.state`, an `AgentRef.state`) is not a second
    // derivation, it is a read of the first one.
    const re =
      /\b(digest|d|ws|dg)\??\.state\s*===\s*["'](working|waiting|idle|ended|stale)["']/;
    expect(offendersAcrossLines(re)).toEqual([]);
  });

  it("does not coerce a missing state into idle", () => {
    // The exact failure mode that shipped three times: `d.state || 'idle'` in
    // the portal, `?? "idle"` in the tasks list, and then
    // `(sid ? …?.state : undefined) ?? "idle"` in the tasks list again —
    // split across lines AND with a ternary arm between the read and the
    // coercion, so neither a line-by-line scan nor an adjacency match could
    // see it. Hence the bounded bridge: up to a short expression tail may sit
    // between `.state` and the coercion, enough for `: undefined)` and its
    // kin, not enough to reach across two unrelated statements.
    const re = /\.state[\s\S]{0,60}?(\?\?|\|\|)\s*["'](idle|working)["']/;
    expect(offendersAcrossLines(re)).toEqual([]);
  });

  it("does not compare CPU against a threshold of its own", () => {
    // `resourceLoad` answers a different question — "is this runaway" — and
    // keeps its own numbers. Everything else asks "is anything running", which
    // is a rung.
    const re = /total_cpu\s*[<>]=?\s*\d/;
    const hits = offenders(re).filter(
      (h) => !h.startsWith("src/resourceLoad.ts") && !h.includes("runawayCpuPercent"),
    );
    expect(hits).toEqual([]);
  });

  it("has no trace of the decay function left", () => {
    // The symbol is gone; this outlives it as a tripwire, because the shape it
    // had (`if (state !== "working") return state`) is an easy thing to write
    // again and a hard thing to notice is wrong.
    expect(offenders(/\beffectiveState\b/)).toEqual([]);
  });

  it("keeps the free-text classifier in one place", () => {
    // Two non-equivalent regexes over the same message bytes, in two languages,
    // is how "waiting for approval" came to be `idle` on one side and a pending
    // card on the other.
    const hits = offenders(/waiting for \(your \)\?input/i).filter(
      (h) => !h.startsWith("shared/notifications.ts"),
    );
    expect(hits).toEqual([]);
  });
});

describe("nothing destructive acts on a state we are not sure of", () => {
  it("guards every pty kill with reclaimable or an explicit gesture", () => {
    // ptyKill is how hibernation reclaims a session. The version this replaces
    // filtered on the raw recorded `idle`, which for aider meant "sitting at a
    // y/n confirm" — so the cap could SIGTERM an agent mid-question.
    const auto = readFileSync(
      join(ROOT, "src/components/AgentsPanel.tsx"),
      "utf8",
    );
    expect(auto).toContain("reclaimable(");
    expect(
      /\.filter\(\s*\(x\)\s*=>\s*x\.digest\?\.state\s*===/.test(auto),
      "auto-hibernation must not filter on the raw recorded state",
    ).toBe(false);
  });
});

describe("the buckets have one definition", () => {
  it("nobody re-implements bucketFor", () => {
    // The signature of a second implementation is a function that can return
    // BOTH "attention" and "active" — the strings alone are ordinary words that
    // other domains (the LSP's busy/quiet state, for one) use for their own
    // reasons.
    const bad = files.filter((rel) => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      return (
        /return\s+["']attention["']/.test(src) && /return\s+["']active["']/.test(src)
      );
    });
    expect(bad).toEqual([]);
  });
});

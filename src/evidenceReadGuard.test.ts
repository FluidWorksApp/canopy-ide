/// <reference types="node" />
// Guards against a failure a green unit suite structurally cannot see: a write
// path with no read path. `taskEvents` and `listTranscript` are the read APIs
// over the durable verification evidence — the events and transcript every
// attempt appends. Both appear exactly once in `src`, at their own definition.
// Nothing calls them. The evidence is written and never read, so no surface can
// show a person what was actually verified, and a fully green suite reports
// nothing wrong: a producer's tests pass precisely by exercising the producer.
//
// The scan is structural, not a substring match. `vibeMvpGuard.test.ts` next
// door greps raw file text and will happily accept a symbol's name inside a
// comment or an unrelated module. This one walks import *declarations*,
// resolves each specifier to a file on disk, confirms the symbol is bound from
// that exact module (not merely spelled somewhere in the tree), drops type-only
// imports because they read nothing at runtime, and only then looks for a use
// of the local name outside the import statement itself.
//
// Why not a real TypeScript AST: this repo is on typescript 7, the native port,
// whose package no longer exports `createSourceFile` — the only parse entry
// points left are the project-based `typescript/unstable/*` APIs, which spin up
// the native compiler and are explicitly unstable. Anchoring a guard on those
// buys precision at the cost of the guard breaking on a patch release. The
// import-declaration scan below verifies module resolution and binding, which
// is the part that matters here; its one known blind spot is a bare identifier
// used as an object key (`{ taskEvents: something }`), which would read as a
// use. That errs toward a false pass, never a false failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

// An import clause never contains a semicolon, which keeps the lazy match from
// running past its own statement and into the next one.
const IMPORT = /\bimport\s+([^;]*?)\s+from\s*["']([^"']+)["']/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    // Test files are excluded deliberately: a consumer that only exists inside
    // a test is not a consumer, it is the same tautology this guard exists for.
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** Resolve a relative import the way the bundler does, to an absolute file. */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not that one; keep looking.
    }
  }
  return null;
}

/** Local names `symbol` is bound to in `text` by importing `definition`, plus
 *  any namespace binding (`import * as x`) that could reach it. */
function bindings(
  file: string,
  text: string,
  definition: string,
  symbol: string,
): { locals: string[]; namespaces: string[] } {
  const locals: string[] = [];
  const namespaces: string[] = [];
  for (const [, clause, specifier] of text.matchAll(IMPORT)) {
    if (resolveImport(file, specifier) !== definition) continue;
    // `import type { ... }` erases entirely; it is not a runtime read.
    if (/^type\b/.test(clause.trim())) continue;
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) namespaces.push(namespace[1]);
    const named = clause.match(/\{([^}]*)\}/);
    if (!named) continue;
    for (const entry of named[1].split(",")) {
      const parts = entry.trim().split(/\s+/);
      if (parts[0] === "type") continue;
      const [imported, , alias] = parts;
      if (imported === symbol) locals.push(alias ?? imported);
    }
  }
  return { locals, namespaces };
}

/** Every non-test module in `src` that imports `symbol` from `definition` and
 *  actually refers to it. Repo-relative paths, so failures read sensibly. */
function consumersOf(definition: string, symbol: string): string[] {
  return sourceFiles(SRC)
    .filter((file) => {
      if (file === definition) return false;
      const text = readFileSync(file, "utf8");
      // Cheap reject: a file that never spells the name cannot use it.
      if (!text.includes(symbol)) return false;
      const { locals, namespaces } = bindings(file, text, definition, symbol);
      if (locals.length === 0 && namespaces.length === 0) return false;
      // The import statement binds the name; it does not use it, so look at
      // the file with its imports removed.
      const body = text.replace(IMPORT, "");
      return (
        locals.some((local) => new RegExp(`\\b${local}\\b`).test(body)) ||
        namespaces.some((namespace) =>
          new RegExp(`\\b${namespace}\\s*\\.\\s*${symbol}\\b`).test(body),
        )
      );
    })
    .map((file) => relative(ROOT, file));
}

describe("the consumer scan itself", () => {
  // Without these controls a broken scanner would report "no consumers" for
  // everything, and the guards below would look like a real finding when they
  // are enabled — or pass one day for a reason nobody checked.
  it("sees a real consumer of a real read API", () => {
    expect(consumersOf(join(SRC, "taskTranscript.ts"), "appendTranscript")).toContain(
      "src/vibeBuilderSession.ts",
    );
  });

  it("resolves imports from nested directories", () => {
    expect(consumersOf(join(SRC, "taskEnvelopes.ts"), "taskGet")).toContain(
      "src/components/PrView.tsx",
    );
  });

  it("does not credit a name bound from a different module", () => {
    // `appendTranscript` is imported all over the tree, but never from
    // taskEnvelopes — a substring scan would call this a consumer.
    expect(consumersOf(join(SRC, "taskEnvelopes.ts"), "appendTranscript")).toEqual([]);
  });

  it("does not credit a name nobody exports", () => {
    expect(consumersOf(join(SRC, "taskEnvelopes.ts"), "taskEventsNobodyWrote")).toEqual(
      [],
    );
  });
});

// The function that JUSTIFIES a module, and what its absence costs. Sharing
// the scanner above rather than living in its own file, because the mechanism
// is identical — only the question differs. "Does this module have a caller?"
// is the wrong question: `vibeSecretScan` had one (`redactSecrets`, added by
// the artifact-redaction fix) while the function the module exists for,
// `scanDiffForSecrets`, was wired to nothing and the checkpoint gate still read
// a hardcoded literal. A later fix can hide an earlier hole by satisfying the
// shallow check, so the guard has to name the specific function.
const JUSTIFYING_FUNCTIONS = [
  {
    module: "vibeSecretScan.ts",
    symbol: "scanDiffForSecrets",
    enabled: true,
    cost: "the checkpoint gate reads a hardcoded secretScanClean instead of a real scan, so auto-checkpoint is dead code that looks alive",
  },
  {
    module: "vibeSecretScan.ts",
    symbol: "describeSecretFindings",
    enabled: true,
    cost: "the sentence explaining that a secret is why a turn was not saved is never said, so the refusal has no reason attached",
  },
  // The `reconcileCheckpoint` entry that stood here is gone with the function.
  // It was the one case this table could not decide, because the missing piece
  // was not a caller but the whole two-phase protocol; the design call was to
  // remove it rather than half-build it. See the note in vibeCheckpoints.ts.
  {
    module: "vibePackages.ts",
    symbol: "planInstall",
    enabled: true,
    cost: "managed package installs are unreachable — nothing can ask for one",
  },
  {
    module: "vibeServices.ts",
    symbol: "planLink",
    enabled: true,
    cost: "managed service linking is unreachable — nothing can ask for one",
  },
  {
    module: "vibePackages.ts",
    symbol: "detectRunner",
    enabled: true,
    cost: "the runner behind a service link is never detected, because nothing calls the detector",
  },
  {
    module: "vibeDeploy.ts",
    symbol: "planDeploy",
    enabled: true,
    cost: "managed deploys are unreachable — nothing can ask for one",
  },
  {
    module: "vibeDeploy.ts",
    symbol: "detectDeployProvider",
    enabled: true,
    cost: "the deploy provider is never detected, because nothing calls the detector",
  },
] as const;

describe("a module's justifying function has a caller", () => {
  // The five disabled cases are dormant cores: built, tested, and reachable by
  // nobody — not by an agent (the tool policy denies everything but Edit,
  // Write, Read, Grep and Glob) and not by a user. They are recorded here
  // rather than in a transcript so that wiring them turns a guard green
  // instead of relying on someone remembering.
  //
  // To enable one: flip `enabled` in the same commit that wires it. Never
  // weaken the assertion — a red guard here means the feature does not exist
  // yet, whatever its tests say.
  for (const fn of JUSTIFYING_FUNCTIONS) {
    const run = fn.enabled ? it : it.skip;
    run(`${fn.symbol} has at least one consumer`, () => {
      const consumers = consumersOf(join(SRC, fn.module), fn.symbol);
      expect(
        consumers.length,
        `${fn.symbol} has no consumer: ${fn.cost}. It is exported by src/${fn.module} and imported by nothing outside its own file and the tests. Wire it, or delete it — do not relax this guard.`,
      ).toBeGreaterThan(0);
    });
  }
});

// Each durable read API, and what its absence costs the user.
const READ_APIS = [
  {
    module: "taskEnvelopes.ts",
    symbol: "taskEvents",
    cost: "verification evidence is written and never read, so no surface can show what was actually checked",
  },
  {
    module: "taskTranscript.ts",
    symbol: "listTranscript",
    cost: "the durable transcript is written and never read, so a turn's history dies with its session",
  },
] as const;

describe("durable verification evidence has a reader", () => {
  // Enabled. Both symbols are now bound and used by `src/taskEvidence.ts`, the
  // projection behind the evidence panel in TaskHistoryView — not by a test, a
  // re-export, or a mention in a comment, which is why the scan above walks
  // import declarations rather than grepping for the name.
  //
  // The assertion is untouched from when it was skipped. If it ever goes red
  // again, the fix is a reader, not a smaller expectation.
  for (const api of READ_APIS) {
    it(`${api.symbol} has at least one consumer`, () => {
      const consumers = consumersOf(join(SRC, api.module), api.symbol);
      expect(
        consumers.length,
        `${api.symbol} has no consumer: ${api.cost}. It is exported by src/${api.module} and imported by nothing outside its own file and the tests. Add the read surface, or delete the API — do not relax this guard.`,
      ).toBeGreaterThan(0);
    });
  }
});

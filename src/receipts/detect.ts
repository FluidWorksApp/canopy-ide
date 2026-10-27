// Which commands prove a change in this project — detected from its manifests,
// or the person's own list.
//
// Deliberately not vibeCheckInference: that picks *one* check for Build mode
// and leaves lint out on purpose. A receipt wants every independent signal the
// project already declares — its tests above all, then typecheck and lint —
// across every ecosystem in the checkout (a Tauri app is npm *and* Cargo).
//
// `detectChecks` is pure (facts in, commands out) so it can be tested without a
// filesystem; `loadProjectFacts` gathers the facts through the host, which in a
// Linux workspace reads the VM's files.

import * as ipc from "../ipc";
import type { CheckRunner, CheckSpec } from "./types";

export interface ProjectFacts {
  /** Names in the directory (files and folders). */
  entries: string[];
  packageJson?: string;
  cargoToml?: string;
  makefile?: string;
  pyproject?: string;
  setupCfg?: string;
  toxIni?: string;
}

type Pm = "npm" | "pnpm" | "yarn" | "bun";

/** npm init's placeholder, which always fails and would blame every change. */
const PLACEHOLDER = /no test specified/i;
/** A script that never exits produces no evidence; CI=1 already stops vitest
 *  watching, but an explicit --watch would still hang until the timeout. */
const WATCH = /--watch\b|--watchAll\b|\bnodemon\b/;

const TEST_SCRIPTS = ["test", "test:unit", "tests"];
const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "tsc", "types"];
const LINT_SCRIPTS = ["lint"];

function packageManager(pkg: { packageManager?: unknown }, entries: Set<string>): Pm {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(declared)) return declared as Pm;
  if (entries.has("pnpm-lock.yaml")) return "pnpm";
  if (entries.has("yarn.lock")) return "yarn";
  if (entries.has("bun.lockb") || entries.has("bun.lock")) return "bun";
  return "npm";
}

function runnerOf(script: string, deps: Record<string, unknown>): CheckRunner {
  if (/\bvitest\b/.test(script)) return "vitest";
  if (/\bjest\b/.test(script)) return "jest";
  if (/\bmocha\b/.test(script)) return "mocha";
  if (/\bcargo test\b/.test(script)) return "cargo";
  if (/\bpytest\b/.test(script)) return "pytest";
  if ("vitest" in deps) return "vitest";
  if ("jest" in deps) return "jest";
  return "unknown";
}

function fromPackageJson(raw: string, entries: Set<string>): CheckSpec[] {
  let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const pm = packageManager(pkg, entries);
  const usable = (name: string) => {
    const s = scripts[name];
    return typeof s === "string" && s.trim() && !PLACEHOLDER.test(s) && !WATCH.test(s) ? s : null;
  };
  const out: CheckSpec[] = [];
  const add = (names: string[], kind: CheckSpec["kind"], label: string) => {
    const name = names.find(usable);
    if (!name) return;
    out.push({
      id: `npm:${name}`,
      label,
      kind,
      argv: [pm, "run", name],
      source: "package.json",
      ...(kind === "test" ? { runner: runnerOf(usable(name)!, deps) } : {}),
    });
  };
  add(TEST_SCRIPTS, "test", "Tests");
  add(TYPECHECK_SCRIPTS, "typecheck", "Typecheck");
  add(LINT_SCRIPTS, "lint", "Lint");
  return out;
}

function pytestConfigured(f: ProjectFacts, entries: Set<string>): boolean {
  if (entries.has("pytest.ini") || entries.has("conftest.py")) return true;
  if (f.pyproject && /\[tool\.pytest/.test(f.pyproject)) return true;
  if (f.setupCfg && /\[tool:pytest\]/.test(f.setupCfg)) return true;
  if (f.toxIni && /\[pytest\]/.test(f.toxIni)) return true;
  // A python project with a tests/ folder is almost always pytest-runnable.
  return entries.has("tests") && (!!f.pyproject || entries.has("setup.py") || entries.has("requirements.txt"));
}

function makeTarget(makefile: string, target: string): boolean {
  return new RegExp(`^${target}\\s*:(?!=)`, "m").test(makefile);
}

/** The checks a project declares, test first. `platform` picks the python
 *  launcher (`python` on Windows, `python3` elsewhere). */
export function detectChecks(f: ProjectFacts, platform: "windows" | "unix" = "unix"): CheckSpec[] {
  const entries = new Set(f.entries);
  const out: CheckSpec[] = [];
  if (f.packageJson) out.push(...fromPackageJson(f.packageJson, entries));
  if (f.cargoToml) {
    const workspace = /^\[workspace\]/m.test(f.cargoToml);
    out.push({
      id: "cargo:test",
      label: "Rust tests",
      kind: "test",
      argv: ["cargo", "test", ...(workspace ? ["--workspace"] : [])],
      source: "Cargo.toml",
      runner: "cargo",
    });
  }
  if (entries.has("go.mod"))
    out.push({ id: "go:test", label: "Go tests", kind: "test", argv: ["go", "test", "./..."], source: "go.mod", runner: "go" });
  if (pytestConfigured(f, entries))
    out.push({
      id: "pytest",
      label: "Python tests",
      kind: "test",
      argv: [platform === "windows" ? "python" : "python3", "-m", "pytest", "-q"],
      source: "pytest",
      runner: "pytest",
    });
  // A Makefile speaks for projects nothing above recognised — and only then,
  // because `make test` in a repo that also has package.json usually just
  // calls the same suite again.
  if (!out.some((c) => c.kind === "test") && f.makefile) {
    if (makeTarget(f.makefile, "test"))
      out.push({ id: "make:test", label: "make test", kind: "test", argv: ["make", "test"], source: "Makefile" });
    else if (makeTarget(f.makefile, "check"))
      out.push({ id: "make:check", label: "make check", kind: "check", argv: ["make", "check"], source: "Makefile" });
  }
  return out.slice(0, 5);
}

/** The person's own commands: one shell line each, run as written. */
export function customChecks(lines: readonly string[], platform: "windows" | "unix" = "unix"): CheckSpec[] {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((line, i) => ({
      id: `custom:${i}`,
      label: line.length > 40 ? `${line.slice(0, 39)}…` : line,
      // Anything that looks like a test runner is held to the zero-test rule.
      kind: /\b(test|pytest|vitest|jest|spec)\b/.test(line) ? ("test" as const) : ("check" as const),
      // The desktop wraps every argv in `cmd /C` on Windows already.
      argv: platform === "windows" ? [line] : ["/bin/sh", "-c", line],
      source: "custom" as const,
    }));
}

// ---------------------------------------------------------------- loading

const MANIFESTS = ["package.json", "Cargo.toml", "Makefile", "pyproject.toml", "setup.cfg", "tox.ini"];

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}/${name}`;

export async function loadProjectFacts(dir: string): Promise<ProjectFacts> {
  const listing = await ipc.fsReadDir(dir).catch(() => []);
  const entries = listing.map((e) => e.name);
  const present = new Set(entries);
  const read = async (name: string) =>
    present.has(name) ? ipc.fsReadText(join(dir, name), 512 * 1024).catch(() => undefined) : undefined;
  const [packageJson, cargoToml, makefile, pyproject, setupCfg, toxIni] = await Promise.all(MANIFESTS.map(read));
  return { entries, packageJson, cargoToml, makefile, pyproject, setupCfg, toxIni };
}

/** Detection is a handful of reads; cache it per directory for a while, and
 *  drop it when a turn touches a manifest. */
const cache = new Map<string, { at: number; checks: CheckSpec[] }>();
const TTL_MS = 10 * 60 * 1000;

export function forgetDetection(dir?: string): void {
  if (dir) cache.delete(dir);
  else cache.clear();
}

export function touchesManifest(files: readonly string[]): boolean {
  return files.some((f) => MANIFESTS.includes(f.split(/[\\/]/).pop() ?? "") || /(^|[\\/])go\.mod$/.test(f));
}

export async function detectChecksAt(
  dirs: readonly string[],
  platform: "windows" | "unix",
  now = Date.now(),
): Promise<{ dir: string; checks: CheckSpec[] }> {
  for (const dir of dirs) {
    const hit = cache.get(dir);
    if (hit && now - hit.at < TTL_MS) {
      if (hit.checks.length) return { dir, checks: hit.checks };
      continue;
    }
    const checks = detectChecks(await loadProjectFacts(dir), platform);
    cache.set(dir, { at: now, checks });
    if (checks.length) return { dir, checks };
  }
  return { dir: dirs[0] ?? "", checks: [] };
}

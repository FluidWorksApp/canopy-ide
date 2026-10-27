// Do the packages the agent just added actually exist?
//
// About one in twenty frontier-model answers still names a package that was
// never published (arXiv 2605.17062) — and a squatter can publish it later.
// The receipt compares each dependency manifest the turn changed with its
// version at the turn's base, and asks the public registry about every new
// name. A 404 is "unknown package"; no answer is "couldn't check", never a
// guess either way.
//
// Parsing is pure; the registry query goes through receipt_run_check (curl), so
// it runs where the project runs — the VM in a Linux workspace — and is not
// subject to the webview's CORS rules.

import type { PackageCheck, PackageEcosystem } from "./types";

export interface NewDependency {
  ecosystem: PackageEcosystem;
  name: string;
  manifest: string;
}

const NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/** Specs that do not come from the public registry. */
const LOCAL_SPEC = /^(file:|link:|workspace:|portal:|git\+|git:|github:|https?:|npm:)/;

export function npmDeps(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    for (const section of NPM_SECTIONS) {
      const deps = pkg[section];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, spec] of Object.entries(deps as Record<string, unknown>))
        out.set(name, typeof spec === "string" ? spec : "");
    }
  } catch {
    // An unparsable manifest has no dependencies we can vouch for.
  }
  return out;
}

/** Dependency names in Cargo.toml's dependency tables, minus path/git ones. */
export function cargoDeps(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  let section = "";
  for (const line of raw.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      // `[dependencies.serde]` names the crate in the header.
      const dotted = /^(?:target\..+\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      if (dotted) out.set(dotted[1], "");
      continue;
    }
    if (!/^(?:target\..+\.)?(?:workspace\.)?(?:dev-|build-)?dependencies$/.test(section)) continue;
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const spec = m[2];
    if (/\b(path|git)\s*=/.test(spec) || /workspace\s*=\s*true/.test(spec)) continue;
    // `package = "real-name"` renames: the registry knows the real one.
    const renamed = /\bpackage\s*=\s*"([^"]+)"/.exec(spec);
    out.set(renamed ? renamed[1] : m[1], spec);
  }
  return out;
}

/** requirements.txt lines and pyproject's [project] dependencies. */
export function pythonDeps(raw: string | null | undefined, file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  const nameOf = (spec: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1];
  if (/\.toml$/.test(file)) {
    const block = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(raw);
    for (const m of block?.[1].matchAll(/["']([^"']+)["']/g) ?? []) {
      const name = nameOf(m[1]);
      if (name) out.set(name.toLowerCase(), m[1]);
    }
    return out;
  }
  for (const line of raw.split("\n")) {
    const t = line.replace(/#.*/, "").trim();
    if (!t || t.startsWith("-") || /:\/\//.test(t) || t.startsWith(".")) continue;
    const name = nameOf(t);
    if (name) out.set(name.toLowerCase(), t);
  }
  return out;
}

export type ManifestKind = "npm" | "cargo" | "pypi-req" | "pypi-toml";

export function manifestKind(path: string): ManifestKind | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  if (base === "package.json") return "npm";
  if (base === "Cargo.toml") return "cargo";
  if (/^requirements.*\.txt$/.test(base)) return "pypi-req";
  if (base === "pyproject.toml") return "pypi-toml";
  return null;
}

/** Names present after the turn and absent before it. */
export function newDependencies(path: string, before: string | null, after: string | null): NewDependency[] {
  const kind = manifestKind(path);
  if (!kind) return [];
  const parse =
    kind === "npm" ? npmDeps : kind === "cargo" ? cargoDeps : (raw: string | null) => pythonDeps(raw, path);
  const was = parse(before);
  const now = parse(after);
  const ecosystem: PackageEcosystem = kind === "npm" ? "npm" : kind === "cargo" ? "crates" : "pypi";
  const out: NewDependency[] = [];
  for (const [name, spec] of now) {
    if (was.has(name)) continue;
    if (kind === "npm" && LOCAL_SPEC.test(spec)) continue;
    out.push({ ecosystem, name, manifest: path });
  }
  return out;
}

/** The registry URL whose 200/404 answers "does it exist". */
export function registryUrl(dep: Pick<NewDependency, "ecosystem" | "name">): string {
  switch (dep.ecosystem) {
    case "npm":
      return `https://registry.npmjs.org/${dep.name.replace("/", "%2F")}`;
    case "crates":
      return `https://crates.io/api/v1/crates/${encodeURIComponent(dep.name)}`;
    case "pypi":
      return `https://pypi.org/pypi/${encodeURIComponent(dep.name)}/json`;
  }
}

/** curl argv printing only the status code. crates.io asks callers to
 *  identify themselves, hence the user agent. */
export function registryArgv(dep: NewDependency, platform: "windows" | "unix"): string[] {
  return [
    "curl",
    "-s",
    // HEAD is enough for npm and PyPI (whose full documents can run to
    // megabytes); crates.io's API answers GET, and its body is small.
    ...(dep.ecosystem === "crates" ? [] : ["-I"]),
    "-o",
    platform === "windows" ? "NUL" : "/dev/null",
    "-w",
    "%{http_code}",
    "-A",
    "canopy-ide-receipts",
    "--max-time",
    "8",
    registryUrl(dep),
  ];
}

export function registryStatus(code: number | null, stdout: string): PackageCheck["status"] {
  if (code !== 0) return "unchecked";
  const http = stdout.trim().slice(-3);
  if (http === "200") return "exists";
  if (http === "404") return "unknown";
  return "unchecked";
}

/** Valid package names only — never pass something shell-shaped to curl. */
export function plausibleName(dep: NewDependency): boolean {
  if (dep.ecosystem === "npm") return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(dep.name) && dep.name.length <= 214;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(dep.name);
}

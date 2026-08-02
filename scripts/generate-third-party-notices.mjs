#!/usr/bin/env node
// Regenerates THIRD-PARTY-NOTICES.md from the resolved dependency trees.
//
//   node scripts/generate-third-party-notices.mjs [--check]
//
// Sources of truth:
//   * Rust  — `cargo metadata --all-features`, walked from the root crate with
//             dev-only edges pruned. --all-features deliberately over-includes
//             (the Intel-macOS build compiles dictation out), because a notice
//             that lists a crate we didn't ship is harmless and one that omits
//             a crate we did ship is not.
//   * npm   — the production closure of package-lock.json. devDependencies
//             (vite, oxlint, typescript, lightningcss...) build the app but are
//             never distributed, so they carry no notice obligation.
//   * Plus the hand-maintained BUNDLED_BINARIES / RUNTIME_DOWNLOADS below, for
//     artifacts that no package manager knows about.
//
// Attribution model: every component is listed with its own copyright line,
// scraped from its own LICENSE file; the full text of each distinct license
// appears once in the appendix. That satisfies the "reproduce the copyright
// notice and this permission notice" condition common to MIT/BSD/ISC without
// pasting 900 near-identical MIT blocks.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXTS_DIR = join(ROOT, "scripts", "license-texts");
const OUT = join(ROOT, "THIRD-PARTY-NOTICES.md");

// ---------------------------------------------------------------------------
// Dual-license elections. Where a component offers a choice, Canopy takes one
// option and only that option's terms bind us. Keys are the raw license strings
// as published (crates and npm packages are inconsistent about OR vs / vs AND).
// ---------------------------------------------------------------------------
const ELECTIONS = {
  "MIT OR Apache-2.0": "MIT",
  "Apache-2.0 OR MIT": "MIT",
  "MIT/Apache-2.0": "MIT",
  "Apache-2.0/MIT": "MIT",
  "Apache-2.0 / MIT": "MIT",
  "Apache-2.0 OR ISC OR MIT": "MIT",
  "Zlib OR Apache-2.0 OR MIT": "MIT",
  "MIT OR Zlib OR Apache-2.0": "MIT",
  "MIT OR Apache-2.0 OR Zlib": "MIT",
  "Unlicense OR MIT": "MIT",
  "Unlicense/MIT": "MIT",
  "BSD-3-Clause OR MIT OR Apache-2.0": "MIT",
  "BSD-2-Clause OR MIT OR Apache-2.0": "MIT",
  "BSD-2-Clause OR Apache-2.0 OR MIT": "MIT",
  "0BSD OR MIT OR Apache-2.0": "MIT",
  "MIT OR Apache-2.0 OR LGPL-2.1-or-later": "MIT",
  "MIT OR Apache-2.0 OR BSD-1-Clause": "MIT",
  "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT": "MIT",
  "BSD-3-Clause/MIT": "MIT",
  "(MIT OR GPL-3.0-or-later)": "MIT",
  "MIT OR GPL-3.0-or-later": "MIT",
  "CC0-1.0 OR MIT-0 OR Apache-2.0": "MIT-0",
  "(MPL-2.0 OR Apache-2.0)": "Apache-2.0",
  "MPL-2.0 OR Apache-2.0": "Apache-2.0",
  "Apache-2.0 OR BSL-1.0": "Apache-2.0",
  "BSD-2-Clause OR Apache-2.0": "BSD-2-Clause",
  // Not elections — normalisations of non-SPDX or compound strings.
  "Apache-2.0 AND MIT": "Apache-2.0 AND MIT",
  "Apache-2.0 AND ISC": "Apache-2.0 AND ISC",
  "BSD-3-Clause AND MIT": "BSD-3-Clause AND MIT",
  "MIT AND BSD-3-Clause": "BSD-3-Clause AND MIT",
  "(BSD-3-Clause AND Apache-2.0)": "BSD-3-Clause AND Apache-2.0",
  "(MIT AND Zlib)": "MIT AND Zlib",
  "(MIT OR Apache-2.0) AND Unicode-3.0": "MIT AND Unicode-3.0",
  "LGPL-2.1+": "LGPL-2.1-or-later",
  BSD: "BSD-2-Clause", // duck@0.1.12 — its LICENSE file is verbatim BSD-2-Clause
};

// Packages whose manifest omits a license field but which ship a license file.
const LICENSE_OVERRIDES = {
  "khroma": "MIT", // no `license` in package.json; ships an MIT `license` file
};

// Which appendix text covers each elected license. An entry here is a promise
// that scripts/license-texts/<file> exists.
const TEXT_FILES = {
  "MIT": "MIT.txt",
  "MIT-0": "MIT-0.txt",
  "Apache-2.0": "Apache-2.0.txt",
  "Apache-2.0 WITH LLVM-exception": "Apache-2.0-WITH-LLVM-exception.txt",
  "BSD-2-Clause": "BSD-2-Clause.txt",
  "BSD-3-Clause": "BSD-3-Clause.txt",
  "ISC": "ISC.txt",
  "MPL-2.0": "MPL-2.0.txt",
  "LGPL-2.1-or-later": "LGPL-2.1.txt",
  "Unicode-3.0": "Unicode-3.0.txt",
  "Zlib": "Zlib.txt",
  "CC0-1.0": "CC0-1.0.txt",
  "Unlicense": "Unlicense.txt",
  "CDLA-Permissive-2.0": "CDLA-Permissive-2.0.txt",
  "OFL-1.1": "OFL-1.1.txt",
};

// Binaries redistributed inside the app bundle that no lockfile covers.
const BUNDLED_BINARIES = [
  {
    name: "ONNX Runtime",
    version: "1.24.x",
    license: "MIT",
    copyright: "Copyright (c) Microsoft Corporation",
    note:
      "Microsoft's official prebuilt shared library (`libonnxruntime.dylib` / " +
      "`.so` / `.dll`), fetched at release time and shipped in the app bundle " +
      "as `onnxruntime/`. Voice dictation loads it dynamically. The Intel-macOS " +
      "build has no compatible release and ships without it.",
    url: "https://github.com/microsoft/onnxruntime",
  },
];

// Speech models the user opts into downloading at runtime. Canopy does not
// redistribute them — it fetches them to the user's machine on first use — so
// they carry no notice obligation for our binaries, but their terms govern use.
const RUNTIME_DOWNLOADS = [
  {
    name: "Parakeet TDT 0.6B v3 (int8)",
    license: "CC-BY-4.0",
    by: "NVIDIA",
    url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
  },
  {
    name: "SenseVoice Small (int8)",
    // Not a standard SPDX licence — FunASR ships a bespoke model licence, so
    // its terms have to be read rather than assumed permissive.
    license: "FunASR MODEL_LICENSE (custom) — <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>",
    by: "FunAudioLLM / Alibaba",
    url: "https://huggingface.co/FunAudioLLM/SenseVoiceSmall",
  },
  {
    name: "Moonshine Base",
    license: "MIT",
    by: "Useful Sensors",
    url: "https://huggingface.co/UsefulSensors/moonshine",
  },
];

// ---------------------------------------------------------------------------
// Copyright-line extraction
// ---------------------------------------------------------------------------
const LICENSE_FILE_RE = /^(LICEN[SC]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE)/i;

function licenseFilesIn(dir) {
  if (!dir || !existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => LICENSE_FILE_RE.test(e))
    .map((e) => join(dir, e))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

// Pulls the "Copyright (c) 2019 Someone" lines out of a package's own license
// files. These are the notices we are actually obliged to reproduce.
function copyrightsFor(dir) {
  const out = new Set();
  for (const file of licenseFilesIn(dir)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/).slice(0, 60)) {
      const line = raw.trim().replace(/\s+/g, " ");
      // An attribution reads "Copyright (c) 2019 Someone" — a year, a symbol or
      // a capitalised name has to follow. Wrapped fragments of a license's own
      // body ("copyright notice, this list of conditions...", "COPYRIGHT
      // HOLDERS BE LIABLE...") also start with the word and must not be picked
      // up as if they attributed anyone.
      if (!/^copyright\s*(\(c\)|©|\d{4}|[A-Z][a-z])/i.test(line)) continue;
      // NB the /i above also makes `[A-Z][a-z]` match a lowercase word, so
      // this list — not the capitalisation — is what actually rejects a
      // wrapped fragment of the license's own prose. "copyright statement(s)"
      // is the OFL's, from its definition of a Reserved Font Name.
      if (/^copyright\s+(notice|holders?|owner|and|license|in|statements?)\b/i.test(line)) continue;
      // Boilerplate that belongs to the license text itself, not the component.
      if (/free software foundation|mozilla foundation|apache software foundation/i.test(line)) continue;
      if (/^copyright\s*\(c\)\s*<year>/i.test(line)) continue;
      // Long enough for a real two-holder attribution. Font licenses restate
      // the holder once for the family and again per style file, which runs
      // past 200 — JetBrains Mono's is 221, and dropping it would have lost
      // the one notice the OFL actually obliges us to reproduce.
      if (line.length > 400) continue;
      out.add(line.replace(/[.,;]\s*$/, ""));
    }
    if (out.size) break; // first file that yields attribution wins
  }
  return [...out];
}

// Some packages ship a bare license text with no copyright line (SheetJS's
// Apache-2.0 file, the CodinGame Monaco packages). Their manifest still names
// the rights holder, which is the attribution we owe.
function attributionFallback(authors) {
  const names = (Array.isArray(authors) ? authors : [authors])
    .filter(Boolean)
    .map((a) => (typeof a === "string" ? a : a.name))
    .filter(Boolean)
    .map((a) => a.replace(/\s*<[^>]*>/g, "").replace(/\s*\([^)]*\)/g, "").trim())
    .filter((a) => a && a !== "The Rust Project Developers");
  return names.length ? [`Copyright ${names.join(", ")} (per package manifest; the distributed license file carries no copyright line)`] : [];
}

/** The manifest's rights holder, from whichever copy of the package is on disk.
 *  pnpm only links a transitive dependency into the store, so the path the
 *  lockfile names often doesn't exist — the license *file* was already read
 *  from the store, and the author has to be, or a package whose attribution
 *  lives only in its manifest silently loses it depending on the installer. */
function authorFrom(dirs) {
  for (const dir of dirs) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    try {
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      const author = manifest.author ?? manifest.contributors;
      if (author) return author;
    } catch {
      // A package.json we can't parse is not an attribution; keep looking.
    }
  }
  return undefined;
}

function normaliseLicense(name, raw) {
  const key = LICENSE_OVERRIDES[name] ?? raw;
  if (!key) return "UNKNOWN";
  const trimmed = String(key).trim();
  return ELECTIONS[trimmed] ?? trimmed;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------
function collectCrates() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--all-features", "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml")],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.resolve.root;

  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const kinds = new Set(dep.dep_kinds.map((k) => k.kind));
      if (kinds.size === 1 && kinds.has("dev")) continue; // dev-only: not shipped
      walk(dep.pkg);
    }
  };
  walk(root);

  const out = [];
  for (const id of seen) {
    if (id === root) continue;
    const p = byId.get(id);
    const dir = dirname(p.manifest_path);
    const copyrights = copyrightsFor(dir);
    out.push({
      name: p.name,
      version: p.version,
      license: normaliseLicense(p.name, p.license),
      declared: p.license ?? null,
      copyrights: copyrights.length ? copyrights : attributionFallback(p.authors),
      repository: p.repository ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// npm — production closure only
// ---------------------------------------------------------------------------
function collectNpm() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const pkgs = lock.packages;

  // node_modules resolution: walk up from the importer's path.
  const resolveDep = (from, name) => {
    let base = from;
    for (;;) {
      const cand = (base ? base + "/" : "") + "node_modules/" + name;
      if (pkgs[cand]) return cand;
      if (!base) return null;
      base = base.includes("/node_modules/") ? base.slice(0, base.lastIndexOf("/node_modules/")) : "";
    }
  };

  const seen = new Set();
  const walk = (path) => {
    const entry = pkgs[path];
    if (!entry) return;
    const deps = [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {})];
    for (const name of deps) {
      const child = resolveDep(path, name);
      if (child && !seen.has(child)) {
        seen.add(child);
        walk(child);
      }
    }
  };
  // Root devDependencies are intentionally not walked — they build the app,
  // they are not part of it.
  for (const name of Object.keys(pkgs[""].dependencies ?? {})) {
    const child = resolveDep("", name);
    if (child && !seen.has(child)) {
      seen.add(child);
      walk(child);
    }
  }

  const out = [];
  for (const path of seen) {
    const entry = pkgs[path];
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    let declared = entry.license;
    if (Array.isArray(declared)) declared = declared.map((l) => l.type ?? l).join(" OR ");
    let manifest = {};
    if (existsSync(join(ROOT, path, "package.json"))) {
      manifest = JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8"));
    }
    if (!declared) {
      declared = manifest.license ?? manifest.licenses;
      if (Array.isArray(declared)) declared = declared.map((l) => l.type ?? l).join(" OR ");
      if (declared && typeof declared === "object") declared = declared.type;
    }
    out.push({
      name,
      version: entry.version ?? "?",
      license: normaliseLicense(name, declared),
      declared: declared ?? null,
      paths: [path],
      author: manifest.author ?? manifest.contributors,
      repository: null,
    });
  }

  // npm may install one package at several paths, and which paths exist depends
  // on how it chose to hoist — a locally-deduped tree and a fresh `npm ci` do
  // not agree. Merge by identity and read the attribution from whichever copy is
  // actually on disk, so the notices describe the package rather than the
  // install layout.
  const byIdentity = new Map();
  for (const c of out) {
    const key = `${c.name}@${c.version}`;
    const existing = byIdentity.get(key);
    if (existing) existing.paths.push(...c.paths);
    else byIdentity.set(key, c);
  }
  return [...byIdentity.values()].map((c) => {
    const dirs = [...c.paths.map((p) => join(ROOT, p)), pnpmDirFor(c.name, c.version)].filter(Boolean);
    const copyrights = dirs.map(copyrightsFor).find((r) => r.length) ?? [];
    const author = c.author ?? authorFrom(dirs);
    return { ...c, author, copyrights: copyrights.length ? copyrights : attributionFallback(author) };
  });
}

// package-lock.json describes npm's nested layout; a pnpm install puts the same
// package somewhere else entirely, so every nested path in the lockfile misses
// on disk and the package silently loses its attribution. Look in the pnpm store
// as a last resort — after the lockfile paths, so an npm tree renders identically
// and `--check` in CI stays stable.
function pnpmDirFor(name, version) {
  const store = join(ROOT, "node_modules", ".pnpm");
  if (!existsSync(store)) return null;
  // Store dirs are "<name with / as +>@<version>", plus a "_<peer hash>" suffix
  // when the same version is installed against different peers.
  const prefix = `${name.replaceAll("/", "+")}@${version}`;
  let match;
  try {
    match = readdirSync(store).find((e) => e === prefix || e.startsWith(`${prefix}_`));
  } catch {
    return null;
  }
  return match ? join(store, match, "node_modules", name) : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function groupByLicense(components) {
  const groups = new Map();
  for (const c of components) {
    if (!groups.has(c.license)) groups.set(c.license, []);
    groups.get(c.license).push(c);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function renderSection(title, components) {
  const lines = [`## ${title} (${components.length})`, ""];
  for (const [license, items] of groupByLicense(components)) {
    lines.push(`### ${license} — ${items.length}`, "");
    // Sort on (name, version) so --check compares like with like: several
    // versions of the same crate coexist in the tree (windows-sys, toml, ...).
    for (const c of items.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
      const attribution = c.copyrights.length ? c.copyrights.join("; ") : "no copyright line in the distributed license file";
      lines.push(`- **${c.name} ${c.version}** — ${attribution}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function licenseTexts(licenses) {
  const wanted = new Set();
  for (const l of licenses) {
    // "A AND B" binds both; split so both texts get included.
    for (const part of l.split(" AND ")) wanted.add(part.trim());
  }
  const lines = ["## License texts", ""];
  const missing = [];
  for (const id of [...wanted].sort()) {
    const file = TEXT_FILES[id];
    if (!file) {
      missing.push(id);
      continue;
    }
    lines.push(`### ${id}`, "", "```", readFileSync(join(TEXTS_DIR, file), "utf8").trimEnd(), "```", "");
  }
  return { text: lines.join("\n"), missing };
}

// A bare "out of date" is useless in CI, where the machine that noticed the
// drift is not the machine that can re-run the generator. Name the components
// that moved, and fall back to the first differing line for prose changes.
function reportDrift(current, expected) {
  const componentLines = (text) => new Set(text.split("\n").filter((l) => l.startsWith("- **")));
  const committed = componentLines(current);
  const generated = componentLines(expected);
  const missing = [...generated].filter((l) => !committed.has(l));
  const stale = [...committed].filter((l) => !generated.has(l));

  const show = (label, lines) => {
    if (!lines.length) return;
    console.error(`${label} (${lines.length}):`);
    for (const l of lines.slice(0, 25)) console.error(`  ${l.replace(/^- /, "")}`);
    if (lines.length > 25) console.error(`  ...and ${lines.length - 25} more`);
    console.error("");
  };
  show("In the regenerated file but not the committed one", missing);
  show("In the committed file but not the regenerated one", stale);

  if (!missing.length && !stale.length) {
    const a = current.split("\n");
    const b = expected.split("\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.error(`No component changed; first textual difference is at line ${i + 1}:`);
    console.error(`  committed: ${JSON.stringify(a[i] ?? "<end of file>")}`);
    console.error(`  generated: ${JSON.stringify(b[i] ?? "<end of file>")}`);
  }
}

// ---------------------------------------------------------------------------
function main() {
  const crates = collectCrates();
  const npm = collectNpm();
  const all = [...crates, ...npm, ...BUNDLED_BINARIES.map((b) => ({ ...b, copyrights: [b.copyright] }))];

  const { text: texts, missing } = licenseTexts(all.map((c) => c.license));
  if (missing.length) {
    console.error(`No license text on file for: ${missing.join(", ")}`);
    console.error(`Add scripts/license-texts/<id>.txt and register it in TEXT_FILES.`);
    process.exitCode = 1;
  }

  const body = `# Third-party notices

Canopy is licensed under the MIT License (see [LICENSE.md](./LICENSE.md)). The
components listed here are licensed by their respective authors under the terms
below, and those terms — not Canopy's — govern their use.

This file is generated. Do not edit it by hand:

    node scripts/generate-third-party-notices.mjs

It covers what Canopy **distributes**: the Rust dependency closure of the app
binary (dev-only crates pruned), the production npm closure that is bundled into
the frontend, and the prebuilt binaries shipped inside the app bundle. Build-only
tooling — Vite, Rolldown, oxlint, TypeScript, lightningcss and friends — is not
listed, because it never leaves the build machine. Hand-ported source is
listed too, under "Notes on specific components", since it appears in no
manifest.

Each component appears with the copyright notice taken from its own license
file; the full text of every license in play is reproduced in the appendix.

## Notes on specific components

**fzf — MIT.** \`shared/fuzzy.ts\` is a hand port of fzf's matching and scoring
algorithm (\`algo/algo.go\`), compiled into the frontend bundle. Copyright (c)
2013-2026 Junegunn Choi; MIT text in the appendix; source:
<https://github.com/junegunn/fzf>.

**jschardet ${npm.find((p) => p.name === "jschardet")?.version ?? ""} — LGPL-2.1-or-later.** Pulled in transitively by
\`@codingame/monaco-vscode-api\` for character-set detection, and included in the
distributed application. The LGPL permits this without affecting Canopy's own
license, provided users can replace the library with a modified version. Canopy
ships jschardet as its own separate JavaScript chunk (\`assets/jschardet-*.js\`)
rather than inlining it into the main bundle, so it can be substituted in place.
Its full text is in the appendix below; source:
<https://github.com/aadsm/jschardet>.

**Dual-licensed components.** Where a component offers a choice, Canopy elects
the permissive option and only that option's terms bind this distribution —
\`jszip\` under MIT (not GPL-3.0-or-later), \`dompurify\` under Apache-2.0 (not
MPL-2.0), \`r-efi\` under MIT (not LGPL-2.1-or-later), and the large
MIT-or-Apache-2.0 Rust ecosystem under MIT. Components are grouped below by the
elected license, not the declared expression.

**Bundled fonts — OFL-1.1.** Archivo and JetBrains Mono ship inside the app as
\`.woff2\` files (the Vitrine skin sets them; every other skin uses the system
UI font). The OFL exists to permit exactly this: it allows the fonts to be
bundled and redistributed with software, including commercially, and it does
not reach the software they ship with — Canopy stays MIT. What it does require
is met here. The fonts are not sold on their own. Each holder's copyright
notice is reproduced above and the license text in full below. Neither family
declares a Reserved Font Name, so the subsetting the \`@fontsource-variable\`
packages perform to produce the \`.woff2\` files does not oblige a rename.

**MPL-2.0 components** are file-level copyleft: obligations attach only to
modifications of those files, which Canopy does not make. Their sources are
available from their upstream repositories at the versions listed.

**PDF preview** uses the host webview's built-in PDF viewer via an \`<embed>\`
element (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). No PDF
rendering library is bundled, so nothing is redistributed for that feature.

## Prebuilt binaries shipped in the app bundle

${BUNDLED_BINARIES.map(
    (b) => `**${b.name} ${b.version} — ${b.license}.** ${b.copyright}. ${b.note} <${b.url}>`,
  ).join("\n\n")}

## Models downloaded at runtime

Voice dictation downloads a speech model on first use. Canopy does not
redistribute these — they are fetched to the user's own machine — but their
terms govern use of the model:

${RUNTIME_DOWNLOADS.map((m) => `- **${m.name}** — ${m.license}, by ${m.by}. <${m.url}>`).join("\n")}

${renderSection("Rust crates", crates)}
${renderSection("npm packages", npm)}
${texts}`;

  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== body) {
      console.error("THIRD-PARTY-NOTICES.md is out of date — run: node scripts/generate-third-party-notices.mjs\n");
      reportDrift(current, body);
      process.exitCode = 1;
      return;
    }
    console.log("THIRD-PARTY-NOTICES.md is up to date.");
    return;
  }

  writeFileSync(OUT, body);
  const unknown = all.filter((c) => c.license === "UNKNOWN");
  console.log(`Wrote ${OUT}: ${crates.length} crates, ${npm.length} npm packages, ${BUNDLED_BINARIES.length} bundled binaries.`);
  if (unknown.length) {
    console.error(`\nUnknown license for: ${unknown.map((c) => c.name).join(", ")}`);
    console.error("Add an entry to LICENSE_OVERRIDES after checking the package's own license file.");
    process.exitCode = 1;
  }
  const noAttribution = all.filter((c) => !c.copyrights.length);
  if (noAttribution.length) {
    console.log(`\n${noAttribution.length} components ship no copyright line of their own (nothing to reproduce for those).`);
  }
}

main();

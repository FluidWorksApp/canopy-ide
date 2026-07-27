// Which language a file name is highlighted as.
//
// Monaco only knows the grammars @codingame/monaco-vscode-standalone-languages
// bundles, and that set has holes people hit on day one: C++ registers .c/.h
// but not .cpp/.hpp, there is no JSON grammar at all, and nothing at all for
// .astro/.svelte/.vue/.toml. Every one of those opened as plain grey text.
//
// So, like VS Code's `files.associations`, a file name maps to a language id
// through a table: EXTRA_ASSOCIATIONS fills the gaps with the closest bundled
// grammar, and the user's own map (Settings → Editor) overrides anything.
// Nothing here touches Monaco's registry — associations resolve at lookup time,
// so removing one takes effect immediately (a registered language can never be
// unregistered).

/** A language id Monaco has a grammar for, as offered in the Settings picker.
 *  "plaintext" is the escape hatch: map a pattern to it to switch highlighting
 *  off for that file type. */
export const LANGUAGES: { id: string; label: string }[] = [
  { id: "plaintext", label: "Plain text" },
  { id: "bat", label: "Batch" },
  { id: "clojure", label: "Clojure" },
  { id: "coffee", label: "CoffeeScript" },
  { id: "cpp", label: "C / C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "dart", label: "Dart" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "elixir", label: "Elixir" },
  { id: "fsharp", label: "F#" },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "handlebars", label: "Handlebars" },
  { id: "hcl", label: "HCL / Terraform" },
  { id: "html", label: "HTML" },
  { id: "ini", label: "INI / TOML-like" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "julia", label: "Julia" },
  { id: "kotlin", label: "Kotlin" },
  { id: "less", label: "Less" },
  { id: "liquid", label: "Liquid" },
  { id: "lua", label: "Lua" },
  { id: "markdown", label: "Markdown" },
  { id: "mdx", label: "MDX" },
  { id: "objective-c", label: "Objective-C" },
  { id: "perl", label: "Perl" },
  { id: "php", label: "PHP" },
  { id: "powershell", label: "PowerShell" },
  { id: "protobuf", label: "Protocol Buffers" },
  { id: "pug", label: "Pug" },
  { id: "python", label: "Python" },
  { id: "r", label: "R" },
  { id: "razor", label: "Razor" },
  { id: "restructuredtext", label: "reStructuredText" },
  { id: "ruby", label: "Ruby" },
  { id: "rust", label: "Rust" },
  { id: "scala", label: "Scala" },
  { id: "scheme", label: "Scheme" },
  { id: "scss", label: "Sass (SCSS)" },
  { id: "shell", label: "Shell" },
  { id: "solidity", label: "Solidity" },
  { id: "sql", label: "SQL" },
  { id: "swift", label: "Swift" },
  { id: "systemverilog", label: "SystemVerilog" },
  { id: "tcl", label: "Tcl" },
  { id: "twig", label: "Twig / Jinja" },
  { id: "typescript", label: "TypeScript" },
  { id: "typespec", label: "TypeSpec" },
  { id: "wgsl", label: "WGSL" },
  { id: "xml", label: "XML" },
  { id: "yaml", label: "YAML" },
];

const LANGUAGE_IDS = new Set(LANGUAGES.map((l) => l.id));

export function languageLabel(id: string): string {
  return LANGUAGES.find((l) => l.id === id)?.label ?? id;
}

export interface AssociationGroup {
  label: string;
  /** Why this group maps the way it does — shown once above its rows so the
   *  approximations (Astro as HTML, TOML as INI) read as deliberate. */
  blurb: string;
  entries: { pattern: string; language: string }[];
}

/**
 * The mappings Canopy ships. Each one is a file type Monaco's bundled grammars
 * miss, pointed at the closest grammar that does exist — the same trade VS Code
 * users make by hand with `files.associations` when an extension isn't
 * installed. Close beats grey: Astro's markup, script and style blocks all
 * highlight correctly as HTML even though its frontmatter does not.
 */
export const EXTRA_ASSOCIATIONS: AssociationGroup[] = [
  {
    label: "Components & templates",
    blurb: "Single-file components and server templates, as HTML-family markup.",
    entries: [
      { pattern: "*.astro", language: "html" },
      { pattern: "*.svelte", language: "html" },
      { pattern: "*.vue", language: "html" },
      { pattern: "*.erb", language: "html" },
      { pattern: "*.ejs", language: "html" },
      { pattern: "*.mustache", language: "html" },
      { pattern: "*.njk", language: "twig" },
      { pattern: "*.jinja", language: "twig" },
      { pattern: "*.jinja2", language: "twig" },
      { pattern: "*.j2", language: "twig" },
    ],
  },
  {
    label: "Stylesheets",
    blurb: "CSS dialects Monaco has no separate grammar for.",
    entries: [
      { pattern: "*.sass", language: "scss" },
      { pattern: "*.pcss", language: "css" },
      { pattern: "*.postcss", language: "css" },
      { pattern: "*.styl", language: "css" },
    ],
  },
  {
    label: "C, C++ and Objective-C",
    blurb: "C++ ships registered for .c and .h only — every other suffix was plain text.",
    entries: [
      { pattern: "*.cpp", language: "cpp" },
      { pattern: "*.cc", language: "cpp" },
      { pattern: "*.cxx", language: "cpp" },
      { pattern: "*.c++", language: "cpp" },
      { pattern: "*.hpp", language: "cpp" },
      { pattern: "*.hh", language: "cpp" },
      { pattern: "*.hxx", language: "cpp" },
      { pattern: "*.h++", language: "cpp" },
      { pattern: "*.inl", language: "cpp" },
      { pattern: "*.ipp", language: "cpp" },
      { pattern: "*.cu", language: "cpp" },
      { pattern: "*.cuh", language: "cpp" },
      { pattern: "*.mm", language: "objective-c" },
    ],
  },
  {
    label: "Config & data",
    blurb:
      "No JSON grammar is bundled, so JSON files use the JavaScript one (a superset). TOML and dotfiles share INI's key/value and # comments.",
    entries: [
      { pattern: "*.json", language: "javascript" },
      { pattern: "*.jsonc", language: "javascript" },
      { pattern: "*.json5", language: "javascript" },
      { pattern: "*.jsonl", language: "javascript" },
      { pattern: "*.webmanifest", language: "javascript" },
      { pattern: "*.toml", language: "ini" },
      { pattern: "Cargo.lock", language: "ini" },
      { pattern: "*.conf", language: "ini" },
      { pattern: "*.cfg", language: "ini" },
      { pattern: "*.env", language: "ini" },
      { pattern: ".env.*", language: "ini" },
      { pattern: "*.gitignore", language: "ini" },
      { pattern: "*.dockerignore", language: "ini" },
      { pattern: "*.npmignore", language: "ini" },
      { pattern: "*.prettierignore", language: "ini" },
      { pattern: "*.npmrc", language: "ini" },
      { pattern: "*.plist", language: "xml" },
      { pattern: "*.resx", language: "xml" },
      { pattern: "*.storyboard", language: "xml" },
      { pattern: "*.xib", language: "xml" },
    ],
  },
  {
    label: "Shells & build files",
    blurb: "Anything whose body is a list of commands.",
    entries: [
      { pattern: "*.zsh", language: "shell" },
      { pattern: "*.fish", language: "shell" },
      { pattern: "*.ksh", language: "shell" },
      { pattern: "*.bats", language: "shell" },
      { pattern: ".bashrc", language: "shell" },
      { pattern: ".bash_profile", language: "shell" },
      { pattern: ".bash_aliases", language: "shell" },
      { pattern: ".zshrc", language: "shell" },
      { pattern: ".zshenv", language: "shell" },
      { pattern: ".zprofile", language: "shell" },
      { pattern: ".profile", language: "shell" },
      { pattern: "Makefile", language: "shell" },
      { pattern: "makefile", language: "shell" },
      { pattern: "GNUmakefile", language: "shell" },
      { pattern: "*.mk", language: "shell" },
      { pattern: "Dockerfile.*", language: "dockerfile" },
      { pattern: "Containerfile", language: "dockerfile" },
    ],
  },
  {
    label: "Other languages",
    blurb: "Younger languages, on the bundled grammar whose keywords line up best.",
    entries: [
      { pattern: "*.pyi", language: "python" },
      { pattern: "*.gradle", language: "java" },
      { pattern: "*.groovy", language: "java" },
      { pattern: "*.prisma", language: "typescript" },
      { pattern: "*.zig", language: "rust" },
      { pattern: "*.gleam", language: "rust" },
      { pattern: "*.templ", language: "go" },
      { pattern: "*.psql", language: "sql" },
      { pattern: "*.ddl", language: "sql" },
      { pattern: "*.graphqls", language: "graphql" },
      { pattern: "*.razor", language: "razor" },
    ],
  },
];

/** Flattened shipped table, pattern -> language. */
export const BUILTIN_MAP: Record<string, string> = Object.fromEntries(
  EXTRA_ASSOCIATIONS.flatMap((g) => g.entries.map((e) => [e.pattern, e.language] as const)),
);

/**
 * Canonical pattern text for a user-entered value.
 *
 * `kind` comes from the picker beside the field rather than being guessed:
 * "astro" is unambiguously an extension and "Makefile" unambiguously a name,
 * but nothing in the string itself says which, and guessing wrong produces a
 * mapping that silently never matches.
 *
 * Returns null when there's nothing usable left.
 */
export function normalizePattern(input: string, kind: "ext" | "name"): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (kind === "name") {
    // A name pattern may carry its own wildcards ("Dockerfile.*"); a path is
    // never meaningful here, only the last segment is matched.
    const name = raw.split(/[\\/]/).pop() ?? "";
    return name || null;
  }
  const ext = raw.replace(/^[*.]+/, "").trim();
  return ext ? `*.${ext}` : null;
}

/** Human phrasing for a stored pattern, for the settings list. */
export function describePattern(pattern: string): string {
  return pattern.startsWith("*.") ? pattern.slice(1) : pattern;
}

function toRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

// Compiled once per distinct pattern; the settings map is small but this is on
// the path of every file open and every collaborator file offer.
const regexCache = new Map<string, RegExp>();
function matches(pattern: string, name: string): boolean {
  let re = regexCache.get(pattern);
  if (!re) {
    re = toRegex(pattern);
    regexCache.set(pattern, re);
  }
  return re.test(name);
}

/** More specific wins: a literal name beats a wildcard, and among equals the
 *  longer pattern beats the shorter (so `*.d.ts` outranks `*.ts`). */
function specificity(pattern: string): number {
  return (pattern.includes("*") ? 0 : 1_000) + pattern.length;
}

function bestMatch(map: Record<string, string>, name: string): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const [pattern, language] of Object.entries(map)) {
    if (!matches(pattern, name)) continue;
    const score = specificity(pattern);
    if (score > bestScore) {
      bestScore = score;
      best = language;
    }
  }
  return best;
}

/** The user's mapping for this file, if any. Checked before Monaco's own
 *  registry, so a custom association overrides a shipped grammar. */
export function customLanguageFor(
  path: string,
  custom: Record<string, string>,
): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? path;
  return bestMatch(custom, name);
}

/** Canopy's gap-filling mapping for this file, if any. Checked after Monaco's
 *  registry, so a real grammar always wins over an approximation. */
export function extraLanguageFor(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? path;
  return bestMatch(BUILTIN_MAP, name);
}

export interface AssociationRow {
  pattern: string;
  language: string;
  /** Shipped by Canopy (as opposed to added by the user). */
  builtin: boolean;
  /** Shipped, but pointed somewhere else by the user. */
  overridden: boolean;
}

/** Every mapping in force, shipped and custom merged, for the settings list. */
export function effectiveAssociations(custom: Record<string, string>): AssociationRow[] {
  const rows: AssociationRow[] = EXTRA_ASSOCIATIONS.flatMap((g) =>
    g.entries.map((e) => ({
      pattern: e.pattern,
      language: custom[e.pattern] ?? e.language,
      builtin: true,
      overridden: custom[e.pattern] != null && custom[e.pattern] !== e.language,
    })),
  );
  const added = Object.entries(custom)
    .filter(([pattern]) => BUILTIN_MAP[pattern] == null)
    .map(([pattern, language]) => ({ pattern, language, builtin: false, overridden: false }));
  // User-added first: it's the short list, and it's the one they came to edit.
  return [...added, ...rows];
}

/** Drop entries a newer version no longer has a grammar for, so a stale stored
 *  map can't pin a file to a language id that tokenizes as nothing. */
export function sanitizeAssociations(custom: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(custom).filter(([, language]) => LANGUAGE_IDS.has(language)),
  );
}

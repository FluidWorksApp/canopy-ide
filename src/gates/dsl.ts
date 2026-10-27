// The gate DSL, TypeScript side: the closed set of things a compiled rule may
// be, how to check that what the brain returned is one of them, and how to say
// each one back to a person in plain words.
//
// The enforcer is Rust (src-tauri/src/gates.rs, run by canopy-hook on every
// PreToolUse). This file is the front door to it: nothing reaches the policy
// file unless `normalizeGate` accepted it here, so an inventive brain reply
// ("type": "run-script", a lookahead regex Rust can't compile, a glob that
// protects "/") is rejected before the person is ever asked to approve it.

export type Gate =
  | { type: "deny-path-write"; globs: string[]; exceptFiles?: string[] }
  | { type: "deny-command"; patterns: string[] }
  | { type: "require-confirm"; match?: ConfirmClass; patterns?: string[] }
  | { type: "protect-tests"; globs: string[] }
  | { type: "package-allowlist"; names: string[] }
  | { type: "package-denylist"; names: string[] }
  | { type: "egress-allowlist"; hosts: string[] }
  | { type: "unenforceable"; reason: string };

export type GateType = Gate["type"];

export const GATE_TYPES: readonly GateType[] = [
  "deny-path-write",
  "deny-command",
  "require-confirm",
  "protect-tests",
  "package-allowlist",
  "package-denylist",
  "egress-allowlist",
  "unenforceable",
];

/** `require-confirm` classes. The first group is built in and always on
 *  (gates.rs `classify_irreversible`); the second is opt-in. Keep in step with
 *  CONFIRM_CLASSES there. */
export const BUILT_IN_CLASSES = [
  "database",
  "delete-files",
  "force-push",
  "discard-work",
  "delete-storage",
  "infra-destroy",
  "deploy",
  "money",
] as const;
export const OPT_IN_CLASSES = [
  "publish",
  "migrate",
  "install",
  "push",
  "deploy-any",
  "network-write",
] as const;
export type ConfirmClass =
  | (typeof BUILT_IN_CLASSES)[number]
  | (typeof OPT_IN_CLASSES)[number];

const CLASS_WORDS: Record<ConfirmClass, string> = {
  database: "deleting database data",
  "delete-files": "deleting folders outside the project",
  "force-push": "force-pushing a protected branch",
  "discard-work": "throwing away uncommitted work",
  "delete-storage": "deleting storage, volumes or buckets",
  "infra-destroy": "tearing down infrastructure",
  deploy: "deploying to production",
  money: "moving money",
  publish: "publishing a package or release",
  migrate: "running database migrations",
  install: "installing packages",
  push: "pushing to git",
  "deploy-any": "any deploy",
  "network-write": "sending data to the internet",
};

const MAX_ITEMS = 32;
const MAX_ITEM_LEN = 200;

const MAX_EXCEPT_FILES = 400;

/** Strings only, trimmed, de-duplicated, capped. */
function strings(v: unknown, max = MAX_ITEMS): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (!s || s.length > MAX_ITEM_LEN || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** A glob that would protect everything protects nothing useful and blocks
 *  every edit — the brain's most likely over-reach. */
function sensibleGlob(g: string): boolean {
  const s = g.replace(/^\.\//, "").replace(/^\//, "");
  if (!s || /^\*\*?\/?$/.test(s) || s === "**/*" || s === ".") return false;
  if (s.includes("..")) return false;
  return true;
}

/** Rust's `regex` crate is linear-time and so has no backreferences or
 *  lookaround; JavaScript's has both. A pattern must compile in both, or the
 *  rule the person approved would be silently skipped by the hook. */
export function portableRegex(p: string): boolean {
  if (/\(\?[=!<]/.test(p) || /\\[1-9]/.test(p) || /\\k</.test(p)) return false;
  try {
    new RegExp(p, "i");
    return true;
  } catch {
    return false;
  }
}

const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$|^localhost$/;
const PACKAGE = /^(@[a-z0-9._-]+\/)?[a-z0-9._/-]+$/i;

/** Accept a gate only if it is exactly one of the DSL's shapes with usable
 *  contents. Returns the cleaned gate or null — never a "best guess". */
export function normalizeGate(raw: unknown): Gate | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  switch (g.type) {
    case "deny-path-write": {
      const globs = strings(g.globs)?.filter(sensibleGlob);
      if (!globs || !globs.length) return null;
      // Exact repo-relative files a layer owner approved (src/lensGates.ts).
      // A longer list than other fields allow: an approval can name many.
      const exceptFiles = (strings(g.exceptFiles, MAX_EXCEPT_FILES) ?? []).filter(
        (f) => sensibleGlob(f) && !/[*?[\]{}]/.test(f),
      );
      return { type: "deny-path-write", globs, ...(exceptFiles.length ? { exceptFiles } : {}) };
    }
    case "protect-tests": {
      // Empty globs are meaningful here: "the usual test places".
      const globs = (strings(g.globs) ?? []).filter(sensibleGlob);
      return { type: "protect-tests", globs };
    }
    case "deny-command": {
      const patterns = strings(g.patterns)?.filter(portableRegex);
      return patterns && patterns.length ? { type: "deny-command", patterns } : null;
    }
    case "require-confirm": {
      const cls =
        typeof g.match === "string" &&
        ([...BUILT_IN_CLASSES, ...OPT_IN_CLASSES] as string[]).includes(g.match)
          ? (g.match as ConfirmClass)
          : undefined;
      const patterns = (strings(g.patterns) ?? []).filter(portableRegex);
      if (!cls && patterns.length === 0) return null;
      return {
        type: "require-confirm",
        ...(cls ? { match: cls } : {}),
        ...(patterns.length ? { patterns } : {}),
      };
    }
    case "package-allowlist":
    case "package-denylist": {
      const names = strings(g.names)?.filter((n) => PACKAGE.test(n));
      return names && names.length ? { type: g.type, names } : null;
    }
    case "egress-allowlist": {
      const hosts = strings(g.hosts)
        ?.map((h) => h.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter((h) => HOST.test(h));
      return hosts && hosts.length ? { type: "egress-allowlist", hosts } : null;
    }
    case "unenforceable": {
      const reason = typeof g.reason === "string" ? g.reason.trim().slice(0, 400) : "";
      return { type: "unenforceable", reason: reason || "This rule needs judgment, so it can't be checked automatically." };
    }
    default:
      return null;
  }
}

export const isEnforceable = (g: Gate | null | undefined): boolean =>
  !!g && g.type !== "unenforceable";

const list = (xs: string[], max = 4) =>
  xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;

/** The gate, said back in words a non-engineer can approve. This sentence is
 *  what the person signs off on, so it says what will be STOPPED, not what the
 *  JSON contains. */
export function plainLanguage(g: Gate): string {
  switch (g.type) {
    case "deny-path-write":
      return `Agents can't create, change or delete files matching ${list(g.globs)}${
        g.exceptFiles?.length ? `, except ${list(g.exceptFiles, 3)} (approved)` : ""
      }.`;
    case "protect-tests":
      return g.globs.length
        ? `Agents can't change or delete test files (${list(g.globs)}).`
        : "Agents can't change or delete test files (*.test.*, *.spec.*, tests/, __tests__/ and similar).";
    case "deny-command":
      return `Agents can't run commands matching ${list(g.patterns.map((p) => `“${p}”`), 3)}.`;
    case "require-confirm": {
      const parts: string[] = [];
      if (g.match) parts.push(CLASS_WORDS[g.match]);
      if (g.patterns?.length) parts.push(`commands matching ${list(g.patterns.map((p) => `“${p}”`), 3)}`);
      return `A person must approve ${parts.join(" or ")} before an agent does it.`;
    }
    case "package-allowlist":
      return `Agents can only install these packages: ${list(g.names, 6)}.`;
    case "package-denylist":
      return `Agents can't install ${list(g.names, 6)}.`;
    case "egress-allowlist":
      return `Agents' download and web commands may only reach ${list(g.hosts, 6)} (best effort: catches curl, wget and web fetches, not every program).`;
    case "unenforceable":
      return `Suggestion only — ${g.reason}`;
  }
}

/** One line per type for the compile prompt. The brain picks from these and
 *  nothing else. */
const DSL_SPEC = `Allowed gate types (pick exactly one; any other "type" is rejected):
- {"type":"deny-path-write","globs":[...]} — no edits/creates/deletes of matching paths. Globs are relative to the repository root. A bare name like "migrations" means that folder anywhere; "src/db/" means that folder's contents; "*.sql" matches the file name at any depth. Never "**" or "*".
- {"type":"deny-command","patterns":[...]} — shell commands matching any pattern are refused. Patterns are case-insensitive regular expressions WITHOUT lookahead, lookbehind or backreferences, matched against each simple command (e.g. "^npm\\s+publish\\b").
- {"type":"require-confirm","match":"<class>","patterns":[...]} — a person must approve first. "match" is one of: ${[...OPT_IN_CLASSES, ...BUILT_IN_CLASSES].join(", ")}. "patterns" (optional) are regexes as above.
- {"type":"protect-tests","globs":[...]} — test files may not be changed or deleted. Leave globs empty for the usual test locations.
- {"type":"package-allowlist","names":[...]} / {"type":"package-denylist","names":[...]} — package installs (npm, pnpm, yarn, pip, uv, cargo, go, gem…) may only add / may never add these names.
- {"type":"egress-allowlist","hosts":[...]} — curl/wget/web fetches may only reach these hosts ("*.example.com" allowed). Best effort.
- {"type":"unenforceable","reason":"..."} — use this when the rule needs judgment (style, quality, "be careful", "write good tests", naming) and no mechanical check could enforce it. Be honest: a wrong gate is worse than a suggestion.`;

export function compilePrompt(rule: string, context: { files?: string[] } = {}): string {
  const files = context.files?.length
    ? `\n\nSome of the repository's top-level paths, to help you pick globs:\n${context.files.slice(0, 80).join("\n")}`
    : "";
  return `Translate one plain-language rule a team wrote for its coding agents into one machine-checkable gate.

${DSL_SPEC}

Rule: """${rule.trim()}"""${files}

You may read files in the working directory to find where things live (e.g. the migrations folder's real path).
Reply with JSON: {"gate": <one gate object>, "explanation": "<one short sentence, in plain words, of what will be blocked>"}`;
}

export interface CompiledRule {
  gate: Gate;
  explanation: string;
}

/** Validate the brain's compile reply. Unknown or malformed gates are
 *  rejected outright (→ askBrain's `invalid-output`), so the editor can say
 *  "couldn't compile" rather than show a gate it would then have to drop. */
export function validateCompiled(v: unknown): CompiledRule | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const gate = normalizeGate(o.gate);
  if (!gate) return null;
  const explanation =
    typeof o.explanation === "string" && o.explanation.trim()
      ? o.explanation.trim().slice(0, 300)
      : plainLanguage(gate);
  return { gate, explanation };
}

// -------------------------------------------- shrinking instruction files

export interface RuleSuggestion {
  /** The instruction-file line it came from, verbatim. */
  line: string;
  /** The rule, rewritten as a short plain-language sentence. */
  rule: string;
  why: string;
  gate: Gate;
}

export function suggestPrompt(fileLabel: string, text: string): string {
  return `Below is an agent instruction file (${fileLabel}). Long instruction files are followed unreliably; rules that matter should be enforced by the workspace instead.

Find the lines that state a hard constraint a machine could check before a tool runs — forbidden paths, forbidden commands, protected tests, allowed/banned packages, allowed network hosts, actions that need a person's approval. Skip style advice, explanations and anything needing judgment.

${DSL_SPEC}

Reply with JSON: {"suggestions":[{"line":"<the exact line from the file, copied verbatim>","rule":"<the rule as one short sentence>","why":"<why enforcing it beats asking>","gate":<one gate object>}]}. At most 8 suggestions; an empty list is a fine answer.

File:
"""
${text.slice(0, 40_000)}
"""`;
}

export function validateSuggestions(v: unknown, source: string): RuleSuggestion[] | null {
  if (!v || typeof v !== "object") return null;
  const raw = (v as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(raw)) return null;
  const out: RuleSuggestion[] = [];
  for (const s of raw.slice(0, 8)) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const gate = normalizeGate(o.gate);
    const line = typeof o.line === "string" ? o.line.trim() : "";
    const rule = typeof o.rule === "string" ? o.rule.trim() : "";
    // A suggestion whose quoted line isn't in the file is one the person
    // can't verify — and "remove it from the file" would remove nothing.
    if (!gate || gate.type === "unenforceable" || !rule || !line || !source.includes(line)) continue;
    out.push({ line, rule: rule.slice(0, 300), why: typeof o.why === "string" ? o.why.trim().slice(0, 300) : "", gate });
  }
  return out;
}

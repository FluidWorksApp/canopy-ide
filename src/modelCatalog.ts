// Where the tray's model lists come from.
//
// Three CLIs can enumerate their own models and are always right about it:
// `opencode models`, `agy models`, `omp models --json`. The ones people
// actually use cannot. `claude`, `codex` and `gemini` ship no listing command
// at all — checked against `--help` and the subcommand tables of the installed
// builds — so a menu for them is either hardcoded (and stale by the next
// release, which is exactly how the old CLAUDE_MODELS went wrong) or borrowed.
//
// Borrowed means: another CLI on the machine carries a catalogue of the same
// vendor's models, and we read that instead of inventing one. Two qualify, and
// the difference between them decides the order they are tried in:
//
//   omp    `omp models --json` — a catalogue omp maintains and refreshes, with
//          context window and thinking levels per entry. Fast (~0.8s). Lists
//          only providers the user holds a key for, so it answers for some
//          families and not others on any given machine.
//   aider  `aider --list-models <substr>` — LiteLLM's static registry, so it
//          answers for every vendor regardless of credentials. Costs a PTY
//          (it aborts on a non-tty stdin) and several seconds, and returns
//          hundreds of rows, so it is the fallback rather than the default.
//
// Neither is installed on most machines, which is what SEEDS are for: a curated
// entry per live tier, checked in. A borrowed list only ever refines that.
//
// What a borrowed list is NOT is an entitlement. It says the vendor publishes
// the model, not that this user's account can reach it, and no donor can know
// the difference. That is the standing argument for `picker` on any CLI whose
// own chooser is good, and the reason CATALOGUE_ONLY says so out loud.

import type { ModelChoice } from "./agentModels";

/** The vendors a borrowed list can be about. */
export type ModelFamily = "anthropic" | "openai" | "google";

/**
 * A curated entry per live tier, and the answer whenever no donor CLI is
 * installed — which is the common case. Ordered as the menu shows them.
 *
 * Anthropic ids are aliases wherever one exists, never pinned model names: the
 * alias is what `claude` repoints at each release, so `opus` keeps meaning the
 * current Opus while `claude-opus-5` freezes. `claude --help` names `fable`,
 * `opus` and `sonnet` as aliases; `default` and `haiku` are the picker's own
 * entries. Verified against `claude --help` on 2.1.220 and the model catalogue
 * of the same build.
 *
 * The other two families are catalogue-only (see CATALOGUE_ONLY) and carry
 * pinned ids because neither CLI publishes aliases to use instead.
 */
export const SEEDS: Record<ModelFamily, ModelChoice[]> = {
  anthropic: [
    { id: "default", label: "Default", hint: "Opus 5 · 1M context" },
    { id: "opus", label: "Opus", hint: "1M context · complex work" },
    { id: "fable", label: "Fable", hint: "most capable, longest tasks" },
    { id: "sonnet", label: "Sonnet", hint: "efficient for routine work" },
    { id: "haiku", label: "Haiku", hint: "fastest" },
  ],
  // Verified against openai.com/index/gpt-5-6 on 2026-08-06: the 5.6 family is
  // sol/terra/luna, bare `gpt-5.6` aliases to sol, and 5.4 + 5.4-mini retire
  // from Codex on 2026-08-31 — which is why the older rows are gone.
  openai: [
    { id: "gpt-5.6", label: "GPT-5.6 Sol", hint: "most capable" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "balanced" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "fastest, cheapest" },
    { id: "gpt-5.5", label: "GPT-5.5", hint: "previous" },
  ],
  google: [
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", hint: "most capable" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", hint: "latest flash" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "previous flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", hint: "cheapest" },
  ],
};

/**
 * Families whose list Canopy can borrow but must not type into a terminal, and
 * why — kept as data so the reason travels with the entry instead of living in
 * a comment somewhere else.
 *
 * A borrowed list is a vendor catalogue, so it names models the user's account
 * may not be entitled to. That is tolerable for `claude`, whose `/model <alias>`
 * answers immediately and visibly in the terminal when an alias is not
 * available. It is not tolerable where the CLI has no inline form at all: there
 * the list would have nowhere to go but a launch flag, silently failing much
 * later. Both entries here are the second case.
 */
export const CATALOGUE_ONLY: Partial<Record<ModelFamily, string>> = {
  // Verified against codex-rs/tui/src/slash_command.rs: Model is absent from
  // supports_inline_args(), so there is no `/model <id>` to type a borrowed id
  // into. `-m/--model` exists, but that is launch-time, not a running session.
  openai: "codex takes a model only at launch (-m); /model opens its picker",
  // `/model manage` opens the dialog. A `/model set <name>` form was verified
  // once against packages/cli/src/ui/commands/modelCommand.ts, but could not be
  // re-verified in the installed 0.37.1 bundle — so it stays unused, per the
  // rule that unverified syntax is simply absent.
  google: "gemini's /model set could not be re-verified on the installed build",
};

/** A donor: another CLI whose catalogue we read. Tried in array order. */
export interface Donor {
  /** Agent id, so the caller knows which binary to look for on PATH. */
  agent: string;
  /** Families this donor can answer for at all. */
  families: readonly ModelFamily[];
  /** Turns the donor's stdout into bare model ids. */
  parse: (stdout: string, family: ModelFamily) => string[];
}

/** `omp models --json` → {"models":[{"provider":"anthropic","id":"…"},…]}. */
export const parseOmp = (stdout: string, family: ModelFamily): string[] => {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return [];
  }
  const models = (doc as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (m): m is { provider: string; id: string } =>
        typeof m?.provider === "string" &&
        typeof m?.id === "string" &&
        m.provider === family,
    )
    .map((m) => m.id);
};

/**
 * `aider --list-models <substr>` → a "- name" per line, where the name may
 * carry a provider route (`vertex_ai/`, `openrouter/openai/`, `gemini/`). The
 * route is LiteLLM's, not the target CLI's, so it is stripped — and any row
 * naming a cloud reseller is dropped rather than stripped, since those are
 * genuinely different endpoints with different ids.
 */
export const parseAider = (stdout: string): string[] => {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*-\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[1];
    if (/^(vertex_ai|bedrock|azure|eu|us|openrouter)\//.test(raw)) continue;
    out.push(raw.replace(/^(gemini|anthropic|openai)\//, ""));
  }
  return out;
};

export const DONORS: readonly Donor[] = [
  { agent: "omp", families: ["anthropic", "openai", "google"], parse: parseOmp },
  {
    agent: "aider",
    families: ["anthropic", "openai", "google"],
    parse: (stdout) => parseAider(stdout),
  },
];

/**
 * Which of a donor's allowlisted commands answers for a family, as an index
 * into MODEL_DONORS in agents.rs. An index rather than an argv on purpose: the
 * command line lives in Rust and never crosses the IPC boundary, so a compromised
 * or merely buggy frontend cannot turn this into arbitrary execution.
 *
 * The cost is that the two tables have to agree, which is what the "every donor
 * and family pair has a query" test is for.
 */
export const donorQuery = (agent: string, family: ModelFamily): number | null => {
  // omp filters by provider inside one JSON dump, so a single command serves
  // every family.
  if (agent === "omp") return 0;
  // aider's registry is hundreds of rows, so each family gets its own filtered
  // query. Order matches the argv table in agents.rs.
  if (agent === "aider") return { anthropic: 0, openai: 1, google: 2 }[family];
  return null;
};

/**
 * Ask each donor in turn for a family's catalogue and curate the first useful
 * answer, falling back to the seed. `run` is injected so this stays testable
 * without a Tauri host, and so the IPC import doesn't reach into a pure module.
 *
 * Donors are tried in DONORS order, which is fastest-and-cleanest first: the
 * loop stops at the first one that yields a non-empty curated list, so a
 * machine with omp never pays for aider's several seconds and a pty.
 */
export const refreshChoices = async (
  family: ModelFamily,
  run: (donor: string, query: number) => Promise<string | null>,
): Promise<ModelChoice[]> => {
  for (const d of DONORS) {
    if (!d.families.includes(family)) continue;
    const query = donorQuery(d.agent, family);
    if (query == null) continue;
    let stdout: string | null = null;
    try {
      stdout = await run(d.agent, query);
    } catch {
      // A donor that throws is a donor that didn't answer, same as one that
      // isn't installed. Never let it propagate — the menu still has a seed.
      continue;
    }
    if (!stdout) continue;
    const curated = curate(family, d.parse(stdout, family));
    if (curated.length > 0) return curated;
  }
  return SEEDS[family];
};

/** A dated snapshot (`-20251101`, `-2025-08-07`) of a model that also has an
 *  undated id. Pinning one is how a menu goes stale, so they never make it in. */
const DATED = /-\d{4}-?\d{2}-?\d{2}$/;

interface Tier {
  /** Matches ids belonging to this tier. */
  test: RegExp;
  label: string;
  hint: string;
  /** Emitted instead of the matched id — an alias that outlives the release. */
  alias?: string;
}

/**
 * One entry per tier, most capable first. Curation picks the highest version
 * within each tier and drops the rest, which is what turns a 26-row vendor
 * catalogue into a menu.
 */
const TIERS: Record<ModelFamily, Tier[]> = {
  anthropic: [
    { test: /^claude-fable-/, label: "Fable", hint: "most capable, longest tasks", alias: "fable" },
    { test: /^claude-opus-/, label: "Opus", hint: "1M context · complex work", alias: "opus" },
    { test: /^claude-sonnet-/, label: "Sonnet", hint: "efficient for routine work", alias: "sonnet" },
    { test: /^claude-haiku-/, label: "Haiku", hint: "fastest", alias: "haiku" },
    // Deliberately no mythos tier: claude-mythos-5 is Project Glasswing only,
    // so offering it to everyone produces a menu entry most accounts cannot use.
  ],
  openai: [
    { test: /^gpt-[\d.]+-sol$/, label: "GPT Sol", hint: "most capable" },
    { test: /^gpt-[\d.]+-codex(-max)?$/, label: "Codex", hint: "coding-tuned" },
    { test: /^gpt-[\d.]+-terra$/, label: "GPT Terra", hint: "balanced" },
    { test: /^gpt-[\d.]+$/, label: "GPT", hint: "latest" },
    { test: /^gpt-[\d.]+-luna$/, label: "GPT Luna", hint: "fast, cheaper" },
    { test: /^gpt-[\d.]+-mini$/, label: "GPT mini", hint: "fast, cheaper" },
    { test: /^gpt-[\d.]+-nano$/, label: "GPT nano", hint: "cheapest" },
  ],
  google: [
    { test: /^gemini-[\d.]+-pro(-preview)?$/, label: "Gemini Pro", hint: "most capable" },
    { test: /^gemini-[\d.]+-flash$/, label: "Gemini Flash", hint: "balanced" },
    { test: /^gemini-[\d.]+-flash-lite(-preview)?$/, label: "Gemini Flash Lite", hint: "cheapest" },
  ],
};

/** The version embedded in an id, as a sortable number: `claude-opus-4-8` → 4.8,
 *  `gpt-5.5` → 5.5, `gemini-3.6-flash` → 3.6. Absent version sorts last. */
export const versionOf = (id: string): number => {
  const dotted = /(\d+)\.(\d+)/.exec(id);
  if (dotted) return Number(`${dotted[1]}.${dotted[2]}`);
  const dashed = /-(\d+)-(\d+)(?:$|-)/.exec(id);
  if (dashed) return Number(`${dashed[1]}.${dashed[2]}`);
  const single = /-(\d+)(?:$|-)/.exec(id);
  return single ? Number(single[1]) : -1;
};

/**
 * A vendor catalogue down to one menu entry per tier — the newest of each, by
 * version, with dated snapshots and chat/search/live variants discarded.
 *
 * Returns [] when nothing matched, which the caller reads as "this donor had
 * nothing useful" and falls through to the next one, then to the seed. That
 * matters more than it looks: a donor that answers with an empty or unparseable
 * list must never blank the menu, only decline to improve it.
 */
export const curate = (family: ModelFamily, ids: string[]): ModelChoice[] => {
  const best = new Map<number, string>();
  for (const id of ids) {
    if (DATED.test(id)) continue;
    if (/-(chat|search|live|tts)(-|$)|-latest$|-customtools$/.test(id)) continue;
    const tier = TIERS[family].findIndex((t) => t.test.test(id));
    if (tier < 0) continue;
    const held = best.get(tier);
    if (held == null || versionOf(id) > versionOf(held)) best.set(tier, id);
  }
  const out: ModelChoice[] = [];
  TIERS[family].forEach((tier, i) => {
    const id = best.get(i);
    if (id == null) return;
    // The label carries the concrete version so the menu says what it found —
    // "Opus 5", not a bare "Opus" that could mean any release.
    const v = versionOf(id);
    const label = v > 0 ? `${tier.label} ${v}` : tier.label;
    out.push({ id: tier.alias ?? id, label, hint: tier.hint });
  });
  return out;
};

/**
 * The menu for a family: a donor's curated catalogue when one answered,
 * otherwise the checked-in seed. `stdout` is whatever the first donor that was
 * both installed and willing to answer produced.
 */
export const choicesFor = (
  family: ModelFamily,
  donor?: { agent: string; stdout: string },
): ModelChoice[] => {
  if (!donor) return SEEDS[family];
  const spec = DONORS.find((d) => d.agent === donor.agent);
  if (!spec || !spec.families.includes(family)) return SEEDS[family];
  const curated = curate(family, spec.parse(donor.stdout, family));
  return curated.length > 0 ? curated : SEEDS[family];
};

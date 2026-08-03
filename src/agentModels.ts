// How each agent CLI changes the model of a session that is already running.
//
// Same rule as the `resume` and `prompt` entries in projects.ts, and for the
// same reason: only syntax verified against the CLI itself is written down. A
// wrong slash command does not error — it lands as a stray line in the
// composer, or opens something other than what the menu promised, while the
// tray claims the model was switched. Every entry below names how it was
// checked. A CLI we could not verify is simply absent, and its tab shows no
// model control at all.

import { SEEDS } from "./modelCatalog";

/** One entry in the tray's model menu: what to type, and how to name it. */
export interface ModelChoice {
  id: string;
  label: string;
  hint: string;
}

/**
 * `inline` — the CLI takes the model name on the command line, so Canopy can
 * offer the list itself and switch in one click.
 *
 * `picker` — the command opens the CLI's own chooser in the terminal, and the
 * user picks there. Canopy must not name models for these: their catalogues
 * are per-account (which providers you have keys for, which models your org
 * enabled), so the only list that is right is the one the CLI itself draws.
 */
export type ModelSwitch =
  | { kind: "inline"; command: string; choices: ModelChoice[] }
  | { kind: "picker"; command: string };

/** What `/model` in Claude Code accepts. Aliases resolve to the CLI's own
 *  latest models — but the *set* of aliases is not itself stable, which is how
 *  the list this replaced went wrong: it was written when `opusplan` and
 *  `sonnet[1m]` were in the picker and `fable` did not exist, and stayed that
 *  way through the releases that changed all three. So the entries live in
 *  modelCatalog.ts, where a donor CLI's catalogue can refresh them and the
 *  checked-in seed is only the starting point. */
const claudeModels = (): ModelChoice[] => SEEDS.anthropic;

/** Aider's own aliases (MODEL_ALIASES in aider/models.py), not model ids: the
 *  alias is what survives a release, since aider repoints it at each vendor's
 *  current model. A handful of the useful ones — `/model` takes any LiteLLM
 *  name, and no fixed list could cover that. */
const AIDER_MODELS: ModelChoice[] = [
  { id: "sonnet", label: "Sonnet", hint: "Anthropic" },
  { id: "opus", label: "Opus", hint: "Anthropic" },
  { id: "haiku", label: "Haiku", hint: "Anthropic" },
  { id: "4o", label: "GPT-4o", hint: "OpenAI" },
  { id: "gemini", label: "Gemini Pro", hint: "Google" },
  { id: "flash", label: "Gemini Flash", hint: "Google, fast" },
  { id: "deepseek", label: "DeepSeek", hint: "DeepSeek" },
  { id: "r1", label: "DeepSeek R1", hint: "reasoning" },
];

/**
 * Keyed by agent id — the same ids identifyAgent() reports, which includes the
 * bare binaries in EXTRA_AGENT_BINS (gemini) as well as registry entries.
 */
export const MODEL_SWITCH: Record<string, ModelSwitch> = {
  // Verified: `/model <alias>` is documented by `claude --help`'s slash command
  // list and applies to the running session.
  claude: { kind: "inline", command: "/model", choices: claudeModels() },
  // Verified against aider/models.py on disk: cmd_model() takes the name as its
  // argument and swaps the main model in place.
  aider: { kind: "inline", command: "/model", choices: AIDER_MODELS },
  // Verified against codex-rs/tui/src/slash_command.rs: Model is absent from
  // supports_inline_args(), so `/model gpt-5` is not a thing — the command
  // opens the "Select Model and Effort" picker and nothing else. Codex's
  // catalogue *is* borrowable (see SEEDS.openai), but a borrowed id would have
  // nowhere to be typed: `-m/--model` is launch-time only. CATALOGUE_ONLY.
  codex: { kind: "picker", command: "/model" },
  // Verified in the shipped TUI bundle: the command is plural, and its hint
  // reads "Use /models to switch between available AI models".
  opencode: { kind: "picker", command: "/models" },
  // Verified against packages/cli/src/ui/commands/modelCommand.ts at the
  // installed tag: `/model manage` opens the model dialog. There is also
  // `/model set <name>`, deliberately unused — Gemini's available model ids
  // vary by account tier, so the dialog is the only list that can be right.
  // That `set` form could not be re-verified in the installed 0.37.1 bundle,
  // which keeps it unused for a second reason now. CATALOGUE_ONLY.
  gemini: { kind: "picker", command: "/model manage" },
  // Verified in the shipped binary: it prompts "Please use the /model command
  // to select a valid model", and the TUI logs "Exited /model command".
  agy: { kind: "picker", command: "/model" },
  // Verified against omp 17.x's extension/lifecycle docs and interactive
  // command: `/model` opens the active account's model selector.
  omp: { kind: "picker", command: "/model" },
  // Deliberately absent — nothing here could be verified:
  //   amp: its only "/model" string is a `provider/model` format error.
};

/** The switch for an agent, or null when Canopy has no verified way to change
 *  that CLI's model — which is also the answer for an unidentified terminal. */
export const modelSwitchFor = (agent?: string | null): ModelSwitch | null =>
  (agent && MODEL_SWITCH[agent]) || null;

/** The line to type into the terminal. `model` is the id of a choice for an
 *  inline switch, and is ignored by a picker, which takes no argument. */
export const modelCommandLine = (sw: ModelSwitch, model?: string): string =>
  sw.kind === "inline" && model ? `${sw.command} ${model}` : sw.command;

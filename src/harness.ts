// What each agent CLI — each "harness" — can natively do, as far as Canopy has
// actually checked.
//
// The brain (brain.ts) is whichever CLI the person connected; this is the
// ledger of what that brain brings with it. Features like rewind, plan mode or
// an IDE protocol will be surfaced from the harness when it has them and fall
// back to a Canopy-native version when it does not — and that decision is only
// as good as the claim it is made on. So every entry here is evidence, not
// memory: a field is "native" or "partial" only when a dated stamp elsewhere in
// the repo (a structured runner's verification, a registry line marked
// Verified, docs/agent-parity.md) says so, and it names that stamp in `source`.
// Anything not yet checked is "unknown", which is a different statement from
// "none": it means the IDE must not promise the feature, not that the CLI
// lacks it.
//
// Nothing reads this yet. It exists now so the research that fills it in has a
// typed place to land, and so the first surface built on it cannot quietly
// assume Claude's shape for every CLI.

/** How far a harness supports one feature.
 *
 *  `native`  — the CLI does it itself, verified.
 *  `partial` — some of it is verified; `note` says which part.
 *  `none`    — verified absent; Canopy must supply the fallback.
 *  `unknown` — not checked. Treated like `none` for promises, but kept distinct
 *              so a fallback is never mistaken for a finding. */
export type HarnessSupport = "native" | "partial" | "none" | "unknown";

/** The features the IDE intends to surface from a harness. One key per thing a
 *  surface would have to decide about, so a single verdict can drive it. */
export type HarnessFeature =
  /** A non-interactive run whose events are read back off a JSON stream —
   *  what Build, repair and every other headless task run on. */
  | "headlessStructuredRun"
  /** Restoring the workspace and conversation to an earlier turn. */
  | "checkpointsRewind"
  /** A live editor protocol (open file, selection, diagnostics) between the
   *  CLI and an IDE. */
  | "ideProtocol"
  /** A read-only planning mode that waits for approval before acting. */
  | "planMode"
  /** Reopening a conversation by id, and branching one into a new session. */
  | "sessionsResumeFork"
  /** Lifecycle hooks Canopy can attach to (session start, tool use, stop). */
  | "hooks"
  /** Delegating work to child agents inside one session. */
  | "subagents"
  /** Summarising a long conversation to keep working inside the window. */
  | "compaction"
  /** Token, cost and model figures Canopy can read for the status tray. */
  | "usageReporting"
  /** An in-place self-updater, as opposed to reinstalling the package. */
  | "selfUpdate";

export interface HarnessCapability {
  support: HarnessSupport;
  /** What exactly was or wasn't verified, when the verdict alone would
   *  overstate it. */
  note?: string;
  /** Where the evidence lives: a repo path plus the stamp it carries. Required
   *  in spirit for anything but `unknown`. */
  source?: string;
}

export type HarnessCapabilities = Record<HarnessFeature, HarnessCapability>;

/** Every feature, in a stable order — for iteration and for tests that check
 *  an entry is complete. */
export const HARNESS_FEATURES: readonly HarnessFeature[] = [
  "headlessStructuredRun",
  "checkpointsRewind",
  "ideProtocol",
  "planMode",
  "sessionsResumeFork",
  "hooks",
  "subagents",
  "compaction",
  "usageReporting",
  "selfUpdate",
];

const UNKNOWN: HarnessCapability = { support: "unknown" };

/** A record that claims nothing. What every unresearched CLI gets, including
 *  user-added ones, which by definition nobody here has checked. */
function allUnknown(): HarnessCapabilities {
  return Object.fromEntries(
    HARNESS_FEATURES.map((feature) => [feature, UNKNOWN]),
  ) as HarnessCapabilities;
}

const CLAUDE_RUNNER_STAMP =
  "src/structuredRunners.ts CLAUDE_RUNNER.verification (Claude Code 2.1.226, `claude --help`, 2026-08-09)";

/** Claude Code, filled only from what the repo has already stamped. Rewind,
 *  the IDE protocol, subagents and compaction are left unknown on purpose:
 *  they may well exist, but no file here records them being checked, and a
 *  surface that trusted a remembered flag would fail in front of the person. */
const CLAUDE_CODE: HarnessCapabilities = {
  ...allUnknown(),
  headlessStructuredRun: {
    support: "native",
    note: "stream-json in and out over a long-lived process (structured tier). No OS-backed workspace boundary: tool flags gate which tools run, not which paths they touch.",
    source: CLAUDE_RUNNER_STAMP,
  },
  planMode: {
    support: "native",
    note: "`--permission-mode plan`.",
    source: `${CLAUDE_RUNNER_STAMP}; flags.planMode`,
  },
  sessionsResumeFork: {
    support: "partial",
    note: "Resume by session id (`--resume`) is verified; forking a session is not.",
    source: "src/projects.ts claude registry entry `resume` (Verified against 2.1.226 --help, 2026-08-09)",
  },
  hooks: {
    support: "native",
    note: "Canopy installs and consumes the full hook set.",
    source: "docs/agent-parity.md, Hook auto-setup: full",
  },
  usageReporting: {
    support: "native",
    note: "Tokens, cost and model from the session transcript.",
    source: "docs/agent-parity.md, Token/cost/model tray: yes",
  },
  selfUpdate: {
    support: "native",
    note: "`claude update`, for both npm and native installs.",
    source: "src/projects.ts claude registry entry `update` (Verified)",
  },
};

/** The ledger, keyed by agent registry id. Only Claude Code has an entry: the
 *  other CLIs are being researched, and Codex's runner stamps, for one, will
 *  move in here with that research rather than ahead of it. */
export const HARNESS_CAPABILITIES: Readonly<Record<string, HarnessCapabilities>> = {
  claude: CLAUDE_CODE,
};

/** What this CLI is known to support. Never undefined: an id with no entry
 *  gets a record of `unknown`s, so a caller cannot mistake absence of research
 *  for absence of the feature — or crash on it. */
export function harnessCapabilities(cliId: string): HarnessCapabilities {
  return HARNESS_CAPABILITIES[cliId] ?? allUnknown();
}

/** One feature's verdict for one CLI — the question a surface actually asks. */
export function harnessSupport(
  cliId: string,
  feature: HarnessFeature,
): HarnessSupport {
  return harnessCapabilities(cliId)[feature].support;
}

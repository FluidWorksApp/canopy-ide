// Stagehand under the Chromium engine — and, more importantly, what it uses for
// a brain.
//
// Stagehand's own value is act("click the login button"): natural language in,
// a real click out, with a cache so a repeated flow replays without asking a
// model anything. To do that it needs an LLM, and out of the box it wants an
// API key for one.
//
// Canopy already has an LLM. The user configured a CLI — claude, codex, amp —
// authenticated against their own subscription, and it is the thing driving
// every agent in the app. Making them paste an API key to get a second, worse
// model would be absurd. So Stagehand is pointed at a loopback OpenAI-shaped
// endpoint (stagehand.rs) that fronts that same CLI: Stagehand thinks it is
// talking to OpenAI, and the tokens come off the subscription already in use.
//
// That has a real cost and it is not money. Every act() that misses the cache
// spends the user's plan quota — the same quota their actual agents are
// competing for. Which is why the direct path (the agent calling
// canopy_browser_* itself) stays the default for interactive work, and
// Stagehand earns its place on flows that repeat, where the cache means the
// second run and every run after it cost nothing at all.

import type { BrowserEngine } from "./browserBounds";

/** The headless, one-shot form of a CLI: prompt in, completion out, no TUI.
 *
 *  Deliberately separate from AgentCli.prompt, which is the INTERACTIVE form.
 *  Getting these two confused is the exact failure that registry warns about —
 *  an interactive flag used headlessly starts a session that ignores the prompt
 *  and hangs, and a headless flag used interactively exits immediately. Only
 *  filled in where the syntax is verified; a CLI absent here simply cannot be
 *  Stagehand's model, and says so rather than being guessed at. */
export const ONE_SHOT_CLIS: Record<string, (bin: string) => string[]> = {
  // Verified: `claude -p <prompt>` prints one completion and exits.
  claude: (bin) => [bin, "-p"],
  // Verified: `codex exec <prompt>` is the headless one — the registry's
  // `prompt` deliberately avoids it, which is exactly why it belongs here.
  codex: (bin) => [bin, "exec"],
};

export interface StagehandAvailability {
  /** A Node runtime was found. Stagehand is a Node library; without one there
   *  is nothing to run it in, and Canopy ships no Node of its own. */
  node: boolean;
  /** The configured agent CLI can answer a one-shot prompt — i.e. it appears in
   *  ONE_SHOT_CLIS above. */
  cli: boolean;
}

export type StagehandState =
  | { active: true }
  | { active: false; reason: string };

/** Whether Stagehand drives this engine, and if not, why not.
 *
 *  Default-on, but only where it can actually work: on the Chromium engine,
 *  with a Node runtime, and with a CLI that can answer headlessly. Everywhere
 *  else the honest answer is a reason, not a silent no — "Stagehand is on" next
 *  to a feature that never fires is worse than it being visibly unavailable. */
export function stagehandState(
  engine: BrowserEngine,
  enabled: boolean,
  has: StagehandAvailability,
): StagehandState {
  if (engine !== "chromium") {
    return {
      active: false,
      reason: "Stagehand needs the Chrome engine — the others have no debugging protocol to drive.",
    };
  }
  if (!enabled) return { active: false, reason: "Turned off for this engine." };
  if (!has.node) {
    return {
      active: false,
      reason: "No Node runtime found. Stagehand is a Node library and Canopy doesn't bundle one.",
    };
  }
  if (!has.cli) {
    return {
      active: false,
      reason: "No configured CLI can answer a one-shot prompt, so there's no model to drive it.",
    };
  }
  return { active: true };
}

/** The argv that asks a CLI for a single completion, or null when that CLI has
 *  no verified headless form. The prompt is passed as one argument rather than
 *  interpolated into a shell string — it is model output going onto a command
 *  line, and quoting it by hand is how that becomes an injection. */
export function oneShotArgv(cliId: string, bin: string, prompt: string): string[] | null {
  const build = ONE_SHOT_CLIS[cliId];
  if (!build) return null;
  return [...build(bin), prompt];
}

// Which agent CLI is Canopy's brain.
//
// The person connects one CLI they are already signed into, and that CLI powers
// every piece of intelligence in the IDE: the companion, Build, repair, review,
// micro-tasks, research, launched tasks. That makes "which CLI?" one question
// with one answer, and this file is the only place allowed to give it.
//
// It used to be answered in nine places, each reading `defaultAgent` and each
// with its own idea of what to do when that CLI wasn't installed: one fell back
// to the registry's first entry, one to an empty string, one ignored
// installation entirely. A second copy of the question is exactly where a
// preference quietly stops being honoured, so every caller asks here instead.
//
// The setting keeps its storage name — `defaultAgent` — because it is durable
// state; the concept it holds is the brain.

import { AGENT_CLIS, agentCliFor, type AgentCli } from "./projects";
import { getSettings } from "./settings";

/** The brain the person chose, as a registry id — installed or not.
 *
 *  For callers that hand a *preference* to something which does its own
 *  availability check: route ranking seeds its order with this and then gates
 *  every candidate on fleet health, so resolving installation here first would
 *  only duplicate that check with less information. Canonicalised through the
 *  registry so a historical alias still names the CLI it always meant; the raw
 *  setting otherwise, so an id the registry doesn't know yet is passed through
 *  rather than silently swapped for another vendor. */
export function chosenBrainId(): string {
  const preferred = getSettings().defaultAgent;
  return agentCliFor(preferred)?.id ?? preferred;
}

/**
 * The CLI that powers Canopy's intelligence on this machine.
 *
 * The chosen brain if it is installed here, else the first CLI that is.
 * Falling through to the registry — the chosen brain again, then its first
 * entry — only when nothing at all is detected, so the answer never silently
 * endorses a vendor that isn't even present. Detection lags a fresh install,
 * and in that window naming the registry's first entry would put one vendor
 * in front of a setting that says otherwise.
 *
 * Undefined only while the registry itself is empty.
 *
 * Deliberately not ranked by verified runners or capabilities (harness.ts): a
 * verification stamp says which flags were checked, not which agent the person
 * wants to work with.
 */
export function resolveBrain(
  installed: (bin: string) => boolean,
): AgentCli | undefined {
  const here = AGENT_CLIS.filter((c) => installed(c.bin));
  const chosen = agentCliFor(getSettings().defaultAgent);
  return (
    here.find((c) => c === chosen) ??
    here[0] ??
    chosen ??
    AGENT_CLIS[0]
  );
}

/** The brain, but only if it is actually installed here — null otherwise.
 *
 *  For surfaces where naming an absent CLI would be a false claim (a menu's
 *  "default" badge, the companion), as opposed to launchers that would rather
 *  name the person's choice and let the install flow take over. */
export function installedBrain(
  installed: (bin: string) => boolean,
): AgentCli | null {
  const brain = resolveBrain(installed);
  return brain && installed(brain.bin) ? brain : null;
}

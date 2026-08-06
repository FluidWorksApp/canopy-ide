// Semantic capability tiers for routing work, kept apart from the model
// picker's curation on purpose (the plan's split): the picker asks "what
// should this family's menu show", routing asks "what class of model does
// this task deserve". Conflating them is how a menu tweak silently changes
// which model writes code.
//
// Same doctrine as the catalogue: a tier here is a proposal, never an
// entitlement — FleetState gates the route, the launch outcome disposes, and
// the attempt record keeps requested and observed models separately.

import type { ModelChoice } from "./agentModels";
import type { ModelFamily } from "./modelCatalog";

export type RoutingTier = "frontier" | "workhorse" | "fast";

/** The task classes the vibe program dispatches (0104 source 06 §17). */
export type TaskClass =
  | "build"
  | "survey"
  | "fix"
  | "verify"
  | "scan"
  | "classify"
  | "title";

/** The routing policy as data: the builder thinks on frontier, delegated jobs
 *  run on the workhorse, and pure classification runs fast. */
export const TIER_FOR_CLASS: Record<TaskClass, RoutingTier> = {
  build: "frontier",
  survey: "workhorse",
  fix: "workhorse",
  verify: "workhorse",
  scan: "workhorse",
  classify: "fast",
  title: "fast",
};

/** Which routing tier a model id (or picker alias) belongs to, per family.
 *  Ordered most-capable-first; the first match wins so `-mini`/`-lite`
 *  variants must be tested before their parents. */
const TIER_PATTERNS: Record<ModelFamily, [RoutingTier, RegExp][]> = {
  anthropic: [
    ["frontier", /^(fable|opus)$|^claude-(fable|opus)-/],
    ["fast", /^haiku$|^claude-haiku-/],
    ["workhorse", /^sonnet$|^claude-sonnet-/],
  ],
  openai: [
    ["fast", /-(mini|nano)$/],
    ["frontier", /^gpt-[\d.]+-codex(-max)?$/],
    ["workhorse", /^gpt-[\d.]+$/],
  ],
  google: [
    ["fast", /-flash-lite(-preview)?$/],
    ["frontier", /-pro(-preview)?$/],
    ["workhorse", /-flash$/],
  ],
};

export function routingTierOf(family: ModelFamily, id: string): RoutingTier | null {
  for (const [tier, test] of TIER_PATTERNS[family]) {
    if (test.test(id)) return tier;
  }
  return null;
}

/** When the asked-for tier has no model, the nearest sensible neighbour: a
 *  frontier task degrades downward (nothing higher exists); a fast task steps
 *  up (a bigger model does the small job, it just costs more). */
const FALLBACK: Record<RoutingTier, RoutingTier[]> = {
  frontier: ["frontier", "workhorse", "fast"],
  workhorse: ["workhorse", "fast", "frontier"],
  fast: ["fast", "workhorse", "frontier"],
};

export interface RoutedModel {
  choice: ModelChoice;
  /** The tier actually served. Callers surface a visible note whenever this
   *  differs from what was asked — degradation is allowed, silence about it
   *  is not. */
  tier: RoutingTier;
}

/** Pick a model for a tier from one family's available choices (the curated
 *  menu or the seed — whatever the caller trusts). Null means this family
 *  currently offers nothing recognizable, and the router should try another
 *  route rather than guess. */
export function routeModel(
  family: ModelFamily,
  want: RoutingTier,
  choices: ModelChoice[],
): RoutedModel | null {
  for (const tier of FALLBACK[want]) {
    const choice = choices.find((c) => routingTierOf(family, c.id) === tier);
    if (choice) return { choice, tier };
  }
  return null;
}

export function modelForClass(
  family: ModelFamily,
  task: TaskClass,
  choices: ModelChoice[],
): RoutedModel | null {
  return routeModel(family, TIER_FOR_CLASS[task], choices);
}

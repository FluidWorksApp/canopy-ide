// Route selection and failover as pure decisions, kept out of the session so
// the policy can be read and tested without a process, a store, or a clock.
//
// The doctrine this encodes, from the failover design (0104 source 10):
//   - A tier is a proposal. FleetState gates; an unusable route is never
//     offered no matter how well it ranks.
//   - Switching routes is a claim that the ROUTE is at fault. Only evidence
//     that says so — a classified route failure — earns a switch.
//   - The same signature failing on two routes is evidence about the task.
//     Stop switching; a third route will fail the same way.
//   - An unclassified failure is not licence to guess. One same-route retry,
//     then stop and say so.

import {
  classifyFailure,
  promoteAcrossRoutes,
  type AttemptOutcome,
  type FailureVerdict,
} from "./failureClassifier";
import { fleetGate, rankFleet, type FleetState } from "./fleetState";
import type { ModelChoice } from "./agentModels";
import type { ModelFamily } from "./modelCatalog";
import {
  modelForClass,
  TIER_FOR_CLASS,
  type RoutingTier,
  type TaskClass,
} from "./modelRouting";

/** One launchable route with everything needed to judge and rank it. */
export interface RouteCandidate {
  cli: string;
  profileId: string;
  family: ModelFamily;
  state: FleetState;
  /** What this family currently offers — the curated menu or the seed. */
  choices: ModelChoice[];
}

export interface SelectedRoute {
  cli: string;
  profileId: string;
  requestedModel: string | null;
  /** The tier actually served, which may be below what the class asked for. */
  tier: RoutingTier;
  /** Set when the served tier is not the requested one. Never silent. */
  degradedTier: boolean;
  /** Why this route is less than fully healthy, if it is. */
  caveat: string | null;
}

const routeKey = (r: { cli: string; profileId: string }) =>
  `${r.cli}:${r.profileId}`;
/** FleetState names the same pair `agent`/`profile`; keep the two spellings
 *  from silently producing different keys for one route. */
const stateKey = (s: FleetState) => `${s.agent}:${s.profile}`;

/** Every route that could actually run this class of work, best first.
 *  Unusable routes are dropped (not ranked last) — fleetGate is a gate, and a
 *  route with no recognizable model for any tier is not a route. */
export function rankRoutes(
  candidates: RouteCandidate[],
  task: TaskClass,
): SelectedRoute[] {
  const byKey = new Map(candidates.map((c) => [stateKey(c.state), c]));
  const allowed = candidates.filter((c) => fleetGate(c.state).allowed);
  return rankFleet(allowed.map((c) => c.state)).flatMap((state) => {
    const candidate = byKey.get(stateKey(state));
    if (!candidate) return [];
    const routed = modelForClass(candidate.family, task, candidate.choices);
    if (!routed) return [];
    return [
      {
        cli: candidate.cli,
        profileId: candidate.profileId,
        requestedModel: routed.choice.id,
        tier: routed.tier,
        degradedTier: routed.tier !== TIER_FOR_CLASS[task],
        caveat: fleetGate(state).why,
      },
    ];
  });
}

export function selectRoute(
  candidates: RouteCandidate[],
  task: TaskClass,
): SelectedRoute | null {
  return rankRoutes(candidates, task)[0] ?? null;
}

/** Which model family a coding CLI speaks. Only the three that route today —
 *  an agent absent here has no family we can name, and naming one anyway is
 *  how a route tuple starts lying. */
export const FAMILY_FOR_CLI: Readonly<Record<string, ModelFamily>> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
};

/** The route record the task store keeps. Deliberately mirrors
 *  TaskRouteSnapshot rather than importing it: this module decides routes and
 *  should not depend on the envelope's shape to do it. */
export interface ResolvedRoute {
  cli: string;
  cliVersion: string | null;
  executableFingerprint: string | null;
  profileId: string;
  requestedModel: string | null;
  observedModel: string | null;
  harnessVersion: string;
  promptVersion: string;
  toolPolicyVersion: string;
  executionMode: "structured";
  selection: { policy: string; eligible: string[]; degradedTier?: boolean; caveat?: string | null };
}

export interface RouteVersions {
  harnessVersion: string;
  promptVersion: string;
  toolPolicyVersion: string;
}

/** The honest record of a route Canopy actually chose.
 *
 *  `observedModel` stays null on purpose: no CLI reports back which model it
 *  really used, so the only truthful value is "not observed". Filling it with
 *  the requested id would turn a request into a false observation, which is
 *  the one thing the attempt record exists to keep apart.
 *
 *  `executableFingerprint` is null for the same reason — there is no native
 *  hash of the resolved binary yet. */
export function resolveRoute(
  chosen: SelectedRoute,
  eligible: readonly SelectedRoute[],
  versions: RouteVersions,
  cliVersion: string | null,
): ResolvedRoute {
  return {
    cli: chosen.cli,
    cliVersion,
    executableFingerprint: null,
    profileId: chosen.profileId,
    requestedModel: chosen.requestedModel,
    observedModel: null,
    ...versions,
    executionMode: "structured",
    selection: {
      policy: "vibe-fleet-ranked-1",
      eligible: eligible.map((r) => `${r.cli}:${r.profileId}`),
      degradedTier: chosen.degradedTier,
      caveat: chosen.caveat,
    },
  };
}

/** What the route is before any turn has launched. A server incident can be
 *  recorded before the first turn, and it must not claim a route that was
 *  never selected. */
export function unresolvedRoute(cli: string, versions: RouteVersions): ResolvedRoute {
  return {
    cli,
    cliVersion: null,
    executableFingerprint: null,
    profileId: "",
    requestedModel: null,
    observedModel: null,
    ...versions,
    executionMode: "structured",
    selection: { policy: "unresolved", eligible: [] },
  };
}

export type FailoverAction =
  | { kind: "retry-same"; reason: string; narration: string }
  | {
      kind: "switch-route";
      to: SelectedRoute;
      reason: string;
      narration: string;
    }
  | { kind: "stop"; reason: string; narration: string };

/** An attempt outcome as the session records it, re-exported so callers keep
 *  one vocabulary for route history. */
export type AttemptOutcomeRecord = AttemptOutcome;

export interface FailoverInput {
  /** The failure text from the attempt that just ended. */
  evidence: { agent?: string; text: string };
  /** Every prior settled attempt on this run, oldest first. */
  history: AttemptOutcome[];
  current: { cli: string; profileId: string };
  candidates: RouteCandidate[];
  task: TaskClass;
  /** Attempts already spent, including the one that just failed. */
  attemptsUsed: number;
  attemptCap: number;
}

/** Plain-language names, so Ash never says "route claude:default". */
const spoken = (cli: string) =>
  ({ claude: "Claude", codex: "Codex", gemini: "Gemini" })[cli] ?? cli;

export function failoverDecision(input: FailoverInput): {
  action: FailoverAction;
  verdict: FailureVerdict;
} {
  const verdict = classifyFailure(input.evidence);
  const mine: AttemptOutcome = { route: routeKey(input.current), verdict };
  const history = [...input.history, mine];

  // Anti-thrash first: if this signature has now failed on two routes, it is
  // the task, whatever the signature file says about the class.
  const promoted = promoteAcrossRoutes(history);
  if (promoted === "task") {
    return {
      verdict,
      action: {
        kind: "stop",
        reason: "signature-seen-on-two-routes",
        narration:
          "The same problem happened on a second model, so it isn't the model — I've stopped switching and left this for you to look at.",
      },
    };
  }

  if (input.attemptsUsed >= input.attemptCap) {
    return {
      verdict,
      action: {
        kind: "stop",
        reason: "attempt-cap-reached",
        narration: "I've used up the retries allowed for this turn.",
      },
    };
  }

  if (verdict.class === "task") {
    return {
      verdict,
      action: {
        kind: "stop",
        reason: verdict.signature ?? "task-failure",
        narration:
          "This one is about the work itself, not the model, so switching wouldn't help.",
      },
    };
  }

  if (verdict.class === "unknown") {
    // Not licence to guess about the route. One same-route retry covers a
    // flake; a second unknown means we genuinely do not understand it.
    const unknownBefore = input.history.some((h) => h.verdict.class === "unknown");
    if (unknownBefore) {
      return {
        verdict,
        action: {
          kind: "stop",
          reason: "unclassified-failure-repeated",
          narration:
            "Something failed twice that I can't identify, so I've stopped rather than guess.",
        },
      };
    }
    return {
      verdict,
      action: {
        kind: "retry-same",
        reason: "unclassified-failure",
        narration: "That failed for a reason I don't recognize — trying once more.",
      },
    };
  }

  if (verdict.class === "transient") {
    return {
      verdict,
      action: {
        kind: "retry-same",
        reason: verdict.signature ?? "transient",
        narration: `${spoken(input.current.cli)} had a temporary problem — retrying.`,
      },
    };
  }

  // Route-class: this model or account can't do the work right now. Move.
  const alternatives = rankRoutes(input.candidates, input.task).filter(
    (r) => routeKey(r) !== routeKey(input.current),
  );
  const to = alternatives[0];
  if (!to) {
    return {
      verdict,
      action: {
        kind: "stop",
        reason: "no-alternate-route",
        narration: `${spoken(input.current.cli)} can't continue and there's no other agent ready to take over.`,
      },
    };
  }
  const because =
    verdict.signature === "quota-exhausted"
      ? "ran out of quota"
      : verdict.signature === "rate-limited"
        ? "hit its rate limit"
        : verdict.signature === "auth-expired"
          ? "needs signing in again"
          : "couldn't continue";
  return {
    verdict,
    action: {
      kind: "switch-route",
      to,
      reason: verdict.signature ?? "route-failure",
      narration: `${spoken(input.current.cli)} ${because} — I've switched to ${spoken(to.cli)} and picked up from the last saved version.`,
    },
  };
}

// What kind of failure this is — the question every recovery decision hangs
// on, answered before anything acts. Switching routes on a task-level failure
// burns a second route on the same doomed task; retrying in place on a spent
// plan burns wall-clock on a route that cannot answer. The classes:
//
//   transient — the wire or the provider hiccuped; retry the same route.
//   route     — this (CLI, account) cannot work right now; another can.
//   task      — no route fixes it; the task itself needs a human or a reseed.
//   unknown   — no signature matched; recovery must not guess.
//
// Signatures live in shared/agentFailures/signatures.json under fidelity.json's
// doctrine: generic provider/transport wording ships; per-CLI rows appear only
// once verified against real output. Pure module — evidence in, verdict out.

import signatures from "../shared/agentFailures/signatures.json";

export type FailureClass = "transient" | "route" | "task" | "unknown";

export interface FailureEvidence {
  /** Which CLI produced it, for per-CLI signature rows. */
  agent?: string;
  /** Output around the failure — the last lines, a runner error, an exit note. */
  text: string;
}

export interface FailureVerdict {
  class: FailureClass;
  /** The matched signature id, for the incident record and the scorecard. */
  signature: string | null;
}

interface Signature {
  id: string;
  class: string;
  patterns: string[];
}

function rows(agent: string | undefined): Signature[] {
  const perCli = agent
    ? ((signatures.clis as Record<string, Signature[] | undefined>)[agent] ?? [])
    : [];
  // A verified per-CLI row outranks the generic tier: it was written against
  // this CLI's real wording, and specificity is the whole reason it exists.
  return [...perCli, ...(signatures.generic as Signature[])];
}

export function classifyFailure(ev: FailureEvidence): FailureVerdict {
  const text = ev.text.toLowerCase();
  for (const sig of rows(ev.agent)) {
    if (sig.patterns.some((p) => text.includes(p))) {
      return { class: sig.class as FailureClass, signature: sig.id };
    }
  }
  return { class: "unknown", signature: null };
}

/** One attempt's outcome, as the task layer records it. */
export interface AttemptOutcome {
  /** The route it ran on, coarse: agent + profile is enough to know whether
   *  two failures shared a route. */
  route: string;
  verdict: FailureVerdict;
}

/** The promotion rule from the failover design: the same signature failing on
 *  two DIFFERENT routes is evidence about the task, not the routes — stop
 *  switching and escalate. Transient failures never promote this way; they
 *  recur across routes whenever a provider has a bad minute. */
export function promoteAcrossRoutes(history: AttemptOutcome[]): FailureClass | null {
  const seen = new Map<string, Set<string>>();
  for (const h of history) {
    if (!h.verdict.signature) continue;
    if (h.verdict.class !== "route" && h.verdict.class !== "task") continue;
    const routes = seen.get(h.verdict.signature) ?? new Set<string>();
    routes.add(h.route);
    seen.set(h.verdict.signature, routes);
    if (routes.size >= 2) return "task";
  }
  return null;
}

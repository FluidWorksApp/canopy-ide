export type CriterionState = "passed" | "failed" | "unobserved";

export interface CriterionResult {
  id: number;
  label: string;
  state: CriterionState;
  detail: string;
}

/**
 * Signals collected from the running app. Every field is nullable on purpose:
 * a missing observation is not false and is never a pass. The evaluator names
 * it `unobserved`, preserving the manual protocol's strict verdict rule.
 */
export interface VibeExitSignals {
  zeroSetup: null | { noModal: boolean; inferred: boolean; serverStarted: boolean };
  streamedTurn: null | { started: boolean; collapsedTools: boolean; overflow: number; proseChunks: number };
  independentVerification: null | { check: boolean; reload: boolean; repaint: boolean; console: boolean; network: boolean; agentClaimUsed: boolean };
  checkpoint: null | { visible: boolean; reason: string };
  evidenceUi: null | { transcript: boolean; events: boolean; artifacts: boolean; route: boolean };
  attemptRoutes: null | { routes: string[]; recoveryFromAttemptId: string | null; firstAttemptId: string | null };
  nullRendering: null | { observedModel: string; executableFingerprint: string; requestedModelShownAsObserved: boolean };
  routeFailover: null | { narratedBeforeStart: boolean; attempts: number; routesDiffer: boolean; recoveryLinked: boolean };
  taskFailure: null | { attempts: number; switched: boolean; reason: string };
  unusableFleet: null | { namedRoute: boolean; reason: string; runsCreated: number; attemptsCreated: number };
  secretRefusal: null | { refused: boolean; rule: string; location: string; rawInChat: boolean; rawInTranscript: boolean; rawInEvents: boolean };
  productionGate: null | { dirtyRefused: boolean; exactPhraseRequired: boolean; nearMissRan: boolean; exactPhraseRan: boolean };
  lensState: null | { sameProcessBinding: boolean; previewNavigationCountBefore: number; previewNavigationCountAfter: number; chatIntact: boolean; sameTurnContinued: boolean };
  verifiedTurn: null | { outcome: string };
  noCheckExplanation: null | { visible: boolean; durable: boolean; text: string };
  redactedArtifact: null | { marker: boolean; surroundingDiff: boolean; rawValueInStore: boolean };
  incidentLatch: null | { firstOpened: boolean; firstResolved: boolean; secondOpened: boolean; distinctEpisodes: boolean };
}

type Decision = { ok: boolean; detail: string };
type Definition = {
  id: number;
  key: keyof VibeExitSignals;
  label: string;
  // Definitions are heterogeneous in one runtime array. The signal boundary
  // is typed; this erased callback is the single point where its key/value
  // correlation cannot be represented by TypeScript.
  decide(value: any): Decision;
};

const yes = (ok: boolean, detail: string): Decision => ({ ok, detail });

export const VIBE_EXIT_CRITERIA: readonly Definition[] = [
  { id: 1, key: "zeroSetup", label: "zero-setup Build opens and starts", decide: (v) => yes(v.noModal && v.inferred && v.serverStarted, "no modal, inferred target, automatic server") },
  { id: 2, key: "streamedTurn", label: "turn streams and collapses tools", decide: (v) => yes(v.started && v.collapsedTools && v.overflow > 0 && v.proseChunks > 1, "turn started, tool overflow visible, prose streamed") },
  { id: 3, key: "independentVerification", label: "independent verification runs", decide: (v) => yes(v.check && v.reload && v.repaint && v.console && v.network && !v.agentClaimUsed, "check, preview, console and network observed independently") },
  { id: 4, key: "checkpoint", label: "checkpoint decision explains itself", decide: (v) => yes(v.visible && v.reason.trim().length > 0, v.reason || "checkpoint reason missing") },
  { id: 5, key: "evidenceUi", label: "Engineer exposes the complete evidence", decide: (v) => yes(v.transcript && v.events && v.artifacts && v.route, "transcript, events, artifacts and route reachable") },
  { id: 6, key: "attemptRoutes", label: "routes are per attempt and linked", decide: (v) => yes(v.routes.length >= 2 && new Set(v.routes).size >= 2 && !!v.firstAttemptId && v.recoveryFromAttemptId === v.firstAttemptId, "distinct attempt routes with recovery link") },
  { id: 7, key: "nullRendering", label: "null route facts remain null", decide: (v) => yes(v.observedModel === "not observed" && v.executableFingerprint === "not captured" && !v.requestedModelShownAsObserved, "nulls rendered without substitution") },
  { id: 8, key: "routeFailover", label: "route failure reseeds visibly", decide: (v) => yes(v.narratedBeforeStart && v.attempts >= 2 && v.routesDiffer && v.recoveryLinked, "switch narrated before a linked different-route attempt") },
  { id: 9, key: "taskFailure", label: "task failure does not switch routes", decide: (v) => yes(v.attempts === 1 && !v.switched && /work|task|context/i.test(v.reason), v.reason || "task-class reason missing") },
  { id: 10, key: "unusableFleet", label: "unusable fleet refuses before reservation", decide: (v) => yes(v.namedRoute && v.reason.trim().length > 0 && v.runsCreated === 0 && v.attemptsCreated === 0, v.reason || "fleet refusal reason missing") },
  { id: 11, key: "secretRefusal", label: "secret refusal never repeats the value", decide: (v) => yes(v.refused && !!v.rule && !!v.location && !v.rawInChat && !v.rawInTranscript && !v.rawInEvents, `${v.rule || "rule missing"} ${v.location || "location missing"}`) },
  { id: 12, key: "productionGate", label: "production deploy needs clean tree and exact phrase", decide: (v) => yes(v.dirtyRefused && v.exactPhraseRequired && !v.nearMissRan && v.exactPhraseRan, "dirty refused; only exact phrase ran") },
  { id: 13, key: "lensState", label: "lens toggle preserves live state", decide: (v) => yes(v.sameProcessBinding && v.previewNavigationCountBefore === v.previewNavigationCountAfter && v.chatIntact && v.sameTurnContinued, "same process, preview navigation, chat and turn") },
  { id: 14, key: "verifiedTurn", label: "a configured check reaches verified", decide: (v) => yes(v.outcome === "verified", `outcome=${v.outcome || "missing"}`) },
  { id: 15, key: "noCheckExplanation", label: "no-check projects explain incomplete verification", decide: (v) => yes(v.visible && v.durable && /no|without|missing|check|script/i.test(v.text), v.text || "explanation missing") },
  { id: 16, key: "redactedArtifact", label: "secret artifact is redacted at rest", decide: (v) => yes(v.marker && v.surroundingDiff && !v.rawValueInStore, "marker and surrounding diff persisted; raw value absent") },
  { id: 17, key: "incidentLatch", label: "server incident latch works across two turns", decide: (v) => yes(v.firstOpened && v.firstResolved && v.secondOpened && v.distinctEpisodes, "incident opened, resolved and reopened as a distinct episode") },
];

export function evaluateVibeExit(signals: VibeExitSignals): CriterionResult[] {
  return VIBE_EXIT_CRITERIA.map((criterion) => {
    const value = signals[criterion.key] as never;
    if (value == null) {
      return { id: criterion.id, label: criterion.label, state: "unobserved", detail: `no ${criterion.key} observation was collected` };
    }
    const decision = criterion.decide(value);
    return { id: criterion.id, label: criterion.label, state: decision.ok ? "passed" : "failed", detail: decision.detail };
  });
}

export function vibeExitPassed(results: readonly CriterionResult[]): boolean {
  return results.length === 17 && results.every((result) => result.state === "passed");
}

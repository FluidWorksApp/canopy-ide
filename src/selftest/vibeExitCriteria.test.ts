import { describe, expect, it } from "vitest";
import { evaluateVibeExit, vibeExitPassed, type VibeExitSignals } from "./vibeExitCriteria";

const passing = (): VibeExitSignals => ({
  zeroSetup: { noModal: true, inferred: true, serverStarted: true },
  streamedTurn: { started: true, collapsedTools: true, overflow: 2, proseChunks: 3 },
  independentVerification: { check: true, reload: true, repaint: true, console: true, network: true, agentClaimUsed: false },
  checkpoint: { visible: true, reason: "first checkpoint needs confirmation" },
  evidenceUi: { transcript: true, events: true, artifacts: true, route: true },
  attemptRoutes: { routes: ["claude:a", "codex:b"], recoveryFromAttemptId: "a1", firstAttemptId: "a1" },
  nullRendering: { observedModel: "not observed", executableFingerprint: "not captured", requestedModelShownAsObserved: false },
  routeFailover: { narratedBeforeStart: true, attempts: 2, routesDiffer: true, recoveryLinked: true },
  taskFailure: { attempts: 1, switched: false, reason: "the work exceeded its context" },
  unusableFleet: { namedRoute: true, reason: "claude is signed out", runsCreated: 0, attemptsCreated: 0 },
  secretRefusal: { refused: true, rule: "aws-access-key", location: "src/app.ts:3", rawInChat: false, rawInTranscript: false, rawInEvents: false },
  productionGate: { dirtyRefused: true, exactPhraseRequired: true, nearMissRan: false, exactPhraseRan: true },
  lensState: { sameProcessBinding: true, previewNavigationCountBefore: 1, previewNavigationCountAfter: 1, chatIntact: true, sameTurnContinued: true },
  verifiedTurn: { outcome: "verified" },
  noCheckExplanation: { visible: true, durable: true, text: "no check script is available" },
  redactedArtifact: { marker: true, surroundingDiff: true, rawValueInStore: false },
  incidentLatch: { firstOpened: true, firstResolved: true, secondOpened: true, distinctEpisodes: true },
});

const mutations: Array<[keyof VibeExitSignals, (signals: VibeExitSignals) => void]> = [
  ["zeroSetup", (s) => { s.zeroSetup!.serverStarted = false; }],
  ["streamedTurn", (s) => { s.streamedTurn!.collapsedTools = false; }],
  ["independentVerification", (s) => { s.independentVerification!.network = false; }],
  ["checkpoint", (s) => { s.checkpoint!.reason = ""; }],
  ["evidenceUi", (s) => { s.evidenceUi!.artifacts = false; }],
  ["attemptRoutes", (s) => { s.attemptRoutes!.recoveryFromAttemptId = null; }],
  ["nullRendering", (s) => { s.nullRendering!.observedModel = "requested-model"; }],
  ["routeFailover", (s) => { s.routeFailover!.narratedBeforeStart = false; }],
  ["taskFailure", (s) => { s.taskFailure!.switched = true; }],
  ["unusableFleet", (s) => { s.unusableFleet!.attemptsCreated = 1; }],
  ["secretRefusal", (s) => { s.secretRefusal!.rawInTranscript = true; }],
  ["productionGate", (s) => { s.productionGate!.nearMissRan = true; }],
  ["lensState", (s) => { s.lensState!.previewNavigationCountAfter = 2; }],
  ["verifiedTurn", (s) => { s.verifiedTurn!.outcome = "incomplete"; }],
  ["noCheckExplanation", (s) => { s.noCheckExplanation!.durable = false; }],
  ["redactedArtifact", (s) => { s.redactedArtifact!.rawValueInStore = true; }],
  ["incidentLatch", (s) => { s.incidentLatch!.secondOpened = false; }],
];

describe("vibe exit criterion", () => {
  it("passes only with all seventeen observations", () => {
    const results = evaluateVibeExit(passing());
    expect(results).toHaveLength(17);
    expect(vibeExitPassed(results)).toBe(true);
  });

  it("records missing evidence as unobserved, never passed", () => {
    const signals = passing();
    signals.independentVerification = null;
    const result = evaluateVibeExit(signals)[2];
    expect(result).toMatchObject({ id: 3, state: "unobserved" });
    expect(vibeExitPassed(evaluateVibeExit(signals))).toBe(false);
  });

  for (const [key, mutate] of mutations) {
    it(`mutation-checks ${key}`, () => {
      const signals = passing();
      mutate(signals);
      const results = evaluateVibeExit(signals);
      const result = results[mutations.findIndex(([name]) => name === key)];
      expect(result.state, `${key} mutation did not turn its criterion red`).toBe("failed");
      expect(vibeExitPassed(results)).toBe(false);
    });
  }
});

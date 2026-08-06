import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import type { TaskAttempt, TaskEvent, TaskRouteSnapshot } from "./taskEnvelope";
import {
  attemptEvidence,
  loadTaskEvidence,
  routeFacts,
  selectionFacts,
  NOT_CAPTURED,
  NOT_OBSERVED,
} from "./taskEvidence";

const route = (over: Partial<TaskRouteSnapshot> = {}): TaskRouteSnapshot => ({
  cli: "claude",
  cliVersion: "1.2.3",
  executableFingerprint: null,
  profileId: "default",
  requestedModel: "claude-fable-5",
  observedModel: null,
  harnessVersion: "vibe-mvp-1",
  promptVersion: "vibe-builder-1",
  toolPolicyVersion: "workspace-write-no-shell-1",
  executionMode: "structured",
  selection: {
    policy: "vibe-fleet-ranked-1",
    eligible: ["claude:default", "codex:default"],
    degradedTier: false,
    caveat: null,
  },
  ...over,
});

const attempt = (over: Partial<TaskAttempt> = {}): TaskAttempt => ({
  attemptId: "attempt-1",
  runId: "run-1",
  ordinal: 1,
  state: "completed",
  route: route(),
  ...over,
});

const event = (over: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => ({
  eventId: `event-${Math.random()}`,
  runId: "run-1",
  attemptId: "attempt-1",
  source: "canopy",
  occurredAt: 10,
  ...over,
});

const observationEvent = (
  kind: string,
  verdict: string,
  extra: Record<string, unknown> = {},
) =>
  event({
    kind: "verification.observation",
    code: kind,
    metadata: { kind, verdict, note: `${kind} ${verdict}`, at: 10, ...extra },
  });

describe("routeFacts", () => {
  it("says a missing observed model is not observed, never the requested one", () => {
    const facts = routeFacts(route());
    const observed = facts.find((fact) => fact.label === "Observed model");
    expect(observed).toEqual({
      label: "Observed model",
      value: NOT_OBSERVED,
      absent: true,
    });
    // The failure this guards against is a friendlier fallback: a record that
    // asked for a model and never saw one must not read as having seen it. The
    // requested model is on screen — once, under its own label.
    expect(observed?.value).not.toBe("claude-fable-5");
    expect(
      facts.filter((fact) => fact.value === "claude-fable-5").map((f) => f.label),
    ).toEqual(["Requested model"]);
  });

  it("keeps an uncaptured fingerprint on screen rather than hiding it", () => {
    const fingerprint = routeFacts(route()).find(
      (fact) => fact.label === "Executable",
    );
    expect(fingerprint?.value).toBe(NOT_CAPTURED);
    expect(fingerprint?.absent).toBe(true);
  });

  it("marks a recorded value as present", () => {
    const facts = routeFacts(route({ observedModel: "claude-fable-5" }));
    expect(facts.find((fact) => fact.label === "Observed model")).toEqual({
      label: "Observed model",
      value: "claude-fable-5",
      absent: false,
    });
  });
});

describe("selectionFacts", () => {
  it("carries every route the policy considered", () => {
    expect(selectionFacts(route().selection)?.eligible).toEqual([
      "claude:default",
      "codex:default",
    ]);
  });

  it("distinguishes a recorded false from a field that says nothing", () => {
    expect(selectionFacts({ eligible: [] })?.degradedTier).toBeNull();
    expect(selectionFacts({ degradedTier: false })?.degradedTier).toBe(false);
    expect(selectionFacts({ degradedTier: true })?.degradedTier).toBe(true);
  });

  it("returns null for a selection that is not an object", () => {
    expect(selectionFacts(undefined)).toBeNull();
    expect(selectionFacts("claude")).toBeNull();
  });
});

describe("attemptEvidence", () => {
  it("keeps each attempt's own route so a failover cannot be collapsed", () => {
    const first = attempt({ attemptId: "a1", ordinal: 1, state: "failed" });
    const second = attempt({
      attemptId: "a2",
      ordinal: 2,
      recoveryFromAttemptId: "a1",
      route: route({
        cli: "codex",
        requestedModel: "gpt-5-codex",
        selection: { policy: "vibe-fleet-ranked-1", eligible: ["codex:default"] },
      }),
    });
    // Deliberately out of order: the store's order is not the reading order.
    const evidence = attemptEvidence([second, first], []);
    expect(evidence.map((entry) => entry.attempt.attemptId)).toEqual(["a1", "a2"]);
    expect(
      evidence.map(
        (entry) => entry.route.find((fact) => fact.label === "Agent")?.value,
      ),
    ).toEqual(["claude", "codex"]);
    expect(evidence[1].recoveryFrom).toEqual({ attemptId: "a1", ordinal: 1 });
    expect(evidence[0].recoveryFrom).toBeNull();
  });

  it("does not invent a link to an attempt that is not in this run", () => {
    const orphan = attempt({ recoveryFromAttemptId: "from-another-run" });
    expect(attemptEvidence([orphan], [])[0].recoveryFrom).toBeNull();
  });

  it("attaches observations, the verdict, and only this attempt's events", () => {
    const mine = attempt({ attemptId: "a1" });
    const theirs = attempt({ attemptId: "a2", ordinal: 2 });
    const events = [
      { ...observationEvent("check", "pass"), attemptId: "a1" },
      { ...observationEvent("console", "fail"), attemptId: "a1" },
      { ...observationEvent("server", "pass"), attemptId: "a2" },
      event({
        kind: "verification.verdict",
        code: "failed",
        attemptId: "a1",
        metadata: {
          verdict: {
            outcome: "failed",
            missing: ["network"],
            failures: [{ kind: "console", verdict: "fail", note: "boom", at: 10 }],
          },
        },
      }),
    ];
    const [first, second] = attemptEvidence([mine, theirs], events);
    expect(first.observations.map((o) => o.kind)).toEqual(["check", "console"]);
    expect(first.verdict?.outcome).toBe("failed");
    expect(first.verdict?.missing).toEqual(["network"]);
    expect(first.verdict?.failures[0].note).toBe("boom");
    expect(second.observations.map((o) => o.kind)).toEqual(["server"]);
    expect(second.verdict).toBeNull();
  });

  it("drops an event whose metadata is not an observation", () => {
    const events = [
      event({ kind: "verification.observation", metadata: { note: "no kind" } }),
      event({ kind: "verification.observation", metadata: "not an object" }),
    ];
    expect(attemptEvidence([attempt()], events)[0].observations).toEqual([]);
  });

  it("reaches the artifacts the vibe path writes and nothing else", () => {
    const events = [
      observationEvent("check", "pass", { evidence: "artifact_check" }),
      observationEvent("screenshot", "pass", { evidence: "artifact_shot" }),
      // A server observation's evidence is a URL, not an artifact id — reading
      // it as one would produce a button that fetches nothing.
      observationEvent("server", "pass", { evidence: "http://localhost:5173/" }),
      event({
        kind: "checkpoint.refused",
        code: "not-verified",
        metadata: { reasons: ["not-verified"], artifactId: "artifact_diff" },
      }),
      event({
        kind: "watchdog-incident",
        code: "vibe-server-crash-loop",
        metadata: { logArtifactId: "artifact_log" },
      }),
    ];
    const artifacts = attemptEvidence([attempt()], events)[0].artifacts;
    expect(artifacts.map((a) => a.id)).toEqual([
      "artifact_check",
      "artifact_shot",
      "artifact_diff",
      "artifact_log",
    ]);
    expect(artifacts.find((a) => a.id === "artifact_shot")?.render).toBe("image");
    expect(artifacts.find((a) => a.id === "artifact_diff")?.kind).toBe("turn-diff");
  });

  it("reads a held checkpoint as held, with no reason it never had", () => {
    const events = [
      event({
        kind: "checkpoint.held",
        code: "auto-checkpoint-never-observed",
        metadata: { reasons: [], artifactId: "artifact_diff", paths: ["src/App.tsx"] },
      }),
    ];
    const checkpoint = attemptEvidence([attempt()], events)[0].checkpoint;
    expect(checkpoint).toEqual({
      outcome: "held",
      code: "auto-checkpoint-never-observed",
      commit: null,
      paths: ["src/App.tsx"],
      reasons: [],
    });
  });

  it("keeps the failover decision that explains why a second attempt exists", () => {
    const events = [
      event({
        kind: "failover.decision",
        code: "switch-route",
        metadata: {
          reason: "quota-exhausted",
          verdict: { class: "route", signature: "quota-exhausted" },
        },
      }),
    ];
    expect(attemptEvidence([attempt()], events)[0].failover).toEqual({
      action: "switch-route",
      reason: "quota-exhausted",
      failureClass: "route",
      signature: "quota-exhausted",
    });
  });
});

describe("loadTaskEvidence", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("projects the whole record, transcript included", async () => {
    vi.spyOn(ipc, "taskGet").mockResolvedValue({
      envelope: {
        runId: "run-1",
        projectId: "p",
        componentId: "app",
        kind: "vibe-turn",
        status: "completed",
        attemptCount: 1,
        createdAt: 1,
        updatedAt: 2,
        schemaVersion: 1,
        worktreePath: "/repo",
        goal: "Make the button blue",
        acceptance: ["Implement it."],
        taskClasses: {},
        contextSummary: "",
        riskClass: "reversible",
        authorityPolicy: {},
        failoverPolicy: {},
        attemptCap: 1,
      },
      attempts: [attempt()],
    });
    vi.spyOn(ipc, "taskEventList").mockResolvedValue([
      observationEvent("check", "pass"),
      { ...observationEvent("server", "pass"), attemptId: null },
    ]);
    vi.spyOn(ipc, "taskTranscriptList").mockResolvedValue([
      { seq: 1, runId: "run-1", kind: "user", body: "Make the button blue", createdAt: 1 },
    ]);

    const evidence = await loadTaskEvidence("run-1");
    expect(evidence?.goal).toBe("Make the button blue");
    expect(evidence?.attempts).toHaveLength(1);
    expect(evidence?.attempts[0].observations.map((o) => o.kind)).toEqual(["check"]);
    expect(evidence?.transcript[0].body).toBe("Make the button blue");
    // An event nobody's attempt owns is still evidence; dropping it silently
    // would lose exactly the incidents recorded between turns.
    expect(evidence?.unattached).toHaveLength(1);
  });

  it("still shows the route when the transcript cannot be read", async () => {
    vi.spyOn(ipc, "taskGet").mockResolvedValue({
      envelope: {
        runId: "run-1",
        projectId: "p",
        componentId: "app",
        kind: "vibe-turn",
        status: "completed",
        attemptCount: 1,
        createdAt: 1,
        updatedAt: 2,
        schemaVersion: 1,
        worktreePath: "/repo",
        goal: "g",
        acceptance: [],
        taskClasses: {},
        contextSummary: "",
        riskClass: "reversible",
        authorityPolicy: {},
        failoverPolicy: {},
        attemptCap: 1,
      },
      attempts: [attempt()],
    });
    vi.spyOn(ipc, "taskEventList").mockRejectedValue(new Error("gone"));
    vi.spyOn(ipc, "taskTranscriptList").mockRejectedValue(new Error("gone"));

    const evidence = await loadTaskEvidence("run-1");
    expect(evidence?.attempts).toHaveLength(1);
    expect(evidence?.transcript).toEqual([]);
  });

  it("returns null for a run with no envelope left", async () => {
    vi.spyOn(ipc, "taskGet").mockResolvedValue(null);
    vi.spyOn(ipc, "taskEventList").mockResolvedValue([]);
    vi.spyOn(ipc, "taskTranscriptList").mockResolvedValue([]);
    expect(await loadTaskEvidence("run-1")).toBeNull();
  });
});

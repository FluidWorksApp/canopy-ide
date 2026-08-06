// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as ipc from "../ipc";
import type { TaskAttempt, TaskEnvelopeDetail, TaskEvent } from "../taskEnvelope";
import { TaskEvidence, TaskEvidenceFold } from "./TaskEvidence";

const attempt = (over: Partial<TaskAttempt> = {}): TaskAttempt => ({
  attemptId: "a1",
  runId: "run-1",
  ordinal: 1,
  state: "completed",
  route: {
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
  },
  ...over,
});

const detail = (attempts: TaskAttempt[]): TaskEnvelopeDetail => ({
  envelope: {
    runId: "run-1",
    projectId: "p",
    componentId: "app",
    kind: "vibe-turn",
    status: "completed",
    attemptCount: attempts.length,
    createdAt: 1,
    updatedAt: 2,
    schemaVersion: 1,
    worktreePath: "/repo",
    goal: "Make the button blue",
    acceptance: [],
    taskClasses: {},
    contextSummary: "",
    riskClass: "reversible",
    authorityPolicy: {},
    failoverPolicy: {},
    attemptCap: 1,
  },
  attempts,
});

const event = (over: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => ({
  eventId: `e-${Math.random()}`,
  runId: "run-1",
  attemptId: "a1",
  source: "canopy",
  occurredAt: 10,
  ...over,
});

function ledger(args: {
  attempts?: TaskAttempt[];
  events?: TaskEvent[];
  transcript?: Awaited<ReturnType<typeof ipc.taskTranscriptList>>;
  artifact?: string;
}) {
  vi.spyOn(ipc, "taskGet").mockResolvedValue(detail(args.attempts ?? [attempt()]));
  vi.spyOn(ipc, "taskEventList").mockResolvedValue(args.events ?? []);
  vi.spyOn(ipc, "taskTranscriptList").mockResolvedValue(args.transcript ?? []);
  return vi
    .spyOn(ipc, "taskArtifactRead")
    .mockResolvedValue(args.artifact ?? "check passed");
}

// `vi.spyOn` on an already-spied property returns the SAME mock, so without
// this a later test counts calls made by an earlier one — and "fetches nothing
// until it is opened" would fail for a reason that has nothing to do with it.
beforeEach(() => vi.restoreAllMocks());

describe("TaskEvidence", () => {
  it("shows an unobserved model as unobserved, never as the requested one", async () => {
    ledger({});
    render(<TaskEvidence runId="run-1" />);
    await screen.findByText("Evidence");

    const observed = screen.getByText("Observed model").parentElement;
    expect(observed?.textContent).toContain("not observed");
    expect(observed?.textContent).not.toContain("claude-fable-5");
    // Absent, and still drawn: hiding it would leave every line on screen
    // looking like something that was measured.
    expect(screen.getByText("not captured")).toBeTruthy();
  });

  it("draws each attempt with its own route so a failover reads as a switch", async () => {
    const second = attempt({
      attemptId: "a2",
      ordinal: 2,
      recoveryFromAttemptId: "a1",
      route: { ...attempt().route, cli: "codex", requestedModel: "gpt-5-codex" },
    });
    ledger({ attempts: [attempt({ state: "failed" }), second] });
    render(<TaskEvidence runId="run-1" />);

    await screen.findByText("Attempt 1");
    expect(screen.getByText("Attempt 2")).toBeTruthy();
    expect(screen.getByText("reseeded after attempt 1 failed")).toBeTruthy();
    // Both models on screen at once — a per-run route would show only one.
    expect(screen.getByText("claude-fable-5")).toBeTruthy();
    expect(screen.getByText("gpt-5-codex")).toBeTruthy();
  });

  it("puts a degraded tier and its caveat above the route facts", async () => {
    ledger({
      attempts: [
        attempt({
          route: {
            ...attempt().route,
            selection: {
              policy: "vibe-fleet-ranked-1",
              eligible: ["claude:default"],
              degradedTier: true,
              caveat: "claude is rate limited",
            },
          },
        }),
      ],
    });
    render(<TaskEvidence runId="run-1" />);

    const alert = await screen.findByText(
      "This ran on a lower model tier than this kind of work asks for.",
    );
    expect(alert).toBeTruthy();
    expect(screen.getByText("claude is rate limited")).toBeTruthy();
    expect(
      screen.getByText("Considered claude:default · policy vibe-fleet-ranked-1"),
    ).toBeTruthy();
  });

  it("renders the recorded observations and verdict, not a recomputed one", async () => {
    ledger({
      events: [
        event({
          kind: "verification.observation",
          code: "check",
          metadata: {
            kind: "check",
            verdict: "pass",
            note: "configured check passed: npm run typecheck",
            at: 10,
          },
        }),
        event({
          kind: "verification.verdict",
          code: "incomplete",
          // Deliberately inconsistent with the one passing observation above:
          // the surface must show what was RECORDED, not judge it again.
          metadata: {
            verdict: { outcome: "incomplete", missing: ["network"], failures: [] },
          },
        }),
      ],
    });
    render(<TaskEvidence runId="run-1" />);

    await screen.findByText("configured check passed: npm run typecheck");
    expect(screen.getByText("incomplete")).toBeTruthy();
    expect(screen.getByText("Never checked: network.")).toBeTruthy();
  });

  it("reaches a stored artifact only when asked, then shows it", async () => {
    const read = ledger({
      events: [
        event({
          kind: "verification.observation",
          code: "check",
          metadata: {
            kind: "check",
            verdict: "fail",
            note: "configured check failed",
            evidence: "artifact_check",
            at: 10,
          },
        }),
      ],
      artifact: "TS2322: Type 'number' is not assignable",
    });
    render(<TaskEvidence runId="run-1" />);

    const toggle = await screen.findByText("Check output");
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByText("TS2322: Type 'number' is not assignable"),
      ).toBeTruthy(),
    );
    expect(read).toHaveBeenCalledWith("artifact_check");
  });

  it("shows Canopy's own transcript", async () => {
    ledger({
      transcript: [
        { seq: 1, runId: "run-1", kind: "user", body: "Make it blue", createdAt: 1 },
        { seq: 2, runId: "run-1", kind: "system", body: "Verification is incomplete", createdAt: 2 },
      ],
    });
    render(<TaskEvidence runId="run-1" />);

    await screen.findByText("Make it blue");
    expect(screen.getByText("Verification is incomplete")).toBeTruthy();
  });

  it("says so when the record is gone instead of rendering nothing", async () => {
    vi.spyOn(ipc, "taskGet").mockResolvedValue(null);
    vi.spyOn(ipc, "taskEventList").mockResolvedValue([]);
    vi.spyOn(ipc, "taskTranscriptList").mockResolvedValue([]);
    render(<TaskEvidence runId="run-1" />);
    expect(
      await screen.findByText(/no durable record left/),
    ).toBeTruthy();
  });
});

describe("TaskEvidenceFold", () => {
  it("fetches nothing until it is opened", async () => {
    const get = vi.spyOn(ipc, "taskGet").mockResolvedValue(detail([attempt()]));
    vi.spyOn(ipc, "taskEventList").mockResolvedValue([]);
    vi.spyOn(ipc, "taskTranscriptList").mockResolvedValue([]);

    render(<TaskEvidenceFold runId="run-1" />);
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Show what was verified"));
    await screen.findByText("Evidence");
    expect(get).toHaveBeenCalledWith("run-1");
  });
});

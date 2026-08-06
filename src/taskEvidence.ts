// The read half of the durable evidence ledger.
//
// Everything a turn records — verification observations, the verdict, the route
// each attempt actually ran on, the checkpoint decision, the capped artifacts
// and Canopy's own transcript — was write-only. `taskEvents` and
// `listTranscript` appeared exactly once each in `src`, at their own
// definitions, and the three vibe artifacts were never fetched by anything.
// Evidence nobody can read is not evidence; it is storage.
//
// This module is that reader, deliberately in two halves:
//
//   pure projections  — `routeFacts`, `selectionFacts`, `attemptEvidence` and
//                       friends take records and return what a surface should
//                       show. No IPC, so they can be tested for what they say.
//   `loadTaskEvidence` — the one impure function: fetch, then project.
//
// Two rules the projections obey everywhere.
//
// RENDER WHAT THE RECORD SAYS, INCLUDING ITS NULLS. `observedModel` is null on
// every attempt because no CLI reports which model it really used. It reads as
// "not observed" and must NEVER fall back to `requestedModel` — that would turn
// a request into a false observation, which is the one distinction the attempt
// record exists to keep. `executableFingerprint` is null for the same reason
// and says "not captured" rather than quietly disappearing: a field that
// vanishes when it is empty teaches the reader that everything left on screen
// was measured, and here most of it was not.
//
// PER ATTEMPT, NEVER PER RUN. A reseeded attempt carries a different route from
// the one it replaced. Showing a run-level route would collapse a failover into
// whichever model happened to go last and hide the switch entirely — so the
// attempts are shown in sequence, each with its own route, linked by
// `recoveryFromAttemptId` so the failover reads as the story it was.

import * as ipc from "./ipc";
import { taskEvents, taskGet } from "./taskEnvelopes";
import type { TaskAttempt, TaskEvent, TaskRouteSnapshot } from "./taskEnvelope";
import { listTranscript, type TaskTranscriptEntry } from "./taskTranscript";
import type { CheckpointRefusal } from "./vibeCheckpoints";
import type {
  ObservationKind,
  VerificationObservation,
  VerificationVerdict,
} from "./vibeVerification";

/** What an absent field reads as. One constant per reason so the words are
 *  chosen once and cannot drift between surfaces, and so "we never captured
 *  this" stays distinguishable from "this was captured as empty". */
export const NOT_OBSERVED = "not observed";
export const NOT_CAPTURED = "not captured";
export const NOT_RECORDED = "not recorded";
export const NONE_REQUESTED = "none requested";

/** One line of the route record. `absent` is carried rather than inferred from
 *  the text, so a surface can grey the placeholder without string-matching the
 *  words a future edit might change. */
export interface RouteFact {
  label: string;
  value: string;
  absent: boolean;
}

/** The route an attempt actually launched on, field by field, nulls included.
 *  See the module header: no placeholder here is ever another field's value. */
export function routeFacts(route: TaskRouteSnapshot): RouteFact[] {
  const fact = (
    label: string,
    value: string | null | undefined,
    missing: string,
  ): RouteFact =>
    value ? { label, value, absent: false } : { label, value: missing, absent: true };
  return [
    fact("Agent", route.cli, NOT_RECORDED),
    fact("Version", route.cliVersion, NOT_RECORDED),
    fact("Profile", route.profileId, NOT_RECORDED),
    fact("Requested model", route.requestedModel, NONE_REQUESTED),
    // Deliberately not `route.observedModel ?? route.requestedModel`. See the
    // module header: that substitution is the whole failure this reads against.
    fact("Observed model", route.observedModel, NOT_OBSERVED),
    fact("Executable", route.executableFingerprint, NOT_CAPTURED),
    fact("Execution mode", route.executionMode, NOT_RECORDED),
    fact("Harness", route.harnessVersion, NOT_RECORDED),
    fact("Prompt", route.promptVersion, NOT_RECORDED),
    fact("Tool policy", route.toolPolicyVersion, NOT_RECORDED),
  ];
}

/** The selecting policy's own snapshot, read back out of the `unknown` the
 *  envelope stores it as. `eligible` is what makes "why this model" answerable
 *  from the record alone: it is every route that was actually considered. */
export interface SelectionFacts {
  policy: string | null;
  eligible: string[];
  /** True when the tier served was below what the task class asked for. Null
   *  when the record does not say — which is not the same as "no". */
  degradedTier: boolean | null;
  /** Why the chosen route was less than fully healthy, if it was. */
  caveat: string | null;
}

export function selectionFacts(selection: unknown): SelectionFacts | null {
  if (!selection || typeof selection !== "object") return null;
  const raw = selection as Record<string, unknown>;
  return {
    policy: typeof raw.policy === "string" && raw.policy ? raw.policy : null,
    eligible: Array.isArray(raw.eligible)
      ? raw.eligible.filter((entry): entry is string => typeof entry === "string")
      : [],
    degradedTier: typeof raw.degradedTier === "boolean" ? raw.degradedTier : null,
    caveat:
      typeof raw.caveat === "string" && raw.caveat.trim() ? raw.caveat.trim() : null,
  };
}

/** A stored artifact this attempt can reach. The id is all the store hands
 *  back; `label` and `render` come from the writer's own vocabulary, which is
 *  why the mapping below is keyed on the event that wrote it rather than
 *  guessed from the id's shape. */
export interface EvidenceArtifact {
  id: string;
  kind: string;
  label: string;
  render: "text" | "image";
}

/** Which observation kinds put an artifact id in `evidence`, and what that
 *  artifact is. A `server` observation's `evidence` is a URL, not an id — so
 *  the whitelist is by kind, and nothing is inferred from the value. */
const OBSERVATION_ARTIFACT: Partial<
  Record<ObservationKind, Omit<EvidenceArtifact, "id">>
> = {
  check: { kind: "check-output", label: "Check output", render: "text" },
  screenshot: {
    kind: "preview-screenshot-base64",
    label: "Preview screenshot",
    render: "image",
  },
};

/** What the checkpoint policy decided, as recorded. `held` is neither a pass
 *  nor a policy refusal: the policy allowed the commit and Canopy declined to
 *  make it automatically because it has never been observed working here. */
export interface CheckpointEvidence {
  outcome: "saved" | "refused" | "held";
  /** `automatic`, `explicit`, or the first refusal reason — the event's code. */
  code: string | null;
  commit: string | null;
  paths: string[];
  reasons: CheckpointRefusal[];
}

/** Why an attempt ended the way it did, when the failover policy said so. */
export interface FailoverEvidence {
  action: string;
  reason: string | null;
  failureClass: string | null;
  signature: string | null;
}

export interface AttemptEvidence {
  attempt: TaskAttempt;
  route: RouteFact[];
  selection: SelectionFacts | null;
  /** Latest-first is wrong here: these are a sequence of measurements, and the
   *  order they were taken in is part of what they say. */
  observations: VerificationObservation[];
  verdict: VerificationVerdict | null;
  checkpoint: CheckpointEvidence | null;
  failover: FailoverEvidence | null;
  artifacts: EvidenceArtifact[];
  /** The attempt this one exists because of, with the ordinal a reader can see
   *  on screen. Null on a first attempt — and on one whose predecessor is not
   *  in this run, which is a record we decline to invent a link for. */
  recoveryFrom: { attemptId: string; ordinal: number } | null;
}

export interface TaskRunEvidence {
  runId: string;
  kind: string;
  goal: string;
  acceptance: string[];
  attempts: AttemptEvidence[];
  /** Canopy's own transcript, oldest first — the record that outlives the CLI
   *  session it was taken from. */
  transcript: TaskTranscriptEntry[];
  /** Events recorded before any attempt owned them. Rare, and dropping them
   *  silently would lose exactly the incidents that happened between turns. */
  unattached: TaskEvent[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/** An observation as the ledger stored it. Validated rather than cast: an event
 *  whose metadata is not an observation must be dropped, not rendered as one
 *  with blank fields that read like a measurement. */
function readObservation(value: unknown): VerificationObservation | null {
  const raw = record(value);
  if (!raw) return null;
  const kind = text(raw.kind);
  const verdict = text(raw.verdict);
  if (!kind || !verdict) return null;
  if (!["pass", "fail", "unknown"].includes(verdict)) return null;
  return {
    kind: kind as ObservationKind,
    verdict: verdict as VerificationObservation["verdict"],
    note: text(raw.note) ?? "",
    evidence: text(raw.evidence),
    at: typeof raw.at === "number" ? raw.at : 0,
  };
}

function readVerdict(value: unknown): VerificationVerdict | null {
  const raw = record(record(value)?.verdict);
  const outcome = text(raw?.outcome);
  if (!raw || !outcome) return null;
  if (!["verified", "failed", "incomplete"].includes(outcome)) return null;
  return {
    outcome: outcome as VerificationVerdict["outcome"],
    missing: strings(raw.missing) as ObservationKind[],
    failures: (Array.isArray(raw.failures) ? raw.failures : [])
      .map(readObservation)
      .filter((entry): entry is VerificationObservation => entry !== null),
  };
}

function readCheckpoint(event: TaskEvent): CheckpointEvidence | null {
  const meta = record(event.metadata);
  const outcome =
    event.kind === "checkpoint.saved"
      ? "saved"
      : event.kind === "checkpoint.refused"
        ? "refused"
        : event.kind === "checkpoint.held"
          ? "held"
          : null;
  if (!outcome) return null;
  return {
    outcome,
    code: text(event.code),
    commit: text(meta?.commit),
    paths: strings(meta?.paths),
    reasons: strings(meta?.reasons) as CheckpointRefusal[],
  };
}

function readFailover(event: TaskEvent): FailoverEvidence | null {
  if (event.kind !== "failover.decision") return null;
  const meta = record(event.metadata);
  const verdict = record(meta?.verdict);
  return {
    action: text(event.code) ?? "unknown",
    reason: text(meta?.reason),
    failureClass: text(verdict?.class),
    signature: text(verdict?.signature),
  };
}

/** Every artifact this attempt's events point at, in the order they were
 *  written. Deduplicated by id: a re-recorded event must not double the list. */
function artifactsFor(events: readonly TaskEvent[]): EvidenceArtifact[] {
  const found = new Map<string, EvidenceArtifact>();
  const add = (id: string | null, shape: Omit<EvidenceArtifact, "id">) => {
    if (id && !found.has(id)) found.set(id, { id, ...shape });
  };
  for (const event of events) {
    const meta = record(event.metadata);
    if (event.kind === "verification.observation") {
      const observation = readObservation(event.metadata);
      const shape = observation && OBSERVATION_ARTIFACT[observation.kind];
      if (shape) add(observation.evidence ?? null, shape);
    }
    if (event.kind === "checkpoint.refused" || event.kind === "checkpoint.held") {
      add(text(meta?.artifactId), {
        kind: "turn-diff",
        label: "Turn diff",
        render: "text",
      });
    }
    if (event.kind === "watchdog-incident") {
      add(text(meta?.logArtifactId), {
        kind: "vibe-server-log-tail",
        label: "Server log tail",
        render: "text",
      });
    }
  }
  return [...found.values()];
}

/** Project attempts and events into one readable sequence.
 *
 *  Attempts come back in ordinal order — the order they ran — because that is
 *  what makes a failover legible: attempt 1 on one model, attempt 2 on another,
 *  each carrying the route it actually used and a link back to the attempt it
 *  was reseeded from. */
export function attemptEvidence(
  attempts: readonly TaskAttempt[],
  events: readonly TaskEvent[],
): AttemptEvidence[] {
  const ordered = [...attempts].sort((a, b) => a.ordinal - b.ordinal);
  const ordinals = new Map(ordered.map((a) => [a.attemptId, a.ordinal]));
  return ordered.map((attempt) => {
    const mine = events.filter((event) => event.attemptId === attempt.attemptId);
    const observations = mine
      .filter((event) => event.kind === "verification.observation")
      .map((event) => readObservation(event.metadata))
      .filter((entry): entry is VerificationObservation => entry !== null);
    // Last verdict wins: a re-judged attempt supersedes its own earlier answer,
    // and the store returns events oldest first.
    const verdict = mine
      .filter((event) => event.kind === "verification.verdict")
      .map((event) => readVerdict(event.metadata))
      .filter((entry): entry is VerificationVerdict => entry !== null)
      .at(-1);
    const checkpoint = mine.map(readCheckpoint).filter(Boolean).at(-1);
    const failover = mine.map(readFailover).filter(Boolean).at(-1);
    const from = attempt.recoveryFromAttemptId ?? null;
    const fromOrdinal = from ? ordinals.get(from) : undefined;
    return {
      attempt,
      route: routeFacts(attempt.route),
      selection: selectionFacts(attempt.route.selection),
      observations,
      verdict: verdict ?? null,
      checkpoint: checkpoint ?? null,
      failover: failover ?? null,
      artifacts: artifactsFor(mine),
      recoveryFrom:
        from && fromOrdinal !== undefined
          ? { attemptId: from, ordinal: fromOrdinal }
          : null,
    };
  });
}

/** Fetch and project one run's whole durable record.
 *
 *  Events and transcript are fetched tolerantly: a run whose transcript failed
 *  to load should still show its route and its verdict, because a surface that
 *  renders nothing at all is indistinguishable from a run that recorded
 *  nothing, and those are very different things. */
export async function loadTaskEvidence(
  runId: string,
  limit = 200,
): Promise<TaskRunEvidence | null> {
  const [detail, events, transcript] = await Promise.all([
    taskGet(runId),
    taskEvents(runId, limit).catch(() => [] as TaskEvent[]),
    listTranscript(runId, limit).catch(() => [] as TaskTranscriptEntry[]),
  ]);
  if (!detail) return null;
  return {
    runId,
    kind: detail.envelope.kind,
    goal: detail.envelope.goal,
    acceptance: detail.envelope.acceptance ?? [],
    attempts: attemptEvidence(detail.attempts, events),
    transcript,
    unattached: events.filter((event) => !event.attemptId),
  };
}

/** Read one stored artifact. Separate from `loadTaskEvidence` on purpose: a
 *  turn diff and a screenshot are capped but not small, and fetching every one
 *  of them to render a collapsed row would be paying for what nobody opened. */
export const readEvidenceArtifact = (id: string): Promise<string> =>
  ipc.taskArtifactRead(id);

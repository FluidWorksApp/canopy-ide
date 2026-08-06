// What a turn actually proved, read back out of the durable ledger.
//
// Every attempt records verification observations, a verdict, the route it ran
// on, a checkpoint decision, capped artifacts and Canopy's own transcript — and
// until this component none of it was ever read. It hangs under an expanded row
// in TaskHistoryView rather than in a panel of its own: the question it answers
// ("what was actually checked, and on what?") is the same question that row is
// already open to answer, and a second surface would be a second place to
// forget to look.
//
// Two rules it inherits from taskEvidence.ts, and they are the whole design:
//
//   Attempts are shown IN SEQUENCE, each with its own route. A reseeded attempt
//   runs on a different model from the one it replaced, so anything drawn per
//   run would collapse a failover into whichever model happened to go last —
//   and the switch is the single most important thing on this screen.
//
//   Absent fields are DRAWN, not hidden. "not observed" and "not captured" are
//   findings. A route panel that quietly omitted them would read as ten
//   measured facts instead of six measured and four never taken.
import { useEffect, useState } from "react";
import {
  loadTaskEvidence,
  readEvidenceArtifact,
  type AttemptEvidence,
  type EvidenceArtifact,
  type TaskRunEvidence,
} from "../taskEvidence";
import type { VerificationObservation } from "../vibeVerification";
import { AgentIcon } from "./icons";
import { Button } from "./ui";

/** How a required observation reads. `unknown` is its own word on purpose: it
 *  is not a soft pass, and the verdict logic treats it as a hard stop. */
const VERDICT_TEXT: Record<VerificationObservation["verdict"], string> = {
  pass: "passed",
  fail: "failed",
  unknown: "unknown",
};

const ATTEMPT_STATE_NOTE: Record<string, string> = {
  completed: "finished",
  failed: "failed",
  blocked: "blocked",
  interrupted: "interrupted",
  cancelled: "cancelled",
};

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleTimeString() : "";
}

/** One stored artifact, fetched only when someone asks for it. A turn diff and
 *  a screenshot are capped but not small, and pulling every one of them to
 *  paint a collapsed row would be paying for what nobody opened. */
function ArtifactView({ artifact }: { artifact: EvidenceArtifact }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || content !== null || error) return;
    let live = true;
    void readEvidenceArtifact(artifact.id).then(
      (text) => live && setContent(text),
      (cause) => live && setError(String(cause)),
    );
    return () => {
      live = false;
    };
  }, [open, artifact.id, content, error]);

  return (
    <div className="task-evidence-artifact">
      <button
        type="button"
        className="task-evidence-artifact-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="task-history-caret">›</span>
        {artifact.label}
        <span className="task-history-section-count">{artifact.kind}</span>
      </button>
      {open &&
        (error ? (
          // Said out loud rather than swallowed: an artifact the store can no
          // longer produce is itself a fact about this run's evidence.
          <div className="task-history-note">
            This artifact could not be read back: {error}
          </div>
        ) : content === null ? (
          <div className="task-history-note">Reading…</div>
        ) : artifact.render === "image" ? (
          <img
            className="task-evidence-shot"
            alt={`${artifact.label} kept for this attempt`}
            src={`data:image/jpeg;base64,${content}`}
          />
        ) : (
          <pre className="task-history-output">{content}</pre>
        ))}
    </div>
  );
}

function Attempt({ evidence }: { evidence: AttemptEvidence }) {
  const { attempt, selection, verdict, checkpoint, failover } = evidence;
  return (
    <div className="task-evidence-attempt">
      <div className="task-evidence-attempt-head">
        <span className="task-evidence-ordinal">Attempt {attempt.ordinal}</span>
        <span className={`task-evidence-state st-${attempt.state}`}>
          {ATTEMPT_STATE_NOTE[attempt.state] ?? attempt.state}
        </span>
        {/* The failover, said as a sentence. Without it two attempts on two
            models look like a retry, and the reason the model changed — which
            is the thing worth knowing — is nowhere on the page. */}
        {evidence.recoveryFrom && (
          <span className="task-evidence-recovery">
            reseeded after attempt {evidence.recoveryFrom.ordinal} failed
          </span>
        )}
        {(attempt.failureClass || attempt.failureCode) && (
          <span className="task-evidence-failure">
            {[attempt.failureClass, attempt.failureCode].filter(Boolean).join(" / ")}
          </span>
        )}
      </div>

      {/* Loudest first, and deliberately above the route table. A tier served
          below the one this class of work asks for is what a reader would most
          want to know and least think to ask, and inside a ten-row grid of
          version strings it would never be seen. */}
      {selection?.degradedTier && (
        <div className="task-evidence-alert">
          This ran on a lower model tier than this kind of work asks for.
        </div>
      )}
      {selection?.caveat && (
        <div className="task-evidence-alert">{selection.caveat}</div>
      )}

      <dl className="task-evidence-route">
        {evidence.route.map((fact) => (
          <div className="task-evidence-fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.absent ? "is-absent" : ""}>{fact.value}</dd>
          </div>
        ))}
      </dl>

      {selection && (
        <div className="task-history-note">
          {/* Every route the policy actually considered, so "why this model" is
              answerable from the record instead of from someone's memory of
              what the fleet looked like at the time. */}
          {selection.eligible.length > 0
            ? `Considered ${selection.eligible.join(", ")}`
            : "No eligible routes were recorded for this attempt."}
          {selection.policy ? ` · policy ${selection.policy}` : ""}
        </div>
      )}

      <div className="task-evidence-block">
        <div className="task-history-section-head">
          Verification
          {verdict && (
            <span className={`task-evidence-verdict is-${verdict.outcome}`}>
              {verdict.outcome}
            </span>
          )}
        </div>
        {evidence.observations.length === 0 ? (
          <div className="task-history-note">
            No verification observation was recorded for this attempt.
          </div>
        ) : (
          <ul className="task-evidence-observations">
            {evidence.observations.map((observation, index) => (
              <li key={`${observation.kind}-${index}`}>
                <span className={`task-evidence-dot is-${observation.verdict}`} />
                <span className="task-evidence-kind">{observation.kind}</span>
                <span className={`task-evidence-verdict is-${observation.verdict}`}>
                  {VERDICT_TEXT[observation.verdict]}
                </span>
                <span className="task-evidence-note">{observation.note}</span>
                {observation.at > 0 && (
                  <span className="task-evidence-at">{when(observation.at)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {verdict && verdict.missing.length > 0 && (
          <div className="task-history-note">
            Never checked: {verdict.missing.join(", ")}.
          </div>
        )}
      </div>

      {checkpoint && (
        <div className="task-evidence-block">
          <div className="task-history-section-head">Checkpoint</div>
          <div className="task-history-note">
            {checkpoint.outcome === "saved"
              ? `Saved ${checkpoint.code === "explicit" ? "after you confirmed it" : "automatically"}${
                  checkpoint.commit ? ` as ${checkpoint.commit.slice(0, 12)}` : ""
                }.`
              : checkpoint.outcome === "held"
                ? "The policy allowed an automatic save; Canopy held it because no checkpoint has been observed working on this machine yet."
                : `Not saved automatically: ${
                    checkpoint.reasons.length > 0
                      ? checkpoint.reasons.join(", ")
                      : (checkpoint.code ?? "policy")
                  }.`}
            {checkpoint.paths.length > 0 &&
              ` ${checkpoint.paths.length} path${checkpoint.paths.length === 1 ? "" : "s"}.`}
          </div>
        </div>
      )}

      {failover && (
        <div className="task-evidence-block">
          <div className="task-history-section-head">Failover</div>
          <div className="task-history-note">
            {failover.action}
            {failover.reason ? ` — ${failover.reason}` : ""}
            {failover.failureClass ? ` (${failover.failureClass})` : ""}
          </div>
        </div>
      )}

      {evidence.artifacts.length > 0 && (
        <div className="task-evidence-block">
          <div className="task-history-section-head">
            Kept evidence
            <span className="task-history-section-count">
              {evidence.artifacts.length}
            </span>
          </div>
          {evidence.artifacts.map((artifact) => (
            <ArtifactView artifact={artifact} key={artifact.id} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface TaskEvidenceProps {
  /** The durable run this evidence belongs to — the task envelope's run id,
   *  which for every row in the history is the row's own id. */
  runId: string;
}

export function TaskEvidence({ runId }: TaskEvidenceProps) {
  const [evidence, setEvidence] = useState<TaskRunEvidence | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">(
    "loading",
  );
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setState("loading");
    void loadTaskEvidence(runId).then(
      (loaded) => {
        if (!live) return;
        setEvidence(loaded);
        setState(loaded ? "ready" : "missing");
      },
      (cause) => {
        if (!live) return;
        setError(String(cause));
        setState("error");
      },
    );
    return () => {
      live = false;
    };
  }, [runId]);

  if (state === "loading") {
    return (
      <div className="task-history-section">
        <div className="task-history-section-head">Evidence</div>
        <div className="task-history-note">Reading the durable record…</div>
      </div>
    );
  }
  if (state !== "ready" || !evidence) {
    return (
      <div className="task-history-section">
        <div className="task-history-section-head">Evidence</div>
        <div className="task-history-note">
          {state === "missing"
            ? "This run has no durable record left — it was imported, or the envelope was removed."
            : `The durable record could not be read: ${error}`}
        </div>
      </div>
    );
  }

  return (
    <div className="task-history-section task-evidence">
      <div className="task-history-section-head">
        {evidence.attempts[0] && (
          <AgentIcon id={evidence.attempts[0].attempt.route.cli} size={11} />
        )}
        Evidence
        <span className="task-history-section-count">
          {evidence.attempts.length} attempt
          {evidence.attempts.length === 1 ? "" : "s"}
        </span>
      </div>

      {evidence.attempts.length === 0 ? (
        <div className="task-history-note">
          This run recorded no attempt, so there is nothing it can show.
        </div>
      ) : (
        evidence.attempts.map((attempt) => (
          <Attempt evidence={attempt} key={attempt.attempt.attemptId} />
        ))
      )}

      {/* Canopy's own transcript, not the CLI's. It is the copy that survives
          the session being forgotten, which is the only reason it is written. */}
      {evidence.transcript.length > 0 && (
        <details className="task-history-fold task-evidence-transcript">
          <summary className="task-history-section-head">
            <span className="task-history-caret">›</span>
            Transcript
            <span className="task-history-section-count">
              {evidence.transcript.length} entries
            </span>
          </summary>
          <ol className="task-evidence-lines">
            {evidence.transcript.map((entry) => (
              <li key={entry.seq}>
                <span className={`task-evidence-kind is-${entry.kind}`}>
                  {entry.kind}
                </span>
                <span className="task-evidence-body">{entry.body}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** Opened lazily by TaskHistoryView: mounting this fetches three IPC calls, and
 *  doing that for twenty-five collapsed rows would be twenty-five round trips
 *  for a panel nobody has opened. */
export function TaskEvidenceFold({ runId }: TaskEvidenceProps) {
  const [open, setOpen] = useState(false);
  return open ? (
    <TaskEvidence runId={runId} />
  ) : (
    <div className="task-history-section">
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Show what was verified
      </Button>
    </div>
  );
}

// A plan, on one screen: the goal, the decisions the agent would otherwise
// guess, what it expects to touch, how we will know it worked, and what it
// will not do.
//
// Three modes. "approval": the person answers each decision (pick an option or
// write their own), edits the acceptance checks, and approves — the agent then
// starts with exactly this in its brief. "inline": a small low-risk plan the
// agent already started from, shown read-only. "view": a plan read back later
// (the review surface).
//
// Plain language throughout: a PM or designer approving a plan should never
// need to read code to do it.
import { useState } from "react";
import { statusLabel, type PlanData, type PlanDecision } from "../plans/plan";
import { Button } from "./ui";
import "./plans.css";

export interface PlanCardProps {
  plan: PlanData;
  mode: "approval" | "inline" | "view";
  status?: string;
  onApprove?: (edits: { decisions: PlanDecision[]; acceptance: string[] }) => void | Promise<void>;
  onDrop?: () => void;
  onShare?: () => void;
  /** Step the approval dialog aside and keep the agent waiting. */
  onWait?: () => void;
}

const OWN = "__own__";

const RISK_LABEL: Record<PlanData["risk"], string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};
const SIZE_LABEL: Record<PlanData["size"], string> = { tiny: "Tiny", small: "Small", large: "Large" };

export function PlanCard({ plan, mode, status, onApprove, onDrop, onShare, onWait }: PlanCardProps) {
  const editable = mode === "approval";
  // Each decision starts on its recommendation so approving is one click when
  // the brain guessed right — but the choice is on screen, not hidden.
  const [choice, setChoice] = useState<string[]>(() =>
    plan.decisions.map((d) => {
      const a = d.answer ?? d.recommended;
      return !a || d.options.includes(a) ? a : OWN;
    }),
  );
  const [own, setOwn] = useState<string[]>(() =>
    plan.decisions.map((d) => {
      const a = d.answer ?? d.recommended;
      return a && !d.options.includes(a) ? a : "";
    }),
  );
  const [checks, setChecks] = useState<string[]>(() => [...plan.acceptance]);
  const [busy, setBusy] = useState(false);

  const answers = plan.decisions.map((_, i) => (choice[i] === OWN ? own[i].trim() : choice[i]));
  const open = answers.filter((a) => !a).length;

  const approve = async () => {
    if (!onApprove || open) return;
    setBusy(true);
    try {
      await onApprove({
        decisions: plan.decisions.map((d, i) => ({ ...d, answer: answers[i] })),
        acceptance: checks.map((c) => c.trim()).filter(Boolean),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="plan-card" aria-label="Plan">
      <header className="plan-card-head">
        <span className="plan-card-kind">Plan</span>
        <span className={`plan-chip is-${plan.risk}`}>{RISK_LABEL[plan.risk]}</span>
        <span className="plan-chip">{SIZE_LABEL[plan.size]}</span>
        <span className="plan-chip" title="What kind of work this is — the review's track record is kept per kind">
          {plan.taskClass}
        </span>
        {status && <span className="plan-card-status">{statusLabel(status)}</span>}
      </header>
      <p className="plan-card-goal">{plan.goal}</p>
      {mode === "approval" && plan.gateWhy.length > 0 && (
        <p className="plan-card-why">Needs your approval: {plan.gateWhy.join(", ")}.</p>
      )}

      {plan.decisions.length > 0 && (
        <div className="plan-card-section">
          <h4>Decisions</h4>
          {plan.decisions.map((d, i) => (
            <fieldset key={i} className="plan-decision">
              <legend>
                {d.question}
                {d.source === "mid-run" && <span className="plan-chip">asked while working</span>}
              </legend>
              {editable ? (
                <>
                  {d.options.map((o) => (
                    <label key={o} className="plan-option">
                      <input
                        type="radio"
                        name={`${plan.planId}-d${i}`}
                        checked={choice[i] === o}
                        onChange={() => setChoice((c) => c.map((x, j) => (j === i ? o : x)))}
                      />
                      <span>{o}</span>
                      {o === d.recommended && <span className="plan-rec">recommended</span>}
                    </label>
                  ))}
                  <label className="plan-option">
                    <input
                      type="radio"
                      name={`${plan.planId}-d${i}`}
                      checked={choice[i] === OWN}
                      onChange={() => setChoice((c) => c.map((x, j) => (j === i ? OWN : x)))}
                    />
                    <input
                      type="text"
                      className="plan-own"
                      aria-label={`Your own answer: ${d.question}`}
                      placeholder="Something else…"
                      value={own[i]}
                      onFocus={() => setChoice((c) => c.map((x, j) => (j === i ? OWN : x)))}
                      onChange={(e) => {
                        const v = e.target.value;
                        setOwn((list) => list.map((x, j) => (j === i ? v : x)));
                        setChoice((c) => c.map((x, j) => (j === i ? OWN : x)));
                      }}
                    />
                  </label>
                  {d.why && <small className="plan-why">{d.why}</small>}
                </>
              ) : (
                <p className="plan-answer">
                  → {d.answer || d.recommended || "Undecided"}
                  {d.why && <small className="plan-why"> — {d.why}</small>}
                </p>
              )}
            </fieldset>
          ))}
        </div>
      )}

      <div className="plan-card-section">
        <h4>Done when</h4>
        {editable ? (
          <>
            {checks.map((c, i) => (
              <div key={i} className="plan-check-row">
                <input
                  type="text"
                  aria-label={`Acceptance check ${i + 1}`}
                  value={c}
                  onChange={(e) => {
                    const v = e.target.value;
                    setChecks((list) => list.map((x, j) => (j === i ? v : x)));
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove check ${i + 1}`}
                  onClick={() => setChecks((list) => list.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setChecks((list) => [...list, ""])}>
              + Add a check
            </Button>
          </>
        ) : plan.acceptance.length ? (
          <ul>
            {plan.acceptance.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        ) : (
          <p className="plan-why">No checks were set.</p>
        )}
      </div>

      {plan.touches.length > 0 && (
        <div className="plan-card-section">
          <h4>Expected to touch</h4>
          <p className="plan-touches">{plan.touches.join(" · ")}</p>
        </div>
      )}
      {plan.wontDo.length > 0 && (
        <div className="plan-card-section">
          <h4>Won't do</h4>
          <ul>
            {plan.wontDo.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {(editable || onShare) && (
        <footer className="plan-card-actions">
          {editable && (
            <Button variant="accent" disabled={busy || open > 0} onClick={() => void approve()}>
              {busy ? "Starting…" : open > 0 ? `Answer ${open} more` : "Approve & start"}
            </Button>
          )}
          {onShare && (
            <Button onClick={onShare} title="Post this plan in team chat for comments and approval">
              Share plan to team
            </Button>
          )}
          {editable && onWait && (
            <Button variant="ghost" onClick={onWait} title="Keep the agent waiting for approval without holding the screen">
              Wait for approval
            </Button>
          )}
          {editable && onDrop && (
            <Button variant="ghost" onClick={onDrop}>
              Don't start
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}

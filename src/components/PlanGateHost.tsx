// Where the dispatch gate (plans/planGate.ts) shows up: a small stack in the
// corner for "Planning…", plans that started inline, and "started without a
// plan" notes; and a dialog for a plan that waits for approval.
//
// Mounted once per window (ProjectView). It renders nothing until work is
// dispatched.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  approvePlan,
  dismissGateItem,
  dropPlan,
  planGateItems,
  skipPlanning,
  subscribePlanGate,
  type GateItem,
} from "../plans/planGate";
import { sharePlan } from "../plans/planShare";
import { PlanCard } from "./PlanCard";
import { Button } from "./ui";
import "./plans.css";

/** How long an inline plan stays in the corner unless opened. */
const INLINE_MS = 20_000;

export function PlanGateHost() {
  const items = useSyncExternalStore(subscribePlanGate, planGateItems, planGateItems);
  const approval = items.find((i): i is Extract<GateItem, { phase: "approval" }> => i.phase === "approval");
  const corner = items.filter((i) => i.phase !== "approval");
  if (!items.length) return null;
  return (
    <>
      {corner.length > 0 && (
        <div className="plan-gate-stack" aria-live="polite">
          {corner.map((item) => (
            <CornerItem key={item.id} item={item} />
          ))}
        </div>
      )}
      {approval && (
        <div className="confirm-backdrop">
          <div
            className="confirm plan-gate-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Approve the plan before the agent starts"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="ask-from">Before the agent starts{approval.req.label ? ` · ${approval.req.label}` : ""}</p>
            <PlanCard
              plan={approval.entry.data}
              mode="approval"
              status={approval.entry.status}
              onApprove={(edits) => approvePlan(approval.id, edits)}
              onDrop={() => dropPlan(approval.id)}
              onShare={() => sharePlan(approval.entry.data)}
            />
          </div>
        </div>
      )}
    </>
  );
}

function CornerItem({ item }: { item: Exclude<GateItem, { phase: "approval" }> }) {
  const [open, setOpen] = useState(false);
  // Inline plans leave on their own unless the person opened one to read it.
  useEffect(() => {
    if (item.phase !== "inline" || open) return;
    const t = window.setTimeout(() => dismissGateItem(item.id), INLINE_MS);
    return () => window.clearTimeout(t);
  }, [item.phase, item.id, open]);

  if (item.phase === "planning")
    return (
      <div className="plan-gate-item" role="status">
        <span className="plan-gate-spinner" aria-hidden="true" />
        <span className="plan-gate-text">Planning{item.req.label ? ` “${item.req.label}”` : ""}…</span>
        <Button size="sm" variant="ghost" onClick={() => skipPlanning(item.id)}>
          Start without a plan
        </Button>
      </div>
    );
  if (item.phase === "note")
    return (
      <div className="plan-gate-item" role="status">
        <span className="plan-gate-text">{item.message}</span>
        <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => dismissGateItem(item.id)}>
          ×
        </Button>
      </div>
    );
  return (
    <div className={`plan-gate-item${open ? " is-open" : ""}`}>
      <div className="plan-gate-row">
        <span className="plan-gate-text">
          <strong>Started with a plan:</strong> {item.entry.data.goal}
        </span>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show plan"}
        </Button>
        <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => dismissGateItem(item.id)}>
          ×
        </Button>
      </div>
      {open && <PlanCard plan={item.entry.data} mode="inline" onShare={() => sharePlan(item.entry.data)} />}
    </div>
  );
}

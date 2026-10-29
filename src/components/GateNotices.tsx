// Blocked-action cards, shown over the agent's own terminal: "Canopy blocked:
// … [Allow once] [Edit rule]", and for an irreversible action the approval
// itself — "[Approve once] [Deny]". The decisions come from canopy-hook; see
// src/gates/events.ts for how they arrive and what each button does.
import { useState } from "react";
import {
  actionText,
  allowOnce,
  denyNotice,
  dismissNotice,
  leadFinding,
  noticeTitle,
  type GateNotice,
} from "../gates/events";
import { useGateNotices, visibleNotices } from "../gates/useGateNotices";
import { Button } from "./ui";
import "./gates.css";

interface Props {
  ptyId: number | null | undefined;
  /** Open the Rules panel, on the rule that fired when there is one. */
  onEditRule?: (ruleId?: string) => void;
}

export function GateNotices({ ptyId, onEditRule }: Props) {
  const shown = visibleNotices(useGateNotices(), ptyId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (shown.length === 0) return null;

  const approve = async (n: GateNotice) => {
    setBusy(n.id);
    setError(null);
    try {
      await allowOnce(n);
    } catch (e) {
      setError(`Couldn't record the approval: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gate-notices" role="region" aria-label="Actions Canopy stopped">
      {shown.map((n) => {
        const f = leadFinding(n.stamp);
        const ask = n.stamp.status === "needs-approval";
        return (
          <div
            key={n.id}
            className={`gate-notice ${ask ? "gate-notice-ask" : "gate-notice-block"}`}
            role={ask ? "alertdialog" : "status"}
            aria-label={noticeTitle(n.stamp)}
          >
            <div className="gate-notice-title">{noticeTitle(n.stamp)}</div>
            <code className="gate-notice-action" title={n.stamp.action}>
              {actionText(n.stamp)}
            </code>
            <div className="gate-notice-actions">
              {ask && (
                <>
                  <Button size="sm" variant="danger" disabled={busy === n.id} onClick={() => void approve(n)}>
                    Approve once
                  </Button>
                  <Button size="sm" onClick={() => denyNotice(n)}>
                    Deny
                  </Button>
                </>
              )}
              {n.stamp.status === "blocked" && (
                <Button size="sm" disabled={busy === n.id} onClick={() => void approve(n)}>
                  Allow once
                </Button>
              )}
              {f?.kind === "rule" && onEditRule && (
                <Button size="sm" variant="ghost" onClick={() => onEditRule(f.ruleId)}>
                  Edit rule
                </Button>
              )}
              {!ask && (
                <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => dismissNotice(n)}>
                  ×
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {error && <div className="gate-notice-error">{error}</div>}
    </div>
  );
}

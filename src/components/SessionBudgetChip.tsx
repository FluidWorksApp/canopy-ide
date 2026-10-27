// The budget control in an agent tab's header, beside its cost: "$3.20 / $5"
// that turns amber at 80% and red at 100% (when the agent is paused), and a
// click to set or raise the budget. See outcomes/budgets.ts for where budgets
// come from and how the pause works.
import { useState } from "react";
import { getSettings } from "../settings";
import {
  budgetLevel,
  fmtUsd,
  resolveBudget,
  sessionBudget,
  setSessionBudget,
  useSessionBudget,
  type ResolvedBudget,
} from "../outcomes/budgets";
import "./OutcomesPanel.css";

const SOURCE_TEXT: Record<ResolvedBudget["source"], string> = {
  session: "set on this session",
  plan: "from its plan",
  default: "the default session budget (Settings)",
  prototype: "the prototype session cap (Settings)",
};

export function SessionBudgetChip({ sessionId, cost }: { sessionId: string; cost: number | null }) {
  const monitored = useSessionBudget(sessionId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [, setVersion] = useState(0);

  // The monitor knows the plan and prototype budgets; before it has seen a
  // turn from this session, fall back to what the tab can know by itself.
  const s = getSettings();
  const budget =
    monitored?.budget ??
    resolveBudget({
      session: sessionBudget(sessionId),
      isPrototype: false,
      defaultUsd: s.sessionBudgetUsd,
      prototypeCapUsd: null,
    });
  const spent = Math.max(cost ?? 0, monitored?.costUsd ?? 0);
  const level = budgetLevel(spent, budget);

  const commit = () => {
    const usd = Number(draft.replace(/[$\s]/g, ""));
    setSessionBudget(sessionId, draft.trim() === "" ? null : Number.isFinite(usd) && usd > 0 ? usd : sessionBudget(sessionId));
    setEditing(false);
    setVersion((v) => v + 1);
  };

  if (editing) {
    return (
      <span className="budget-chip">
        <input
          className="budget-chip-input"
          aria-label="Session budget in dollars (empty for none)"
          autoFocus
          inputMode="decimal"
          placeholder="$5"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      </span>
    );
  }

  const title = budget
    ? `${fmtUsd(spent)} of a ${fmtUsd(budget.usd)} budget, ${SOURCE_TEXT[budget.source]}. ` +
      (level === "over"
        ? "Over budget: Canopy pauses the agent. Raise the budget, then tell it to continue."
        : "Warns at 80%, pauses at 100%. Click to change.")
    : 'No budget. Click to set one, or write "Budget $5" in a prompt.';

  return (
    <span className={`budget-chip is-${level}`}>
      <button
        type="button"
        className="budget-chip-btn"
        title={title}
        aria-label={budget ? `Budget: ${fmtUsd(spent)} of ${fmtUsd(budget.usd)}${level === "over" ? ", over budget" : ""}. Change` : "Set a budget"}
        onClick={() => {
          setDraft(budget ? String(budget.usd) : "");
          setEditing(true);
        }}
      >
        {budget ? (
          <>
            {level === "over" ? "Over budget " : ""}
            {fmtUsd(spent)} / {fmtUsd(budget.usd)}
          </>
        ) : (
          "Budget"
        )}
      </button>
    </span>
  );
}

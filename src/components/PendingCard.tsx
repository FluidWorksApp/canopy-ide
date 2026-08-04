// One thing an agent is waiting on you for: a question, a permission prompt, or
// a finished turn.
//
// Lifted out of AgentsPanel so the agents page can offer the same card. The
// answering rules are the fiddly part — which forms can be driven by
// synthesised keystrokes and which have to be answered in the terminal — and
// they are the last thing that should exist in two copies: a page that offered
// a Submit button for a form the panel knew it couldn't fill would type into
// the wrong pane and record a decline.
import { useState } from "react";
import { Mascot } from "./Mascot";
import type { PendingItem } from "../notifications";
import { Button } from "./ui";

/** CLIs whose approval prompt is a numbered/Escape menu we can drive by
 *  synthesising keystrokes. Anything else gets "answer in terminal" instead of
 *  buttons that might type into the wrong UI. */
const KEYSTROKE_APPROVAL_AGENTS = new Set(["claude", "codex"]);

export interface PendingCardProps {
  item: PendingItem;
  /** Answer a questionnaire. `selections[q]` is the option index(es) chosen for
   *  question q. The backend synthesises the keystrokes. */
  onAnswer?: (item: PendingItem, selections: number[][]) => void;
  /** Approve types the accept key into the agent's terminal, deny sends
   *  Escape. Only offered for numbered-prompt CLIs. */
  onRespond?: (item: PendingItem, decision: "approve" | "deny") => void;
  onJumpToTerminal?: (item: PendingItem) => void;
  onDismiss?: (key: string) => void;
  /** Extra class for the surface's own density. */
  className?: string;
}

export function PendingCard({
  item,
  onAnswer,
  onRespond,
  onJumpToTerminal,
  onDismiss,
  className = "",
}: PendingCardProps) {
  // Selections for a multi-step questionnaire; picks[questionIndex] is the
  // option index(es) chosen. A lone single-select question answers on the click
  // and never lands here.
  const [picks, setPicks] = useState<number[][]>(() =>
    (item.questions ?? []).map(() => [] as number[]),
  );
  const choose = (qi: number, oi: number, multi: boolean) =>
    setPicks((prev) => {
      const cur = prev.map((a) => [...a]);
      cur[qi] = multi
        ? cur[qi].includes(oi)
          ? cur[qi].filter((x) => x !== oi)
          : [...cur[qi], oi]
        : [oi];
      return cur;
    });
  const answerable = (item.questions ?? []).every((_, qi) => (picks[qi]?.length ?? 0) > 0);
  // A single single-select question answers on the option click itself; a
  // multi-select (still one page) collects picks and submits together. A
  // multi-question form is a different beast: answering it means navigating
  // between pages, and driving that by synthesised keystrokes desyncs and the
  // CLI records "declined". Until Canopy answers questions over the programmatic
  // channel (headless `canUseTool`) rather than the TUI, a multi-page form is
  // answered in the terminal — the card points there instead of miscounting.
  const instant = (item.questions?.length ?? 0) === 1 && !item.questions?.[0]?.multiSelect;
  const multiPage = (item.questions?.length ?? 0) > 1;
  const inPanel = !!onAnswer && !multiPage;
  const idle = item.kind === "idle";

  return (
    <div
      className={`pending-card ${idle ? "pending-card-idle" : ""} ${className}`}
      onClick={() => onJumpToTerminal?.(item)}
      title="Open the terminal running this agent"
    >
      {item.kind === "question" ? (
        <>
          {(item.questions ?? []).map((q, i) => {
            const sel = picks[i] ?? [];
            return (
              <div key={i} className="pending-question">
                {q.header && <span className="pending-chip">{q.header}</span>}
                <div className="pending-q-text">{q.question}</div>
                <div className="pending-options">
                  {q.options.map((o, oi) => {
                    const chosen = sel.includes(oi);
                    const mark = q.multiSelect
                      ? chosen
                        ? "☑"
                        : "☐"
                      : chosen
                        ? "◉"
                        : "○";
                    return (
                      <div
                        key={o.label}
                        className={`pending-option ${inPanel ? "pending-option-clickable" : ""} ${
                          chosen ? "pending-option-chosen" : ""
                        }`}
                        title={inPanel ? "Select this option" : "Answer in the terminal"}
                        onClick={
                          inPanel
                            ? (e) => {
                                e.stopPropagation();
                                if (instant) onAnswer!(item, [[oi]]);
                                else choose(i, oi, !!q.multiSelect);
                              }
                            : undefined
                        }
                      >
                        <span className="pending-option-label">
                          {mark} {o.label}
                        </span>
                        {o.description && (
                          <span className="pending-option-desc">{o.description}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {/* A single-page multi-select submits its picks as one keystroke
              sequence (no page navigation to desync). A lone single-select
              answered on click above, so it shows no button. */}
          {inPanel && !instant && (
            <Button
              variant="accent"
              className="pending-submit"
              disabled={!answerable}
              title={
                answerable ? "Send this answer to the terminal" : "Choose an option first"
              }
              onClick={(e) => {
                e.stopPropagation();
                onAnswer!(item, picks);
              }}
            >
              Submit answer
            </Button>
          )}
          {onAnswer && multiPage && (
            <Button
              className="pending-submit"
              title="Multi-question forms are answered in the terminal"
              onClick={(e) => {
                e.stopPropagation();
                onJumpToTerminal?.(item);
              }}
            >
              Answer in the terminal ↗
            </Button>
          )}
        </>
      ) : (
        <>
          <div className="pending-q-text">
            <Mascot state={idle ? "done" : "needs"} size={16} className="pending-ash" />
            {item.message}
          </div>
          {/* Respond without leaving the surface: Allow types the accept key,
              Deny sends Escape. Only for CLIs whose prompt we can drive by
              keystroke — the rest fall back to the terminal. */}
          {!idle && onRespond && KEYSTROKE_APPROVAL_AGENTS.has(item.agent) && (
            <div className="pending-respond">
              <button
                className="pending-approve"
                title="Allow — types the accept key into the terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  onRespond(item, "approve");
                }}
              >
                ✓ Allow
              </button>
              <button
                className="pending-deny"
                title="Deny — sends Escape to the terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  onRespond(item, "deny");
                }}
              >
                ✕ Deny
              </button>
            </div>
          )}
        </>
      )}
      <div className="pending-footer">
        <span className="event-time">{new Date(item.ts).toLocaleTimeString()}</span>
        <span className="pending-jump">{idle ? "open terminal ➜" : "answer in terminal ➜"}</span>
        {onDismiss && (
          <Button
            icon
            size="sm"
            className="pending-dismiss"
            title="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(item.key);
            }}
          >
            ✕
          </Button>
        )}
      </div>
    </div>
  );
}

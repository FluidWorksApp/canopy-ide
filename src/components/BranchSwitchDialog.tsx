// The dialog a refused branch switch opens. It renders a model built by
// branchSwitch.ts and reports the chosen action back — it decides nothing
// itself, which is what keeps the wording and the git handling testable apart
// from each other.
//
// Every dialog here ends in an action, including "Cancel": the point of the
// feature is that a branch switch never dead-ends in git's stderr.
import type { SwitchAction, SwitchDialog } from "../branchSwitch";

export function BranchSwitchDialog({
  dialog,
  busy,
  onChoose,
}: {
  dialog: SwitchDialog;
  /** A choice is running; the buttons stay visible but stop taking clicks. */
  busy: boolean;
  onChoose: (action: SwitchAction) => void;
}) {
  const leadIndex = dialog.choices.findIndex((c) => c.recommended && !c.disabled);
  return (
    <div className="confirm-backdrop" onClick={() => !busy && onChoose("cancel")}>
      <div className="confirm branch-switch" onClick={(e) => e.stopPropagation()}>
        <p className="branch-switch-title">{dialog.title}</p>
        <p className="branch-switch-body">{dialog.body}</p>
        <div className="branch-switch-choices">
          {dialog.choices.map((c, i) => (
            <button
              // Same contract as the shared Dialog: the recommended choice holds
              // focus, so Enter takes it and Escape (owned by the caller) backs
              // out. Every choice here is safe — the destructive ones are what
              // this dialog exists to talk you out of.
              autoFocus={i === leadIndex}
              // Keyed by position, not by action: a question built with
              // askDialog can legitimately offer the same action twice.
              key={`${c.action}-${i}`}
              className={`branch-switch-choice ${
                c.recommended ? "branch-switch-choice-lead" : ""
              }`}
              disabled={c.disabled || busy}
              onClick={() => onChoose(c.action)}
            >
              <span className="branch-switch-choice-label">{c.label}</span>
              {c.sub && <span className="branch-switch-choice-sub">{c.sub}</span>}
            </button>
          ))}
        </div>
        {dialog.detail && (
          // Folded away, never gone: the git-level text is what a developer
          // wants on the third read and nobody wants on the first.
          <details className="branch-switch-detail">
            <summary>Details</summary>
            <pre>{dialog.detail}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

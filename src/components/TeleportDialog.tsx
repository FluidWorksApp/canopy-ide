// The compact dialog for moving an agent to another machine (mock: Teleport).
// Like setting up a remote environment: what comes along is a checklist with
// everything ticked except what looks like a secret, one linear step bar shows
// progress, and nothing here decides anything: the caller runs the move
// (src/teleport/sessionMove.ts) and reports the step back.
import { Dialog } from "./Dialog";
import { Checkbox } from "./ui";
import { MOVE_STEPS, type MoveStep } from "../teleport/sessionMove";
import { stepState, toggled, type TeleportItem, type TeleportProgress } from "../teleport/selection";

const STEP_LABEL: Record<MoveStep, string> = {
  prepare: "Prepare",
  send: "Send",
  apply: "Apply",
  resume: "Resume",
};

export function TeleportDialog({
  destinationName,
  agentLabel,
  items,
  selected,
  onSelectedChange,
  reasons,
  progress,
  onTeleport,
  onCancel,
}: {
  destinationName: string;
  /** One line: the agent, its branch and project. */
  agentLabel: string;
  items: readonly TeleportItem[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Why the move cannot start; non-empty disables Teleport. */
  reasons: readonly string[];
  /** Null before the move starts. */
  progress: TeleportProgress | null;
  onTeleport: () => void;
  onCancel: () => void;
}) {
  const running = progress !== null && !progress.failed && !(progress.step === "resume" && progress.fraction === 1);
  const blocked = reasons.length > 0;
  return (
    <Dialog
      title={`Teleport to ${destinationName}`}
      size="md"
      meta={agentLabel}
      dismissLabel={running ? "Cancel move" : "Close"}
      onDismiss={onCancel}
      actions={[
        {
          label: progress?.failed ? "Try again" : "Teleport",
          primary: true,
          disabled: blocked || running,
          onClick: onTeleport,
        },
      ]}
      body={
        <div className="tp">
          {blocked && (
            <ul className="tp-reasons" role="alert">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <p className="tp-head">BRINGING ALONG</p>
          <ul className="tp-list">
            {items.map((item) => (
              <li key={item.id} className="tp-item">
                <Checkbox
                  checked={item.required || selected.has(item.id)}
                  disabled={item.required || running}
                  onChange={() => onSelectedChange(toggled(items, selected, item.id))}
                  label={item.label}
                  hint={item.secret ? "looks like a secret" : undefined}
                />
                {item.detail && <span className="tp-detail">{item.detail}</span>}
              </li>
            ))}
          </ul>
          <ol className="tp-steps" aria-label="Progress">
            {MOVE_STEPS.map((step, i) => {
              const state = stepState(step, progress);
              return (
                <li key={step} className={`tp-step tp-step-${state}`} aria-current={state === "now" ? "step" : undefined}>
                  <span className="tp-dot">{state === "done" ? "✓" : i + 1}</span>
                  <span className="tp-step-label">
                    {STEP_LABEL[step]}
                    {state === "now" && progress?.fraction != null && progress.fraction < 1 ? ` ${Math.round(progress.fraction * 100)}%` : ""}
                  </span>
                </li>
              );
            })}
          </ol>
          {progress?.failed && (
            <p className="tp-error" role="alert">
              {progress.failed}
            </p>
          )}
        </div>
      }
    />
  );
}

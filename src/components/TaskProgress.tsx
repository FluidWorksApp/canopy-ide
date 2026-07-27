// The rail a one-shot agent's milestones move along. A micro-task runs in a
// terminal that closes itself, so from the tab's side it is a black box: the old
// "an agent is on it" said exactly as much at minute four as it did at second
// one, which is why a run that had quietly died looked identical to one that was
// working. The task reports each milestone as it lands (see PR_REVIEW_STEPS) and
// this draws them — a bar for how far along, chips for what each step was.
import type { TaskStep } from "../microTasks";

interface Props {
  /** The milestones, in order. */
  steps: readonly TaskStep[];
  /** Ids the task has reported finished. */
  done: string[];
  /** Still running — drives the in-flight step and the sweep on the bar. */
  active: boolean;
  /** What the agent is doing, in three words. */
  title: string;
  /** How long it has been going, already formatted. */
  elapsed?: string;
}

export function TaskProgress({ steps, done, active, title, elapsed }: Props) {
  const finished = new Set(done);
  // The step in flight is the first one not reported yet — and only while the
  // task is alive. A dead run showing a pulsing "Finding problems" would be the
  // same lie the spinner told.
  const doingAt = active ? steps.findIndex((s) => !finished.has(s.id)) : -1;
  const pct = steps.length ? (finished.size / steps.length) * 100 : 0;
  const seg = steps.length ? 100 / steps.length : 0;

  return (
    <div className="task-progress" role="group" aria-label={title}>
      <div className="task-progress-head">
        <span className="task-progress-title">{title}</span>
        {elapsed && <span className="task-progress-time">{elapsed}</span>}
      </div>
      <div
        className="task-bar"
        style={{ "--p": `${pct}%`, "--seg": `${seg}%` } as React.CSSProperties}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={finished.size}
      >
        <span className="task-bar-fill" />
        {active && doingAt >= 0 && <span className="task-bar-live" />}
      </div>
      <ol className="task-steps">
        {steps.map((s, i) => {
          const state = finished.has(s.id) ? "done" : i === doingAt ? "doing" : "todo";
          return (
            <li key={s.id} className={`task-step is-${state}`}>
              <span className="task-step-dot" aria-hidden="true">
                {state === "done" ? "✓" : ""}
              </span>
              {/* Past tense once it's behind you: a rail that still says
                  "Reading the change" three steps later reads as stuck. */}
              <span className="task-step-label">{state === "done" ? s.done : s.doing}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

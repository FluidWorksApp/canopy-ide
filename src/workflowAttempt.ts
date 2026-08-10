import type { TaskEnvelopeDetail, TaskAttemptState } from "./taskEnvelope";
import { taskGetForAttempt, TASK_ENVELOPES_EVENT } from "./taskEnvelopes";

const SETTLED = new Set<TaskAttemptState>([
  "completed",
  "failed",
  "blocked",
  "interrupted",
  "cancelled",
]);

export interface WorkflowAttemptResult {
  ok: boolean;
  state: TaskAttemptState;
  failureText?: string;
}

interface WorkflowAttemptDeps {
  read(attemptId: string): Promise<TaskEnvelopeDetail | null>;
  subscribe(listener: () => void): () => void;
}

const DEFAULT_DEPS: WorkflowAttemptDeps = {
  read: taskGetForAttempt,
  subscribe: (listener) => {
    window.addEventListener(TASK_ENVELOPES_EVENT, listener);
    return () => window.removeEventListener(TASK_ENVELOPES_EVENT, listener);
  },
};

const attemptState = (detail: TaskEnvelopeDetail | null, attemptId: string) =>
  detail?.attempts.find((attempt) => attempt.attemptId === attemptId)?.state ?? null;

/** Resolve when the managed task attempt backing a workflow step settles.
 * Store pulses drive the reads; subscribing before the first read closes the
 * launch/subscribe race for very short tasks. */
export function waitForWorkflowAttempt(
  attemptId: string,
  deps: WorkflowAttemptDeps = DEFAULT_DEPS,
): Promise<WorkflowAttemptResult> {
  return new Promise((resolve, reject) => {
    let reading = false;
    let done = false;
    let unsubscribe = () => {};

    const read = async () => {
      if (reading || done) return;
      reading = true;
      try {
        const state = attemptState(await deps.read(attemptId), attemptId);
        if (!state || !SETTLED.has(state)) return;
        done = true;
        unsubscribe();
        resolve({
          ok: state === "completed",
          state,
          failureText: state === "completed" ? undefined : `workflow task attempt ${state}`,
        });
      } catch (error) {
        done = true;
        unsubscribe();
        reject(error);
      } finally {
        reading = false;
      }
    };

    unsubscribe = deps.subscribe(() => { void read(); });
    void read();
  });
}

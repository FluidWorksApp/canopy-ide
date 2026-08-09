import { useEffect, useState } from "react";
import {
  cachedWorkflowRuns,
  refreshWorkflowRuns,
  workflowGet,
  WORKFLOW_RUNS_EVENT,
} from "../workflowRuns";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../workflowRun";

export function WorkflowRunsFold({ projectId }: { projectId: string }) {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>(() =>
    cachedWorkflowRuns(projectId),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void refreshWorkflowRuns(projectId).then((rows) => {
        if (current) setRuns(rows);
      });
    };
    const changed = (event: Event) => {
      const change = (event as CustomEvent<{ projectId: string }>).detail;
      if (change?.projectId === projectId) refresh();
    };
    refresh();
    window.addEventListener(WORKFLOW_RUNS_EVENT, changed);
    return () => {
      current = false;
      window.removeEventListener(WORKFLOW_RUNS_EVENT, changed);
    };
  }, [projectId]);

  const open = (runId: string) => {
    if (selected === runId) {
      setSelected(null);
      setDetail(null);
      return;
    }
    setSelected(runId);
    setDetail(null);
    void workflowGet(runId).then((value) => {
      setDetail((current) => (selected === runId && current ? current : value));
    });
  };

  return (
    <details className="task-history-fold workflow-runs-fold">
      <summary>
        <span className="task-history-caret">›</span>
        Workflow runs
        <span className="task-history-section-count">{runs.length}</span>
      </summary>
      {runs.length === 0 ? (
        <div className="task-history-note">No workflow has run in this project yet.</div>
      ) : (
        <div role="list" aria-label="Workflow runs">
          {runs.map((run) => {
            const expanded = selected === run.runId;
            const runDetail = expanded && detail?.runId === run.runId ? detail : null;
            return (
              <div className={`task-history-row ${expanded ? "is-open" : ""}`} key={run.runId}>
                <button
                  type="button"
                  className="task-history-summary"
                  aria-expanded={expanded}
                  onClick={() => open(run.runId)}
                >
                  <span className={`task-history-mark st-${run.status}`} aria-hidden>◆</span>
                  <span className="task-history-body">
                    <span className="task-history-line">
                      <span className="task-history-label">{run.definitionId}</span>
                      <span className="task-history-state">{run.status}</span>
                    </span>
                    <span className="task-history-said">
                      {run.currentStepId
                        ? `Current step: ${run.currentStepId}`
                        : `Triggered by ${run.triggerKind}`}
                    </span>
                  </span>
                </button>
                {expanded && runDetail && (
                  <div className="task-history-detail">
                    <div className="task-history-section">
                      <div className="task-history-section-head">Steps</div>
                      {runDetail.steps.map((step) => (
                        <div className="task-history-line" key={step.id}>
                          <span className="task-history-label">{step.id}</span>
                          <span className="task-history-state">{step.state}</span>
                          {step.attemptIds.length > 0 && (
                            <span className="task-history-chiplet">
                              {step.attemptIds.length} attempt{step.attemptIds.length === 1 ? "" : "s"} recorded
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
}

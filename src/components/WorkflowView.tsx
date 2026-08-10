import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui";
import {
  loadWorkflowDefinitions,
  type WorkflowDefinition,
} from "../workflowDefinition";
import {
  cachedWorkflowRuns,
  refreshWorkflowRuns,
  workflowGet,
  WORKFLOW_RUNS_EVENT,
} from "../workflowRuns";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../workflowRun";

interface WorkflowViewProps {
  projectId: string;
  projectName: string;
  projectRoot: string;
  componentRoots: string[];
  onRun: (definition: WorkflowDefinition) => Promise<void> | void;
  onAnswer: (runId: string, response: string) => Promise<void> | void;
  onResume: (runId: string) => Promise<void> | void;
  onCreateStarter: () => Promise<void>;
}

const terminal = new Set(["completed", "failed", "cancelled"]);

const age = (timestamp: number) => {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
};

const stepKind = (kind: string) => ({
  agent: "Agent",
  gate: "Evidence gate",
  human: "Decision",
  watch: "Event",
  "git-op": "Git",
})[kind] ?? kind;

const triggerLabel = (kind: string) => kind === "manual"
  ? "Manual"
  : kind.split(".").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");

export function WorkflowView({
  projectId,
  projectName,
  projectRoot,
  componentRoots,
  onRun,
  onAnswer,
  onResume,
  onCreateStarter,
}: WorkflowViewProps) {
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [catalogErrors, setCatalogErrors] = useState<string[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>(() => cachedWorkflowRuns(projectId));
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creatingStarter, setCreatingStarter] = useState(false);

  const reloadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    const result = await loadWorkflowDefinitions(projectRoot, {
      projectRoot,
      componentRoots: new Set(componentRoots),
    });
    if (result.ok) {
      setDefinitions(result.definitions);
      setCatalogErrors([]);
    } else {
      setDefinitions([]);
      setCatalogErrors(result.errors);
    }
    setLoadingCatalog(false);
  }, [componentRoots, projectRoot]);

  const refresh = useCallback(async (changedRunId = "") => {
    const next = await refreshWorkflowRuns(projectId, changedRunId);
    setRuns(next);
    const active = (selected ?? changedRunId) || next[0]?.runId;
    if (active) {
      if (!selected) setSelected(active);
      setDetail(await workflowGet(active));
    }
  }, [projectId, selected]);

  useEffect(() => { void reloadCatalog(); }, [reloadCatalog]);

  useEffect(() => {
    void refresh();
    const changed = (event: Event) => {
      const change = (event as CustomEvent<{ projectId: string; runId: string }>).detail;
      if (change?.projectId === projectId) void refresh(change.runId);
    };
    window.addEventListener(WORKFLOW_RUNS_EVENT, changed);
    return () => window.removeEventListener(WORKFLOW_RUNS_EVENT, changed);
  }, [projectId, refresh]);

  const selectedRun = detail?.runId === selected ? detail : null;
  const activeCount = useMemo(
    () => runs.filter((run) => !terminal.has(run.status)).length,
    [runs],
  );

  const chooseRun = async (runId: string) => {
    setSelected(runId);
    setDetail(await workflowGet(runId));
  };

  const runDefinition = async (definition: WorkflowDefinition) => {
    setPending(definition.id);
    setActionError(null);
    try {
      await onRun(definition);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setPending(null);
    }
  };

  const act = async (action: () => Promise<void> | void) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(String(error));
    }
  };

  const currentHuman = selectedRun?.definition.steps.find(
    (step) => step.id === selectedRun.currentStepId && step.kind === "human",
  );

  return (
    <div className="workflow-view">
      <header className="workflow-view-head">
        <div>
          <div className="workflow-eyebrow">Automation · {projectName}</div>
          <h2>Workflows</h2>
          <p>Repository-defined jobs with durable steps, decisions, and evidence.</p>
        </div>
        <div className="workflow-head-stats" aria-label="Workflow summary">
          <span><strong>{definitions.length}</strong> available</span>
          <span><strong>{activeCount}</strong> active</span>
          <Button size="sm" variant="ghost" onClick={() => void reloadCatalog()}>
            Reload
          </Button>
        </div>
      </header>

      <div className="workflow-layout">
        <aside className="workflow-catalog" aria-label="Available workflows">
          <div className="workflow-section-label">Available here</div>
          {loadingCatalog ? (
            <div className="workflow-empty">Reading .canopy/workflows…</div>
          ) : catalogErrors.length > 0 ? (
            <div className="workflow-catalog-error" role="alert">
              <strong>Definitions need attention</strong>
              {catalogErrors.map((error) => <div key={error}>{error}</div>)}
            </div>
          ) : definitions.length === 0 ? (
            <div className="workflow-empty">
              <strong>No workflows are defined yet.</strong>
              <span>Add a JSON definition under <code>.canopy/workflows/</code>, then reload.</span>
              <Button
                size="sm"
                variant="accent"
                disabled={creatingStarter}
                onClick={() => void act(async () => {
                  setCreatingStarter(true);
                  try {
                    await onCreateStarter();
                    await reloadCatalog();
                  } finally {
                    setCreatingStarter(false);
                  }
                })}
              >
                {creatingStarter ? "Creating…" : "Create a starter workflow"}
              </Button>
            </div>
          ) : definitions.map((definition) => {
            const canRun = definition.triggers.some((trigger) => trigger.kind === "manual");
            return (
              <article className="workflow-definition" key={`${definition.id}@${definition.version}`}>
                <div className="workflow-definition-top">
                  <div>
                    <strong>{definition.name}</strong>
                    <span>{definition.id} · v{definition.version}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="accent"
                    disabled={!canRun || pending === definition.id}
                    title={canRun ? `Run ${definition.name}` : "This workflow has no manual trigger"}
                    onClick={() => void runDefinition(definition)}
                  >
                    {pending === definition.id ? "Starting…" : "Run"}
                  </Button>
                </div>
                <div className="workflow-definition-route" aria-label={`${definition.steps.length} steps`}>
                  {definition.steps.map((step, index) => (
                    <span key={step.id}>
                      {index > 0 && <i aria-hidden>→</i>}
                      {step.name}
                    </span>
                  ))}
                </div>
                <div className="workflow-definition-triggers">
                  Runs on {definition.triggers.map((trigger) => triggerLabel(trigger.kind)).join(" · ")}
                </div>
              </article>
            );
          })}
        </aside>

        <main className="workflow-runs">
          <div className="workflow-section-label">Run history</div>
          {actionError && <div className="workflow-inline-error" role="alert">{actionError}</div>}
          {runs.length === 0 ? (
            <div className="workflow-empty workflow-empty-runs">
              <strong>No runs yet.</strong>
              <span>Manual and event-triggered runs appear here as they happen.</span>
            </div>
          ) : (
            <div className="workflow-run-grid">
              <div className="workflow-run-list" role="listbox" aria-label="Workflow runs">
                {runs.map((run) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected === run.runId}
                    className={`workflow-run-row st-${run.status}${selected === run.runId ? " is-selected" : ""}`}
                    key={run.runId}
                    onClick={() => void chooseRun(run.runId)}
                  >
                    <i className="workflow-run-pulse" aria-hidden />
                    <span>
                      <strong>{run.definitionId}</strong>
                      <small>{run.currentStepId ? `At ${run.currentStepId}` : run.status}</small>
                    </span>
                    <time>{age(run.updatedAt)}</time>
                  </button>
                ))}
              </div>

              <section className="workflow-run-detail" aria-live="polite">
                {!selectedRun ? (
                  <div className="workflow-empty">Select a run to inspect its path.</div>
                ) : (
                  <>
                    <div className="workflow-run-title">
                      <div>
                        <span className={`workflow-status st-${selectedRun.status}`}>{selectedRun.status}</span>
                        <h3>{selectedRun.definition.name}</h3>
                        <small>Triggered by {triggerLabel(selectedRun.trigger.kind)}</small>
                      </div>
                      {selectedRun.status === "interrupted" && (
                        <Button size="sm" variant="accent" onClick={() => void act(() => onResume(selectedRun.runId))}>
                          Resume
                        </Button>
                      )}
                    </div>
                    <div className="workflow-spine">
                      {selectedRun.steps.map((state) => {
                        const definition = selectedRun.definition.steps.find((step) => step.id === state.id);
                        const current = selectedRun.currentStepId === state.id;
                        return (
                          <div className={`workflow-step st-${state.state}${current ? " is-current" : ""}`} key={state.id}>
                            <i className="workflow-step-node" aria-hidden />
                            <div>
                              <span>{stepKind(state.kind)}</span>
                              <strong>{definition?.name ?? state.id}</strong>
                              {state.attemptIds.length > 0 && (
                                <small>{state.attemptIds.length} attempt{state.attemptIds.length === 1 ? "" : "s"}</small>
                              )}
                            </div>
                            <em>{state.state}</em>
                          </div>
                        );
                      })}
                    </div>
                    {currentHuman?.kind === "human" && (
                      <div className="workflow-decision">
                        <strong>{currentHuman.card.title}</strong>
                        {currentHuman.card.detail && <p>{currentHuman.card.detail}</p>}
                        <div>
                          {currentHuman.card.actions.map((action) => (
                            <Button
                              size="sm"
                              variant={action.tone === "primary" ? "accent" : action.tone === "danger" ? "danger" : "ghost"}
                              key={action.response}
                              onClick={() => void act(() => onAnswer(selectedRun.runId, action.response))}
                            >
                              {action.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

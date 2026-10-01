import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select } from "./ui";
import {
  loadWorkflowDefinitions,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from "../workflowDefinition";
import {
  cachedWorkflowRuns,
  refreshWorkflowRuns,
  workflowGet,
  WORKFLOW_RUNS_EVENT,
} from "../workflowRuns";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../workflowRun";
import { WorkflowCanvas } from "./WorkflowCanvas";

interface WorkflowViewProps {
  projectId: string;
  projectName: string;
  projectRoot: string;
  componentRoots: string[];
  onRun: (definition: WorkflowDefinition) => Promise<void> | void;
  onAnswer: (runId: string, response: string) => Promise<void> | void;
  onResume: (runId: string) => Promise<void> | void;
  onCreateStarter: () => Promise<void>;
  onSave: (definition: WorkflowDefinition) => Promise<void>;
}

const terminal = new Set(["completed", "failed", "cancelled"]);
const age = (timestamp: number) => {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
};
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
  onSave,
}: WorkflowViewProps) {
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const [catalogErrors, setCatalogErrors] = useState<string[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>(() => cachedWorkflowRuns(projectId));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creatingStarter, setCreatingStarter] = useState(false);

  const selectDefinition = useCallback((definition: WorkflowDefinition) => {
    setEditingId(definition.id);
    setDraft(structuredClone(definition));
    setSavedDraft(JSON.stringify(definition));
    setActionError(null);
  }, []);

  // Read through refs so reloadCatalog/refresh keep their identity across
  // renders: they seed mount effects, and a per-render identity re-fired those
  // effects on every parent render — each pass swapped the canvas for the
  // loading state and re-cloned the draft, which read as the page flickering
  // and dropping the selection. `rootsKey` (contents, not array identity)
  // is what a root change actually looks like.
  const rootsKey = componentRoots.join("\n");
  const componentRootsRef = useRef(componentRoots);
  componentRootsRef.current = componentRoots;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const selectedRunIdRef = useRef(selectedRunId);
  selectedRunIdRef.current = selectedRunId;

  const reloadCatalog = useCallback(async (preferId?: string) => {
    setLoadingCatalog(true);
    const result = await loadWorkflowDefinitions(projectRoot, {
      projectRoot,
      componentRoots: new Set(componentRootsRef.current),
    });
    if (result.ok) {
      setDefinitions(result.definitions);
      setCatalogErrors([]);
      const next = result.definitions.find((definition) => definition.id === (preferId ?? editingIdRef.current))
        ?? result.definitions[0];
      if (next) selectDefinition(next);
      else { setDraft(null); setEditingId(null); }
    } else {
      setDefinitions([]);
      setCatalogErrors(result.errors);
    }
    setLoadingCatalog(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rootsKey stands in for componentRoots' contents
  }, [projectRoot, rootsKey, selectDefinition]);

  const refresh = useCallback(async (changedRunId = "") => {
    const next = await refreshWorkflowRuns(projectId, changedRunId);
    setRuns(next);
    const selected = selectedRunIdRef.current;
    const active = (selected ?? changedRunId) || next[0]?.runId;
    if (active) {
      if (!selected) setSelectedRunId(active);
      setDetail(await workflowGet(active));
    }
  }, [projectId]);

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

  const selectedRun = detail?.runId === selectedRunId ? detail : null;
  const activeCount = useMemo(() => runs.filter((run) => !terminal.has(run.status)).length, [runs]);
  const dirty = Boolean(draft && JSON.stringify(draft) !== savedDraft);
  const canRun = Boolean(draft?.triggers.some((trigger) => trigger.kind === "manual"));
  const currentHuman = selectedRun?.definition.steps.find(
    (step) => step.id === selectedRun.currentStepId && step.kind === "human",
  );

  const act = async (action: () => Promise<void> | void) => {
    setActionError(null);
    try { await action(); } catch (error) { setActionError(String(error)); }
  };
  const save = async () => {
    if (!draft) return;
    const validation = validateWorkflowDefinition(draft, {
      projectRoot,
      componentRoots: new Set(componentRoots),
    });
    if (!validation.ok) {
      setActionError(validation.errors.join(" · "));
      return;
    }
    setPending(true);
    try {
      await onSave(validation.definition);
      await reloadCatalog(validation.definition.id);
    } finally { setPending(false); }
  };
  const chooseRun = async (runId: string) => {
    setSelectedRunId(runId);
    setDetail(await workflowGet(runId));
  };

  return (
    <div className="workflow-view is-canvas">
      <header className="workflow-view-head">
        <div>
          <div className="workflow-eyebrow">Automation canvas · {projectName}</div>
          <h2>Workflows</h2>
          <p>Build with reusable agents, events, decisions, and durable evidence.</p>
        </div>
        <div className="workflow-head-stats" aria-label="Workflow summary">
          <span><strong>{definitions.length}</strong> workflows</span>
          <span><strong>{activeCount}</strong> active</span>
        </div>
      </header>

      {loadingCatalog && definitions.length === 0 ? (
        <div className="workflow-empty">Reading .canopy/workflows…</div>
      ) : catalogErrors.length > 0 ? (
        <div className="workflow-catalog-error" role="alert">
          <strong>Definitions need attention</strong>
          {catalogErrors.map((error) => <div key={error}>{error}</div>)}
        </div>
      ) : definitions.length === 0 ? (
        <div className="workflow-empty workflow-first-canvas">
          <strong>Start with a working canvas.</strong>
          <span>Creates a reusable Reviewer agent, an agent task, and a human decision under <code>.canopy/workflows/</code>.</span>
          <Button
            size="sm"
            variant="accent"
            disabled={creatingStarter}
            onClick={() => void act(async () => {
              setCreatingStarter(true);
              try { await onCreateStarter(); await reloadCatalog(); }
              finally { setCreatingStarter(false); }
            })}
          >
            {creatingStarter ? "Creating…" : "Create workflow canvas"}
          </Button>
        </div>
      ) : draft && (
        <>
          <div className="workflow-editor-toolbar">
            <Select
              aria-label="Workflow"
              value={editingId ?? ""}
              onChange={(event) => {
                const next = definitions.find((definition) => definition.id === event.target.value);
                if (next) selectDefinition(next);
              }}
            >
              {definitions.map((definition) => <option value={definition.id} key={definition.id}>{definition.name}</option>)}
            </Select>
            <span className="workflow-editor-version">{draft.id} · v{draft.version}</span>
            <span className="status-spacer" />
            {dirty && <span className="workflow-unsaved">Unsaved changes</span>}
            <Button size="sm" variant="ghost" onClick={() => void reloadCatalog(editingId ?? undefined)}>Discard</Button>
            <Button size="sm" variant="accent" disabled={!dirty || pending} onClick={() => void act(save)}>
              {pending ? "Saving…" : "Save workflow"}
            </Button>
            <Button
              size="sm"
              disabled={!canRun || dirty || pending}
              title={!canRun ? "Add a manual event to run this from the canvas" : dirty ? "Save before running" : "Run workflow"}
              onClick={() => void act(async () => { setPending(true); try { await onRun(draft); } finally { setPending(false); } })}
            >Run</Button>
          </div>
          {actionError && <div className="workflow-inline-error" role="alert">{actionError}</div>}
          <WorkflowCanvas definition={draft} run={selectedRun} projectRoot={projectRoot} onChange={setDraft} />
        </>
      )}

      <section className="workflow-runs workflow-runs-below">
        <div className="workflow-section-label">Run history</div>
        {runs.length === 0 ? (
          <div className="workflow-empty workflow-empty-runs">
            <strong>No runs yet.</strong>
            <span>Manual and event-triggered runs appear here and light up their canvas nodes.</span>
          </div>
        ) : (
          <div className="workflow-run-grid">
            <div className="workflow-run-list" role="listbox" aria-label="Workflow runs">
              {runs.map((run) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedRunId === run.runId}
                  className={`workflow-run-row st-${run.status}${selectedRunId === run.runId ? " is-selected" : ""}`}
                  key={run.runId}
                  onClick={() => void chooseRun(run.runId)}
                >
                  <i className="workflow-run-pulse" aria-hidden />
                  <span><strong>{run.definitionId}</strong><small>{run.currentStepId ? `At ${run.currentStepId}` : run.status}</small></span>
                  <time>{age(run.updatedAt)}</time>
                </button>
              ))}
            </div>
            <div className="workflow-run-detail">
              {selectedRun && <>
                <div className="workflow-run-title">
                  <div>
                    <span className={`workflow-status st-${selectedRun.status}`}>{selectedRun.status}</span>
                    <h3>{selectedRun.definition.name}</h3>
                    <small>Triggered by {triggerLabel(selectedRun.trigger.kind)}</small>
                  </div>
                  {selectedRun.status === "interrupted" && <Button size="sm" variant="accent" onClick={() => void act(() => onResume(selectedRun.runId))}>Resume</Button>}
                </div>
                {currentHuman?.kind === "human" && (
                  <div className="workflow-decision">
                    <strong>{currentHuman.card.title}</strong>
                    {currentHuman.card.detail && <p>{currentHuman.card.detail}</p>}
                    <div>{currentHuman.card.actions.map((action) => (
                      <Button
                        size="sm"
                        variant={action.tone === "primary" ? "accent" : action.tone === "danger" ? "danger" : "ghost"}
                        key={action.response}
                        onClick={() => void act(() => onAnswer(selectedRun.runId, action.response))}
                      >{action.label}</Button>
                    ))}</div>
                  </div>
                )}
              </>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

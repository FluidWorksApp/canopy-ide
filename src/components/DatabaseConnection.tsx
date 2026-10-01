import { useRef, useState } from "react";
import { applyMigrations, inspectMigrations, listProviderProjects, verifyProviderProject, type DatabaseProvider, type MigrationPlan, type ProviderProject } from "../buildProviders";
import { projectIntegrationsReducer, type IntegrationOperation, type ProjectIntegrationState } from "../projectIntegrations";
import { Button } from "./ui";

export function DatabaseConnection({ provider, cwd, componentId, environment, state, onChange, onConfigure, onClose }: {
  provider: DatabaseProvider; cwd: string; componentId: string; environment: "local" | "production";
  state: ProjectIntegrationState; onChange: (state: ProjectIntegrationState) => void | Promise<void>;
  onConfigure: () => void; onClose: () => void;
}) {
  const [projects, setProjects] = useState<ProviderProject[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const current = useRef(state);
  current.current = state;
  const save = async (next: ProjectIntegrationState) => { await onChange(next); current.current = next; };
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError("");
    try { await work(); } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const binding = state.resources.find((item) => item.providerId === provider && item.environment === environment && (!item.componentId || item.componentId === componentId));
  const resourceId = environment === "local" ? `local-${componentId}` : binding?.resourceId;
  const unresolved = (state.operations ?? []).filter((operation) => operation.providerId === provider && operation.resourceId === resourceId && operation.environment === environment && ["running", "unknown"].includes(operation.status));
  const connect = async () => {
    const project = await verifyProviderProject(provider, cwd, selected);
    const at = new Date().toISOString();
    const next = projectIntegrationsReducer({ ...current.current, resources: current.current.resources.filter((item) => item.providerId !== provider || item.environment !== "production" || (item.componentId != null && item.componentId !== componentId)) }, { type: "set-resource", resource: { providerId: provider, componentId, resourceId: project.id, resourceName: project.name, environment: "production", kind: "database", status: "connected", lastObservedAt: at, message: "Account access verified. Configure the app to use this project." } });
    await save(projectIntegrationsReducer(next, { type: "set-connection", connection: { providerId: provider, resourceId: project.id, resourceName: project.name, environment: "production", status: "connected", lastCheckedAt: at } }));
    setPlan(null);
  };
  const inspect = async () => {
    if (!resourceId) throw new Error("Select the production project first.");
    const next = await inspectMigrations(provider, cwd, resourceId, environment);
    const operations = (current.current.operations ?? []).map((operation) => {
      if (!unresolved.some((item) => item.id === operation.id)) return operation;
      const applied = provider === "supabase" && operation.migrationIds?.length && operation.migrationIds.every((id) => next.applied.includes(id));
      return { ...operation, status: applied ? "succeeded" as const : "unknown" as const, ...(applied ? { completedAt: new Date().toISOString() } : {}) };
    });
    if (unresolved.length) await save({ ...current.current, operations });
    setPlan(next);
  };
  const apply = async () => {
    if (!plan || unresolved.length) return;
    const operation: IntegrationOperation = { id: crypto.randomUUID(), providerId: provider, resourceId: plan.resourceId, environment: plan.environment, kind: "migrate", status: "running", fingerprint: plan.fingerprint, migrationIds: plan.pending, startedAt: new Date().toISOString() };
    await applyMigrations(plan, plan.fingerprint, async (status) => {
      await save({ ...current.current, operations: [...(current.current.operations ?? []).filter((item) => item.id !== operation.id), { ...operation, status, ...(status === "succeeded" ? { completedAt: new Date().toISOString() } : {}) }] });
    });
    setPlan(null);
  };
  return <section className="integration-section" aria-label={`${provider} connection`}>
    <div className="integration-section-title"><span>{provider === "supabase" ? "Supabase" : "Firebase"}</span><Button size="sm" onClick={onClose} disabled={busy}>Close</Button></div>
    <p>{environment === "local" ? "Preview uses your local database or emulator." : "Select the production project your account can access."}</p>
    {environment === "production" && <>
      <Button size="sm" disabled={busy} onClick={() => void run(async () => { setProjects(await listProviderProjects(provider, cwd)); })}>Load account projects</Button>
      {projects.length > 0 && <label>Project <select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy}>
        <option value="">Choose a project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name} ({project.id})</option>)}
      </select></label>}
      {selected && <Button size="sm" disabled={busy} onClick={() => void run(connect)}>Select project</Button>}
      {binding && <p>Selected: {binding.resourceName ?? binding.resourceId}</p>}
    </>}
    <Button size="sm" disabled={busy} onClick={onConfigure}>Configure app connection</Button>
    <Button size="sm" disabled={busy || !resourceId} onClick={() => void run(inspect)}>Inspect database changes</Button>
    {busy && <p role="status">Checking the provider…</p>}
    {error && <p role="alert">{error}</p>}
    {unresolved.length > 0 && <p role="status">An earlier database operation has an unconfirmed outcome. Inspect its history; use Configure app connection to resolve partial changes before retrying.</p>}
    {plan && <div>
      <p>{plan.provider === "supabase" ? `${plan.pending.length} pending migrations; ${plan.applied.length} applied.` : "Firestore rules and indexes. This does not migrate document data."}</p>
      {plan.changes.map((change) => <details key={change.path}><summary>{change.path}</summary><pre style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>{change.content}</pre></details>)}
      {plan.environment === "production" && <p>Applying changes updates the production database. Restoring code does not restore database contents.</p>}
      <Button size="sm" disabled={busy || unresolved.length > 0 || plan.pending.length === 0 || (provider === "firebase" && environment === "local")} onClick={() => void run(apply)}>
        {environment === "production" ? "Apply reviewed production changes" : "Apply local migrations"}
      </Button>
    </div>}
    {(state.operations ?? []).filter((operation) => operation.providerId === provider && operation.environment === environment && operation.resourceId === resourceId).slice(-5).reverse().map((operation) => <p key={operation.id}>{operation.kind}: {operation.status} · {operation.startedAt}</p>)}
  </section>;
}

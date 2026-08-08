import { useMemo, useState } from "react";
import type { Project } from "../projects";
import {
  INTEGRATION_PROVIDERS,
  integrationProviderById,
  projectIntegrationsReducer,
  selectLatestDeployment,
  type IntegrationProviderId,
  type ProjectIntegrationState,
} from "../projectIntegrations";
import type { ServerState } from "../servers";
import { ChevronIcon, GlobeIcon, PlayIcon, RestartIcon, StopIcon } from "./icons";
import { Button } from "./ui";

export interface LocalIntegrationService {
  id: string;
  component: string;
  name: string;
  state: ServerState;
  ports: number[];
  canStart: boolean;
  canStop: boolean;
}

interface IntegrationsPanelProps {
  project: Project;
  state: ProjectIntegrationState;
  localServices: LocalIntegrationService[];
  onChange: (state: ProjectIntegrationState) => void;
  /** Starts an agent with the provider-specific account/resource brief. The
   * agent uses an enabled API/MCP route first and a provider CLI as fallback. */
  onAutomate: (providerId: IntegrationProviderId) => void;
  onStartLocal: (id: string) => void;
  onStopLocal: (id: string) => void;
  onOpenLocal: (port: number) => void;
  onOpenRemote: (url: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  deployment: "Hosting",
  backend: "Backend platforms",
  database: "Databases",
  payments: "Payments",
  email: "Email",
  observability: "Observability",
  cache: "Cache & queues",
  secrets: "Secrets & security",
  "source-control": "Source control",
};

const statusLabel = (status: string) =>
  status === "connected"
    ? "Connected"
    : status === "needs-attention"
      ? "Needs attention"
      : "Not connected";

const timeLabel = (value: string | undefined) => {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(time);
};

const providerName = (id: string) => integrationProviderById(id)?.label ?? id;

export function IntegrationsPanel({
  project,
  state,
  localServices,
  onChange,
  onAutomate,
  onStartLocal,
  onStopLocal,
  onOpenLocal,
  onOpenRemote,
}: IntegrationsPanelProps) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const connected = state.connections.filter((item) => item.status === "connected");
  const latest = selectLatestDeployment(state);
  const readyLocal = localServices.filter((item) => item.state === "running").length;
  const requiredProviders = useMemo(
    () => new Set(
      [
        ...(project.vibe?.dataStores ?? []).map((store) => store.providerId),
        ...(project.vibe?.externalServices ?? []).map((service) => service.providerId),
      ].filter((id): id is string => Boolean(id)),
    ),
    [project.vibe?.dataStores, project.vibe?.externalServices],
  );
  const providers = useMemo(
    () => [...INTEGRATION_PROVIDERS].sort((a, b) => {
      const required = Number(requiredProviders.has(b.id)) - Number(requiredProviders.has(a.id));
      if (required) return required;
      return a.category.localeCompare(b.category);
    }),
    [requiredProviders],
  );
  const groups = useMemo(() => {
    const result = new Map<string, typeof providers>();
    for (const provider of providers) {
      const group = result.get(provider.category) ?? [];
      result.set(provider.category, [...group, provider]);
    }
    return [...result.entries()];
  }, [providers]);

  const disconnect = (providerId: IntegrationProviderId) =>
    onChange(projectIntegrationsReducer(state, { type: "remove-connection", providerId }));

  const discoveredStores = project.vibe?.dataStores ?? [];

  return (
    <div className="side-panel integrations-panel">
      <div className="side-panel-head integrations-head">
        <span>Integrations</span>
        <span>{connected.length} linked</span>
      </div>

      <div className="integration-spine" aria-label="Project delivery state">
        {[
          ["Local", localServices.length ? `${readyLocal}/${localServices.length}` : "—", readyLocal > 0],
          ["Accounts", String(connected.length), connected.length > 0],
          ["Resources", String(state.resources.length + discoveredStores.length), state.resources.length > 0],
          ["Deploy", latest ? "latest" : "—", Boolean(latest)],
        ].map(([label, value, active], index) => (
          <div className={`integration-spine-node ${active ? "integration-spine-live" : ""}`} key={String(label)}>
            {index > 0 && <span className="integration-spine-line" />}
            <span className="integration-spine-dot" />
            <span className="integration-spine-label">{label}</span>
            <span className="integration-spine-value">{value}</span>
          </div>
        ))}
      </div>

      <section className="integration-section">
        <div className="integration-section-title">
          <span>Local layer</span>
          {localServices.length > 0 && <span>{readyLocal} running</span>}
        </div>
        {localServices.length === 0 ? (
          <p className="integration-empty">No local services have been discovered yet.</p>
        ) : localServices.map((service) => (
          <div className="integration-local-row" key={service.id}>
            <span className={`integration-status integration-status-${service.state}`} />
            <span className="integration-row-main">
              <span className="integration-row-name">{service.name}</span>
              <span className="integration-row-meta">{service.component}</span>
            </span>
            {service.ports.slice(0, 1).map((port) => (
              <button className="integration-endpoint" key={port} onClick={() => onOpenLocal(port)}>
                :{port}
              </button>
            ))}
            {service.canStop ? (
              <Button icon variant="danger" title={`Stop ${service.name}`} onClick={() => onStopLocal(service.id)}>
                <StopIcon size={11} />
              </Button>
            ) : service.canStart ? (
              <Button icon title={`Start ${service.name}`} onClick={() => onStartLocal(service.id)}>
                <PlayIcon size={11} />
              </Button>
            ) : null}
          </div>
        ))}
        <p className="integration-note">Local runs stay available while an account is linking.</p>
      </section>

      <section className="integration-section">
        <div className="integration-section-title"><span>Connected accounts</span></div>
        {state.connections.length === 0 ? (
          <p className="integration-empty">No provider account is linked to this project.</p>
        ) : state.connections.map((connection) => (
          <div className="integration-account" key={connection.providerId}>
            <span className={`integration-provider-mark integration-provider-${connection.status}`}>
              {providerName(connection.providerId).slice(0, 1)}
            </span>
            <span className="integration-row-main">
              <span className="integration-row-name">{providerName(connection.providerId)}</span>
              <span className="integration-row-meta">
                {connection.resourceName ?? statusLabel(connection.status)}
                {connection.lastCheckedAt ? ` · ${timeLabel(connection.lastCheckedAt)}` : ""}
              </span>
              {connection.message && <span className="integration-row-message">{connection.message}</span>}
            </span>
            <Button icon title={`Recheck ${providerName(connection.providerId)}`} onClick={() => onAutomate(connection.providerId)}>
              <RestartIcon size={12} />
            </Button>
            <button className="integration-text-action" onClick={() => disconnect(connection.providerId)}>Remove</button>
          </div>
        ))}
      </section>

      <section className="integration-section">
        <div className="integration-section-title"><span>Resources</span></div>
        {state.resources.map((resource) => (
          <div className="integration-resource" key={`${resource.providerId}:${resource.resourceId}`}>
            <span className={`integration-status integration-status-${resource.status}`} />
            <span className="integration-row-main">
              <span className="integration-row-name">{resource.resourceName ?? resource.resourceId}</span>
              <span className="integration-row-meta">
                {providerName(resource.providerId)} · {resource.kind}
                {resource.environment ? ` · ${resource.environment}` : ""}
              </span>
              {resource.latestMigration && (
                <span className="integration-migration">Migration {resource.latestMigration}</span>
              )}
            </span>
            {resource.endpoint && (
              <button className="integration-text-action" onClick={() => onOpenRemote(resource.endpoint as string)}>Open</button>
            )}
          </div>
        ))}
        {discoveredStores.map((store) => (
          <div className="integration-resource integration-resource-discovered" key={`discovered:${store.id}`}>
            <span className="integration-status integration-status-discovered" />
            <span className="integration-row-main">
              <span className="integration-row-name">{store.label}</span>
              <span className="integration-row-meta">
                {store.engine} · {store.mode}{store.providerId ? ` · ${providerName(store.providerId)}` : ""}
              </span>
              <span className="integration-migration">
                {store.latestMigration ? `Migration ${store.latestMigration}` : "Schema discovered"}
              </span>
            </span>
          </div>
        ))}
        {state.resources.length === 0 && discoveredStores.length === 0 && (
          <p className="integration-empty">Databases, queues, storage and service endpoints appear here.</p>
        )}
      </section>

      <section className="integration-section">
        <div className="integration-section-title"><span>Deployments</span></div>
        {state.deployments.length === 0 ? (
          <div className="integration-empty integration-deploy-empty">
            <p>No deployment recorded yet.</p>
            <div>
              <Button size="sm" onClick={() => onAutomate("vercel")}>Vercel</Button>
              <Button size="sm" onClick={() => onAutomate("fly")}>Fly.io</Button>
            </div>
          </div>
        ) : [...state.deployments]
          .sort((a, b) => Date.parse(b.lastDeployedAt ?? "") - Date.parse(a.lastDeployedAt ?? ""))
          .slice(0, 5)
          .map((deployment) => (
            <div className={`integration-deployment ${deployment === latest ? "integration-deployment-latest" : ""}`} key={`${deployment.providerId}:${deployment.deploymentId ?? deployment.url ?? deployment.lastDeployedAt}`}>
              <GlobeIcon size={13} />
              <span className="integration-row-main">
                <span className="integration-row-name">
                  {deployment.resourceName ?? providerName(deployment.providerId)}
                  {deployment === latest && <span className="integration-latest">latest</span>}
                </span>
                <span className="integration-row-meta">
                  {[deployment.environment, deployment.branch, timeLabel(deployment.lastDeployedAt)].filter(Boolean).join(" · ") || statusLabel(deployment.status)}
                </span>
              </span>
              {deployment.url && (
                <button className="integration-text-action" onClick={() => onOpenRemote(deployment.url as string)}>Open</button>
              )}
            </div>
          ))}
      </section>

      <section className="integration-section integration-catalog">
        <button className="integration-catalog-toggle" aria-expanded={catalogOpen} onClick={() => setCatalogOpen((open) => !open)}>
          <ChevronIcon className={catalogOpen ? "tree-chevron-open" : ""} />
          <span>Add an integration</span>
          <span>{INTEGRATION_PROVIDERS.length} available</span>
        </button>
        {catalogOpen && groups.map(([category, categoryProviders]) => (
          <div className="integration-provider-group" key={category}>
            <div className="integration-provider-group-title">{CATEGORY_LABELS[category] ?? category}</div>
            {categoryProviders.map((provider) => {
              const connection = state.connections.find((item) => item.providerId === provider.id);
              return (
                <div className="integration-provider-row" key={provider.id}>
                  <span className="integration-provider-mark">{provider.label.slice(0, 1)}</span>
                  <span className="integration-row-main">
                    <span className="integration-row-name">
                      {provider.label}
                      {requiredProviders.has(provider.id) && <span className="integration-needed">needed</span>}
                    </span>
                    <span className="integration-row-meta">{provider.description}</span>
                    <span className="integration-reach">{provider.reach.map((reach) => reach.toUpperCase()).join(" · ")}</span>
                  </span>
                  <Button size="sm" variant={connection?.status === "connected" ? undefined : "accent"} onClick={() => onAutomate(provider.id)}>
                    {connection ? "Manage" : "Connect"}
                  </Button>
                </div>
              );
            })}
          </div>
        ))}
      </section>
      <p className="integration-security-note">Credentials stay in linked providers, keychains, or a secret manager. This project saves only safe IDs, endpoints, migration labels, and observations.</p>
    </div>
  );
}

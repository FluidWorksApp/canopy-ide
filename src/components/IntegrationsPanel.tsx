import { useMemo, useState } from "react";
import type { Project } from "../projects";
import {
  INTEGRATION_PROVIDERS,
  integrationProviderById,
  isIntegrationProviderId,
  projectIntegrationsReducer,
  type IntegrationProviderId,
  type ProjectDeploymentState,
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
  title?: string;
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

type Environment = "local" | "preview" | "production";

const ENVIRONMENTS: Array<{ id: Environment; label: string }> = [
  { id: "local", label: "Local" },
  { id: "preview", label: "Preview" },
  { id: "production", label: "Production" },
];

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

const environmentOf = (value: string | undefined): Environment | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "local" || normalized === "development" || normalized === "dev") return "local";
  if (normalized === "production" || normalized === "prod") return "production";
  return "preview";
};

const deploymentTime = (deployment: ProjectDeploymentState) => {
  const time = Date.parse(deployment.lastDeployedAt ?? "");
  return Number.isFinite(time) ? time : 0;
};

const newestFirst = (a: ProjectDeploymentState, b: ProjectDeploymentState) =>
  deploymentTime(b) - deploymentTime(a);

export function IntegrationsPanel({
  project,
  title = "Integrations",
  state,
  localServices,
  onChange,
  onAutomate,
  onStartLocal,
  onStopLocal,
  onOpenLocal,
  onOpenRemote,
}: IntegrationsPanelProps) {
  const [environment, setEnvironment] = useState<Environment>("local");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const connected = state.connections.filter((item) => item.status === "connected");
  const readyLocal = localServices.filter((item) => item.state === "running").length;
  const discoveredStores = useMemo(
    () => project.vibe?.dataStores ?? [],
    [project.vibe?.dataStores],
  );
  const externalServices = useMemo(
    () => project.vibe?.externalServices ?? [],
    [project.vibe?.externalServices],
  );
  const requiredProviders = useMemo(
    () => new Set(
      [
        ...discoveredStores.map((store) => store.providerId),
        ...externalServices.map((service) => service.providerId),
      ].filter(isIntegrationProviderId),
    ),
    [discoveredStores, externalServices],
  );
  const providers = useMemo(
    () => [...INTEGRATION_PROVIDERS].sort((a, b) => {
      const required = Number(requiredProviders.has(b.id)) - Number(requiredProviders.has(a.id));
      if (required) return required;
      return a.category.localeCompare(b.category) || a.label.localeCompare(b.label);
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
  const environmentDeployments = useMemo(
    () => state.deployments
      .filter((deployment) => environmentOf(deployment.environment) === environment)
      .sort(newestFirst),
    [environment, state.deployments],
  );
  const environmentResources = useMemo(
    () => state.resources.filter((resource) => {
      const resourceEnvironment = environmentOf(resource.environment);
      return resourceEnvironment === environment || (environment !== "local" && resourceEnvironment === null);
    }),
    [environment, state.resources],
  );
  const latestDeployment = environmentDeployments[0];
  const providerActionLabel = (providerId: IntegrationProviderId) =>
    connected.some((connection) => connection.providerId === providerId) ? "Manage" : "Set up";

  const disconnect = (providerId: IntegrationProviderId) =>
    onChange(projectIntegrationsReducer(state, { type: "remove-connection", providerId }));

  if (catalogOpen) {
    return (
      <div className="side-panel integrations-panel">
        <div className="side-panel-head integrations-head integrations-catalog-head">
          <button className="integration-back" onClick={() => setCatalogOpen(false)}>
            <ChevronIcon />
            <span>{title}</span>
          </button>
          <span>{INTEGRATION_PROVIDERS.length} services</span>
        </div>
        <div className="integration-catalog-intro">
          <strong>Add a service</strong>
          <span>Canopy uses a linked API first, then a provider CLI when needed.</span>
        </div>
        <div className="integration-catalog-list">
          {groups.map(([category, categoryProviders]) => (
            <section className="integration-provider-group" key={category}>
              <div className="integration-section-title">
                <span>{CATEGORY_LABELS[category] ?? category}</span>
              </div>
              {categoryProviders.map((provider) => {
                const connection = state.connections.find((item) => item.providerId === provider.id);
                return (
                  <div className="integration-provider-row" key={provider.id}>
                    <span className={`integration-provider-mark integration-provider-${connection?.status ?? "disconnected"}`}>
                      {provider.label.slice(0, 1)}
                    </span>
                    <span className="integration-row-main">
                      <span className="integration-row-name">
                        {provider.label}
                        {requiredProviders.has(provider.id) && <span className="integration-needed">needed</span>}
                      </span>
                      <span className="integration-row-meta">{provider.description}</span>
                      <span className="integration-reach">{provider.reach.map((reach) => reach.toUpperCase()).join(" · ")}</span>
                    </span>
                    <Button
                      size="sm"
                      variant={connection?.status === "connected" ? undefined : "accent"}
                      onClick={() => onAutomate(provider.id)}
                    >
                      {connection?.status === "connected" ? "Manage" : "Set up"}
                    </Button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <p className="integration-security-note">Credentials stay in linked providers, keychains, or a secret manager. Only safe resource IDs, endpoints, and deployment observations are saved with this project.</p>
      </div>
    );
  }

  return (
    <div className="side-panel integrations-panel">
      <div className="side-panel-head integrations-head">
        <span>{title}</span>
        <Button size="sm" variant="accent" onClick={() => setCatalogOpen(true)}>Add service</Button>
      </div>

      <nav className="integration-environments" aria-label="Environment">
        {ENVIRONMENTS.map((item) => (
          <button
            aria-pressed={environment === item.id}
            className={environment === item.id ? "integration-environment-active" : ""}
            key={item.id}
            onClick={() => setEnvironment(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {environment === "local" ? (
        <>
          <section className="integration-environment-summary" aria-live="polite">
            <span className={`integration-summary-light ${readyLocal > 0 ? "integration-summary-live" : ""}`} />
            <span>
              <strong>This computer</strong>
              <small>{localServices.length ? `${readyLocal} of ${localServices.length} services running` : "No services discovered yet"}</small>
            </span>
          </section>

          <section className="integration-section">
            <div className="integration-section-title">
              <span>Services</span>
              {localServices.length > 0 && <span>{readyLocal} running</span>}
            </div>
            {localServices.length === 0 ? (
              <p className="integration-empty">Build will list the frontend, backend, and workers here after it understands the project.</p>
            ) : localServices.map((service) => (
              <div className="integration-local-row" key={service.id}>
                <span className={`integration-status integration-status-${service.state}`} />
                <span className="integration-row-main">
                  <span className="integration-row-name">{service.name}</span>
                  <span className="integration-row-meta">{service.component}</span>
                </span>
                {service.ports.slice(0, 1).map((port) => (
                  <button className="integration-endpoint" key={port} onClick={() => onOpenLocal(port)}>
                    Open :{port}
                  </button>
                ))}
                {service.canStop ? (
                  <Button icon size="sm" variant="danger" title={`Stop ${service.name}`} onClick={() => onStopLocal(service.id)}>
                    <StopIcon size={11} />
                  </Button>
                ) : service.canStart ? (
                  <Button icon size="sm" title={`Start ${service.name}`} onClick={() => onStartLocal(service.id)}>
                    <PlayIcon size={11} />
                  </Button>
                ) : null}
              </div>
            ))}
            <p className="integration-note">Local services remain available while provider setup runs.</p>
          </section>

          <section className="integration-section">
            <div className="integration-section-title"><span>Project dependencies</span></div>
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
                {store.providerId && isIntegrationProviderId(store.providerId) && (
                  <Button size="sm" onClick={() => onAutomate(store.providerId as IntegrationProviderId)}>
                    {providerActionLabel(store.providerId)}
                  </Button>
                )}
              </div>
            ))}
            {externalServices.map((service) => (
              <div className="integration-resource integration-resource-discovered" key={`external:${service.id}`}>
                <span className="integration-status integration-status-discovered" />
                <span className="integration-row-main">
                  <span className="integration-row-name">{service.label}</span>
                  <span className="integration-row-meta">{service.purpose}</span>
                </span>
                {service.providerId && isIntegrationProviderId(service.providerId) && (
                  <Button size="sm" onClick={() => onAutomate(service.providerId as IntegrationProviderId)}>
                    {providerActionLabel(service.providerId)}
                  </Button>
                )}
              </div>
            ))}
            {discoveredStores.length === 0 && externalServices.length === 0 && (
              <p className="integration-empty">Databases, authentication, queues, and external APIs discovered by Build appear here.</p>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="integration-environment-summary integration-cloud-summary" aria-live="polite">
            <span className={`integration-summary-light ${latestDeployment?.status === "connected" ? "integration-summary-live" : ""}`} />
            <span>
              <strong>{environment === "production" ? "Production" : "Preview"}</strong>
              <small>{latestDeployment ? `Last deployed ${timeLabel(latestDeployment.lastDeployedAt) ?? "recently"}` : "No deployment recorded"}</small>
            </span>
            {latestDeployment?.url && (
              <Button size="sm" variant="accent" onClick={() => onOpenRemote(latestDeployment.url as string)}>Open</Button>
            )}
          </section>

          <section className="integration-section">
            <div className="integration-section-title"><span>Latest deployment</span></div>
            {!latestDeployment ? (
              <div className="integration-empty integration-deploy-empty">
                <p>Nothing has been deployed to this environment.</p>
                <div>
                  <Button size="sm" variant="accent" onClick={() => onAutomate("vercel")}>Set up Vercel</Button>
                  <Button size="sm" onClick={() => onAutomate("fly")}>Set up Fly.io</Button>
                </div>
              </div>
            ) : environmentDeployments.slice(0, 5).map((deployment, index) => (
              <div className={`integration-deployment ${index === 0 ? "integration-deployment-latest" : ""}`} key={`${deployment.providerId}:${deployment.deploymentId ?? deployment.url ?? deployment.lastDeployedAt}`}>
                <GlobeIcon size={13} />
                <span className="integration-row-main">
                  <span className="integration-row-name">
                    {deployment.resourceName ?? providerName(deployment.providerId)}
                    {index === 0 && <span className="integration-latest">latest</span>}
                  </span>
                  <span className="integration-row-meta">
                    {[deployment.branch, timeLabel(deployment.lastDeployedAt)].filter(Boolean).join(" · ") || statusLabel(deployment.status)}
                  </span>
                </span>
                {deployment.url && (
                  <button className="integration-text-action" onClick={() => onOpenRemote(deployment.url as string)}>Open</button>
                )}
              </div>
            ))}
          </section>

          <section className="integration-section">
            <div className="integration-section-title"><span>Resources</span></div>
            {environmentResources.map((resource) => (
              <div className="integration-resource" key={`${resource.providerId}:${resource.resourceId}`}>
                <span className={`integration-status integration-status-${resource.status}`} />
                <span className="integration-row-main">
                  <span className="integration-row-name">{resource.resourceName ?? resource.resourceId}</span>
                  <span className="integration-row-meta">{providerName(resource.providerId)} · {resource.kind}</span>
                  {resource.latestMigration && <span className="integration-migration">Migration {resource.latestMigration}</span>}
                </span>
                {resource.endpoint && (
                  <button className="integration-text-action" onClick={() => onOpenRemote(resource.endpoint as string)}>Open</button>
                )}
              </div>
            ))}
            {environmentResources.length === 0 && (
              <p className="integration-empty">Databases, queues, storage, and service endpoints for this environment appear here.</p>
            )}
          </section>
        </>
      )}

      <section className="integration-section integration-linked-section">
        <div className="integration-section-title">
          <span>Linked services</span>
          <span>{connected.length} connected</span>
        </div>
        {state.connections.length === 0 ? (
          <div className="integration-empty integration-linked-empty">
            <p>No provider account is linked to this project.</p>
            <Button size="sm" onClick={() => setCatalogOpen(true)}>Choose a service</Button>
          </div>
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
            <Button icon size="sm" title={`Manage ${providerName(connection.providerId)}`} onClick={() => onAutomate(connection.providerId)}>
              <RestartIcon size={12} />
            </Button>
            <button className="integration-text-action" onClick={() => disconnect(connection.providerId)}>Remove</button>
          </div>
        ))}
      </section>
    </div>
  );
}

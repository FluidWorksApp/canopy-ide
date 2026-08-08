// Portable, non-secret integration state for a project.
//
// This belongs in the workspace/project document, not localStorage: it should
// travel with an exported project and be available before a settings surface
// mounts. Credentials deliberately do not belong here. A connection records
// only the provider and a human-safe reference to the remote resource.

export const PROJECT_INTEGRATIONS_VERSION = 1 as const;

export type IntegrationProviderId =
  | "vercel"
  | "fly"
  | "cloudflare"
  | "supabase"
  | "neon"
  | "firebase"
  | "stripe"
  | "resend"
  | "sentry"
  | "upstash"
  | "infisical"
  | "github";

export type IntegrationCategory =
  | "deployment"
  | "database"
  | "backend"
  | "payments"
  | "email"
  | "observability"
  | "cache"
  | "secrets"
  | "source-control";

export type IntegrationCapability =
  | "deploy"
  | "database"
  | "auth"
  | "storage"
  | "functions"
  | "payments"
  | "email"
  | "observability"
  | "cache"
  | "secrets"
  | "source-control";

export type IntegrationReach = "cli" | "api" | "mcp";

export interface IntegrationProvider {
  id: IntegrationProviderId;
  label: string;
  category: IntegrationCategory;
  description: string;
  capabilities: readonly IntegrationCapability[];
  reach: readonly IntegrationReach[];
  /** Command Canopy can probe or invoke. Omitted for API-only providers. */
  cliBin?: string;
  docsUrl: string;
}

/**
 * The settings catalog is intentionally data, rather than UI conditionals.
 * Every provider listed here has at least one headless route, which keeps it
 * possible for Build to configure and inspect it without dashboard clicking.
 */
export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  {
    id: "vercel",
    label: "Vercel",
    category: "deployment",
    description: "Deploy web apps and serverless functions.",
    capabilities: ["deploy", "functions"],
    reach: ["cli", "api"],
    cliBin: "vercel",
    docsUrl: "https://vercel.com/docs",
  },
  {
    id: "fly",
    label: "Fly.io",
    category: "deployment",
    description: "Run applications and workers close to their users.",
    capabilities: ["deploy"],
    reach: ["cli", "api"],
    cliBin: "flyctl",
    docsUrl: "https://fly.io/docs/",
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    category: "deployment",
    description: "Deploy Workers, Pages, and edge storage.",
    capabilities: ["deploy", "functions", "storage"],
    reach: ["cli", "api"],
    cliBin: "wrangler",
    docsUrl: "https://developers.cloudflare.com/",
  },
  {
    id: "supabase",
    label: "Supabase",
    category: "backend",
    description: "Postgres, authentication, storage, and edge functions.",
    capabilities: ["database", "auth", "storage", "functions"],
    reach: ["cli", "api", "mcp"],
    cliBin: "supabase",
    docsUrl: "https://supabase.com/docs",
  },
  {
    id: "neon",
    label: "Neon",
    category: "database",
    description: "Serverless Postgres with isolated branches.",
    capabilities: ["database"],
    reach: ["cli", "api", "mcp"],
    cliBin: "neonctl",
    docsUrl: "https://neon.tech/docs",
  },
  {
    id: "firebase",
    label: "Firebase",
    category: "backend",
    description: "Authentication, app data, storage, functions, and hosting.",
    capabilities: ["database", "auth", "storage", "functions", "deploy"],
    reach: ["cli", "api"],
    cliBin: "firebase",
    docsUrl: "https://firebase.google.com/docs",
  },
  {
    id: "stripe",
    label: "Stripe",
    category: "payments",
    description: "Payments, subscriptions, invoices, and webhooks.",
    capabilities: ["payments"],
    reach: ["cli", "api", "mcp"],
    cliBin: "stripe",
    docsUrl: "https://docs.stripe.com/",
  },
  {
    id: "resend",
    label: "Resend",
    category: "email",
    description: "Transactional email delivery and domains.",
    capabilities: ["email"],
    reach: ["api"],
    docsUrl: "https://resend.com/docs",
  },
  {
    id: "sentry",
    label: "Sentry",
    category: "observability",
    description: "Error tracking, tracing, and release health.",
    capabilities: ["observability"],
    reach: ["cli", "api"],
    cliBin: "sentry-cli",
    docsUrl: "https://docs.sentry.io/",
  },
  {
    id: "upstash",
    label: "Upstash",
    category: "cache",
    description: "Serverless Redis, queues, and workflow primitives.",
    capabilities: ["cache", "database"],
    reach: ["cli", "api"],
    cliBin: "upstash",
    docsUrl: "https://upstash.com/docs",
  },
  {
    id: "infisical",
    label: "Infisical",
    category: "secrets",
    description: "Manage and inject project secrets without storing values here.",
    capabilities: ["secrets"],
    reach: ["cli", "api"],
    cliBin: "infisical",
    docsUrl: "https://infisical.com/docs",
  },
  {
    id: "github",
    label: "GitHub",
    category: "source-control",
    description: "Repositories, pull requests, Actions, and deployments.",
    capabilities: ["source-control", "deploy"],
    reach: ["cli", "api", "mcp"],
    cliBin: "gh",
    docsUrl: "https://docs.github.com/",
  },
];

export const PROJECT_INTEGRATION_PROVIDERS = INTEGRATION_PROVIDERS;

const providerIds = new Set<IntegrationProviderId>(
  INTEGRATION_PROVIDERS.map((provider) => provider.id),
);

export function isIntegrationProviderId(value: unknown): value is IntegrationProviderId {
  return typeof value === "string" && providerIds.has(value as IntegrationProviderId);
}

export function integrationProviderById(
  id: string,
): IntegrationProvider | undefined {
  return INTEGRATION_PROVIDERS.find((provider) => provider.id === id);
}

export const projectIntegrationProviderById = integrationProviderById;

export type ProjectIntegrationStatus =
  | "connected"
  | "disconnected"
  | "needs-attention";

/** A safe remote-resource reference. No tokens, keys, env values, or config. */
export interface ProjectIntegrationConnection {
  providerId: IntegrationProviderId;
  status: ProjectIntegrationStatus;
  resourceId?: string;
  resourceName?: string;
  environment?: string;
  connectedAt?: string;
  lastCheckedAt?: string;
  message?: string;
}

export type ProjectIntegrationResourceKind =
  | "database"
  | "cache"
  | "storage"
  | "queue"
  | "auth"
  | "functions"
  | "payments"
  | "email"
  | "observability"
  | "secrets"
  | "other";

/**
 * One concrete provider-owned resource used by this project. `endpoint` is a
 * public location only; normalization rejects URL userinfo and query strings
 * so a connection string or signed URL can never be persisted by accident.
 */
export interface ProjectIntegrationResource {
  providerId: IntegrationProviderId;
  resourceId: string;
  resourceName?: string;
  kind: ProjectIntegrationResourceKind;
  endpoint?: string;
  environment?: string;
  componentId?: string;
  status: ProjectIntegrationStatus;
  latestMigration?: string;
  lastObservedAt?: string;
  message?: string;
}

export interface ProjectDeploymentState {
  providerId: IntegrationProviderId;
  deploymentId?: string;
  status: ProjectIntegrationStatus;
  resourceId?: string;
  resourceName?: string;
  environment?: string;
  componentId?: string;
  url?: string;
  branch?: string;
  lastDeployedAt?: string;
  message?: string;
}

export interface ProjectIntegrationState {
  version: typeof PROJECT_INTEGRATIONS_VERSION;
  connections: ProjectIntegrationConnection[];
  resources: ProjectIntegrationResource[];
  deployments: ProjectDeploymentState[];
}

/** Alternate name for callers that use the project field name as the type. */
export type ProjectIntegrations = ProjectIntegrationState;

export const EMPTY_PROJECT_INTEGRATIONS: ProjectIntegrationState = {
  version: PROJECT_INTEGRATIONS_VERSION,
  connections: [],
  resources: [],
  deployments: [],
};

export function createProjectIntegrationState(): ProjectIntegrationState {
  return {
    ...EMPTY_PROJECT_INTEGRATIONS,
    connections: [],
    resources: [],
    deployments: [],
  };
}

export const emptyProjectIntegrations = createProjectIntegrationState;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const statuses = new Set<ProjectIntegrationStatus>([
  "connected",
  "disconnected",
  "needs-attention",
]);

const status = (value: unknown): ProjectIntegrationStatus | null =>
  typeof value === "string" && statuses.has(value as ProjectIntegrationStatus)
    ? value as ProjectIntegrationStatus
    : null;

/**
 * Bound persisted strings so a corrupt workspace cannot turn into an
 * unbounded settings row. Trimming is deliberate: these values are display
 * labels and identifiers, never opaque credentials.
 */
const safeText = (value: unknown, max = 512): string | undefined => {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  return next ? next.slice(0, max) : undefined;
};

const safeDate = (value: unknown): string | undefined => {
  const next = safeText(value, 64);
  return next && Number.isFinite(Date.parse(next)) ? next : undefined;
};

const safeUrl = (value: unknown): string | undefined => {
  const candidate = safeText(value, 2_048);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    )
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const resourceKinds = new Set<ProjectIntegrationResourceKind>([
  "database",
  "cache",
  "storage",
  "queue",
  "auth",
  "functions",
  "payments",
  "email",
  "observability",
  "secrets",
  "other",
]);

const resourceKind = (value: unknown): ProjectIntegrationResourceKind | null =>
  typeof value === "string" &&
  resourceKinds.has(value as ProjectIntegrationResourceKind)
    ? value as ProjectIntegrationResourceKind
    : null;

const safeEndpoint = (value: unknown): string | undefined => {
  const candidate = safeText(value, 2_048);
  if (!candidate) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      const allowed = new Set(["http:", "https:", "postgres:", "postgresql:", "redis:", "rediss:"]);
      if (
        !allowed.has(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) return undefined;
      return parsed.toString();
    } catch {
      return undefined;
    }
  }
  // Provider APIs also report bare public hosts. Reject anything that could be
  // userinfo, a query, whitespace, or shell-like input.
  return /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._~/-]*)?$/.test(candidate) &&
    !candidate.includes("@")
    ? candidate
    : undefined;
};

function normalizeConnection(value: unknown): ProjectIntegrationConnection | null {
  const raw = record(value);
  if (!raw || !isIntegrationProviderId(raw.providerId)) return null;
  const normalizedStatus = status(raw.status);
  if (!normalizedStatus) return null;
  const result: ProjectIntegrationConnection = {
    providerId: raw.providerId,
    status: normalizedStatus,
  };
  const resourceId = safeText(raw.resourceId);
  const resourceName = safeText(raw.resourceName);
  const environment = safeText(raw.environment, 128);
  const connectedAt = safeDate(raw.connectedAt);
  const lastCheckedAt = safeDate(raw.lastCheckedAt);
  const message = safeText(raw.message, 1_024);
  if (resourceId) result.resourceId = resourceId;
  if (resourceName) result.resourceName = resourceName;
  if (environment) result.environment = environment;
  if (connectedAt) result.connectedAt = connectedAt;
  if (lastCheckedAt) result.lastCheckedAt = lastCheckedAt;
  if (message) result.message = message;
  return result;
}

function normalizeResource(value: unknown): ProjectIntegrationResource | null {
  const raw = record(value);
  if (!raw || !isIntegrationProviderId(raw.providerId)) return null;
  const resourceId = safeText(raw.resourceId);
  const kind = resourceKind(raw.kind);
  const normalizedStatus = status(raw.status);
  if (!resourceId || !kind || !normalizedStatus) return null;
  const result: ProjectIntegrationResource = {
    providerId: raw.providerId,
    resourceId,
    kind,
    status: normalizedStatus,
  };
  const resourceName = safeText(raw.resourceName);
  const endpoint = safeEndpoint(raw.endpoint);
  const environment = safeText(raw.environment, 128);
  const componentId = safeText(raw.componentId);
  const latestMigration = safeText(raw.latestMigration, 512);
  const lastObservedAt = safeDate(raw.lastObservedAt);
  const message = safeText(raw.message, 1_024);
  if (resourceName) result.resourceName = resourceName;
  if (endpoint) result.endpoint = endpoint;
  if (environment) result.environment = environment;
  if (componentId) result.componentId = componentId;
  if (latestMigration) result.latestMigration = latestMigration;
  if (lastObservedAt) result.lastObservedAt = lastObservedAt;
  if (message) result.message = message;
  return result;
}

function normalizeDeployment(value: unknown): ProjectDeploymentState | null {
  const raw = record(value);
  if (!raw || !isIntegrationProviderId(raw.providerId)) return null;
  const provider = integrationProviderById(raw.providerId);
  const normalizedStatus = status(raw.status);
  if (!provider?.capabilities.includes("deploy") || !normalizedStatus) return null;
  const result: ProjectDeploymentState = {
    providerId: raw.providerId,
    status: normalizedStatus,
  };
  const deploymentId = safeText(raw.deploymentId);
  const resourceId = safeText(raw.resourceId);
  const resourceName = safeText(raw.resourceName);
  const environment = safeText(raw.environment, 128);
  const componentId = safeText(raw.componentId);
  const url = safeUrl(raw.url);
  const branch = safeText(raw.branch, 256);
  const lastDeployedAt = safeDate(raw.lastDeployedAt);
  const message = safeText(raw.message, 1_024);
  if (deploymentId) result.deploymentId = deploymentId;
  if (resourceId) result.resourceId = resourceId;
  if (resourceName) result.resourceName = resourceName;
  if (environment) result.environment = environment;
  if (componentId) result.componentId = componentId;
  if (url) result.url = url;
  if (branch) result.branch = branch;
  if (lastDeployedAt) result.lastDeployedAt = lastDeployedAt;
  if (message) result.message = message;
  return result;
}

/**
 * Treat persisted data as hostile/old input. Unknown providers and fields are
 * dropped, duplicate connections/resources/deployments collapse with the last
 * valid value winning, and unsupported schema versions start clean instead of
 * being half-read. The former singular `deployment` spelling is migrated.
 */
export function normalizeProjectIntegrations(value: unknown): ProjectIntegrationState {
  const raw = record(value);
  if (!raw || raw.version !== PROJECT_INTEGRATIONS_VERSION) {
    return createProjectIntegrationState();
  }

  const byProvider = new Map<IntegrationProviderId, ProjectIntegrationConnection>();
  if (Array.isArray(raw.connections)) {
    for (const item of raw.connections) {
      const connection = normalizeConnection(item);
      if (connection) byProvider.set(connection.providerId, connection);
    }
  }

  const resources = new Map<string, ProjectIntegrationResource>();
  if (Array.isArray(raw.resources)) {
    for (const item of raw.resources) {
      const resource = normalizeResource(item);
      if (resource) resources.set(`${resource.providerId}\0${resource.resourceId}`, resource);
    }
  }

  const deployments = new Map<string, ProjectDeploymentState>();
  const rawDeployments = Array.isArray(raw.deployments)
    ? raw.deployments
    : raw.deployment == null
      ? []
      : [raw.deployment];
  for (const item of rawDeployments) {
    const deployment = normalizeDeployment(item);
    if (!deployment) continue;
    const key = deployment.deploymentId
      ? `${deployment.providerId}\0id\0${deployment.deploymentId}`
      : [
          deployment.providerId,
          deployment.componentId ?? "",
          deployment.environment ?? "",
          deployment.lastDeployedAt ?? "",
          deployment.url ?? "",
        ].join("\0");
    deployments.set(key, deployment);
  }

  return {
    version: PROJECT_INTEGRATIONS_VERSION,
    connections: INTEGRATION_PROVIDERS.flatMap((provider) => {
      const connection = byProvider.get(provider.id);
      return connection ? [connection] : [];
    }),
    resources: [...resources.values()],
    deployments: [...deployments.values()],
  };
}

export const normalizeProjectIntegrationState = normalizeProjectIntegrations;

export type ProjectIntegrationAction =
  | { type: "set-connection"; connection: ProjectIntegrationConnection }
  | { type: "remove-connection"; providerId: IntegrationProviderId }
  | {
      type: "set-status";
      providerId: IntegrationProviderId;
      status: ProjectIntegrationStatus;
      message?: string;
      lastCheckedAt?: string;
    }
  | { type: "set-resource"; resource: ProjectIntegrationResource }
  | {
      type: "remove-resource";
      providerId: IntegrationProviderId;
      resourceId: string;
    }
  | { type: "set-deployment"; deployment: ProjectDeploymentState }
  | { type: "record-deployment"; deployment: ProjectDeploymentState }
  | { type: "clear-deployment" }
  | {
      type: "clear-deployments";
      providerId?: IntegrationProviderId;
      componentId?: string;
      environment?: string;
    }
  | { type: "reset" };

/** Pure reducer suitable for React and for Project update callbacks. */
export function projectIntegrationsReducer(
  state: ProjectIntegrationState,
  action: ProjectIntegrationAction,
): ProjectIntegrationState {
  const current = normalizeProjectIntegrations(state);
  switch (action.type) {
    case "set-connection": {
      const connection = normalizeConnection(action.connection);
      if (!connection) return current;
      return normalizeProjectIntegrations({
        ...current,
        connections: [
          ...current.connections.filter(
            (item) => item.providerId !== connection.providerId,
          ),
          connection,
        ],
      });
    }
    case "remove-connection": {
      const connections = current.connections.filter(
        (item) => item.providerId !== action.providerId,
      );
      const resources = current.resources.filter(
        (item) => item.providerId !== action.providerId,
      );
      const deployments = current.deployments.filter(
        (item) => item.providerId !== action.providerId,
      );
      if (
        connections.length === current.connections.length &&
        resources.length === current.resources.length &&
        deployments.length === current.deployments.length
      ) return current;
      return { ...current, connections, resources, deployments };
    }
    case "set-status": {
      const existing = selectProjectIntegration(current, action.providerId);
      if (!existing) return current;
      const next: ProjectIntegrationConnection = {
        ...existing,
        status: action.status,
      };
      const message = safeText(action.message, 1_024);
      const lastCheckedAt = safeDate(action.lastCheckedAt);
      if (message) next.message = message;
      else delete next.message;
      if (lastCheckedAt) next.lastCheckedAt = lastCheckedAt;
      return {
        ...current,
        connections: current.connections.map((connection) =>
          connection.providerId === action.providerId ? next : connection,
        ),
      };
    }
    case "set-resource": {
      const resource = normalizeResource(action.resource);
      if (!resource) return current;
      return normalizeProjectIntegrations({
        ...current,
        resources: [
          ...current.resources.filter((item) =>
            item.providerId !== resource.providerId ||
            item.resourceId !== resource.resourceId
          ),
          resource,
        ],
      });
    }
    case "remove-resource": {
      const resources = current.resources.filter((item) =>
        item.providerId !== action.providerId || item.resourceId !== action.resourceId
      );
      return resources.length === current.resources.length
        ? current
        : { ...current, resources };
    }
    case "set-deployment":
    case "record-deployment": {
      const deployment = normalizeDeployment(action.deployment);
      if (!deployment) return current;
      return normalizeProjectIntegrations({
        ...current,
        deployments: [...current.deployments, deployment],
      });
    }
    case "clear-deployment":
      return current.deployments.length
        ? { ...current, deployments: [] }
        : current;
    case "clear-deployments": {
      const deployments = current.deployments.filter((deployment) => {
        if (action.providerId && deployment.providerId !== action.providerId) return true;
        if (action.componentId && deployment.componentId !== action.componentId) return true;
        if (action.environment && deployment.environment !== action.environment) return true;
        return false;
      });
      return deployments.length === current.deployments.length
        ? current
        : { ...current, deployments };
    }
    case "reset":
      return createProjectIntegrationState();
  }
}

export const reduceProjectIntegrations = projectIntegrationsReducer;

export function selectProjectIntegration(
  state: ProjectIntegrationState,
  providerId: IntegrationProviderId,
): ProjectIntegrationConnection | undefined {
  return state.connections.find((connection) => connection.providerId === providerId);
}

export const selectIntegration = selectProjectIntegration;

export function selectConnectedIntegrations(
  state: ProjectIntegrationState,
): ProjectIntegrationConnection[] {
  return state.connections.filter((connection) => connection.status === "connected");
}

export function selectIntegrationsNeedingAttention(
  state: ProjectIntegrationState,
): ProjectIntegrationConnection[] {
  return state.connections.filter(
    (connection) => connection.status === "needs-attention",
  );
}

export function selectDeployment(
  state: ProjectIntegrationState,
): ProjectDeploymentState | null {
  return selectLatestDeployment(state);
}

export function selectProjectResources(
  state: ProjectIntegrationState,
): ProjectIntegrationResource[] {
  return state.resources;
}

export function selectResourcesByProvider(
  state: ProjectIntegrationState,
  providerId: IntegrationProviderId,
): ProjectIntegrationResource[] {
  return state.resources.filter((resource) => resource.providerId === providerId);
}

export interface DeploymentSelector {
  environment?: string;
  componentId?: string;
}

/** Latest by observed deployment time; later array order wins ties/missing dates. */
export function selectLatestDeployment(
  state: ProjectIntegrationState,
  selector: DeploymentSelector = {},
): ProjectDeploymentState | null {
  let latest: ProjectDeploymentState | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const deployment of state.deployments) {
    if (selector.environment && deployment.environment !== selector.environment) continue;
    if (selector.componentId && deployment.componentId !== selector.componentId) continue;
    const deployedAt = deployment.lastDeployedAt
      ? Date.parse(deployment.lastDeployedAt)
      : Number.NEGATIVE_INFINITY;
    if (deployedAt >= latestAt) {
      latest = deployment;
      latestAt = deployedAt;
    }
  }
  return latest;
}

export function selectLatestDeploymentByEnvironment(
  state: ProjectIntegrationState,
  environment: string,
): ProjectDeploymentState | null {
  return selectLatestDeployment(state, { environment });
}

export function selectLatestDeploymentByComponent(
  state: ProjectIntegrationState,
  componentId: string,
): ProjectDeploymentState | null {
  return selectLatestDeployment(state, { componentId });
}

export function selectProvidersByCategory(
  category: IntegrationCategory,
): IntegrationProvider[] {
  return INTEGRATION_PROVIDERS.filter((provider) => provider.category === category);
}

export function selectDeploymentProviders(): IntegrationProvider[] {
  return INTEGRATION_PROVIDERS.filter((provider) =>
    provider.capabilities.includes("deploy"),
  );
}

export function selectAvailableProviders(
  state: ProjectIntegrationState,
): IntegrationProvider[] {
  const configured = new Set(state.connections.map((connection) => connection.providerId));
  return INTEGRATION_PROVIDERS.filter((provider) => !configured.has(provider.id));
}

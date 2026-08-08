import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PROVIDERS,
  PROJECT_INTEGRATIONS_VERSION,
  createProjectIntegrationState,
  integrationProviderById,
  normalizeProjectIntegrations,
  projectIntegrationsReducer,
  selectAvailableProviders,
  selectConnectedIntegrations,
  selectDeploymentProviders,
  selectIntegrationsNeedingAttention,
  selectLatestDeployment,
  selectLatestDeploymentByComponent,
  selectLatestDeploymentByEnvironment,
  selectProjectIntegration,
  selectResourcesByProvider,
} from "./projectIntegrations";

describe("project integration provider catalog", () => {
  it("contains the supported providers once and exposes a headless route", () => {
    expect(INTEGRATION_PROVIDERS.map((provider) => provider.id)).toEqual([
      "vercel",
      "fly",
      "cloudflare",
      "supabase",
      "neon",
      "firebase",
      "stripe",
      "resend",
      "sentry",
      "upstash",
      "infisical",
      "github",
    ]);
    expect(new Set(INTEGRATION_PROVIDERS.map((provider) => provider.id)).size).toBe(12);
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(provider.reach.length, provider.id).toBeGreaterThan(0);
      if (provider.reach.includes("cli")) expect(provider.cliBin, provider.id).toBeTruthy();
    }
  });

  it("can select deployment-capable providers without mistaking every service for hosting", () => {
    expect(selectDeploymentProviders().map((provider) => provider.id)).toEqual([
      "vercel",
      "fly",
      "cloudflare",
      "firebase",
      "github",
    ]);
    expect(integrationProviderById("stripe")?.capabilities).toContain("payments");
    expect(integrationProviderById("unknown")).toBeUndefined();
  });
});

describe("normalizeProjectIntegrations", () => {
  it("returns fresh empty state for absent, malformed, or future data", () => {
    expect(normalizeProjectIntegrations(null)).toEqual(createProjectIntegrationState());
    expect(normalizeProjectIntegrations({ version: 2, connections: [] })).toEqual(
      createProjectIntegrationState(),
    );
    expect(normalizeProjectIntegrations({
      version: PROJECT_INTEGRATIONS_VERSION,
      connections: "not-an-array",
      resources: "not-an-array",
      deployments: "not-an-array",
      deployment: "not-an-object",
    })).toEqual(createProjectIntegrationState());
  });

  it("drops unknown providers and fields, validates display metadata, and deduplicates", () => {
    const normalized = normalizeProjectIntegrations({
      version: 1,
      connections: [
        {
          providerId: "stripe",
          status: "connected",
          resourceName: " Old account ",
        },
        { providerId: "made-up", status: "connected" },
        { providerId: "neon", status: "invented" },
        {
          providerId: "stripe",
          status: "needs-attention",
          resourceName: " Billing ",
          connectedAt: "not-a-date",
          token: "must-not-survive",
        },
      ],
      resources: [
        {
          providerId: "neon",
          resourceId: "db-1",
          resourceName: " Primary DB ",
          kind: "database",
          endpoint: "postgresql://db.example.test:5432/app",
          environment: " production ",
          status: "connected",
          latestMigration: " 0042_orders.sql ",
          lastObservedAt: "2026-08-07T09:00:00.000Z",
          password: "must-not-survive",
        },
        {
          providerId: "neon",
          resourceId: "db-1",
          kind: "database",
          endpoint: "postgresql://user:secret@db.example.test/app",
          status: "needs-attention",
        },
      ],
      deployment: {
        providerId: "vercel",
        status: "connected",
        url: "https://example.test/app",
        branch: " main ",
        apiKey: "must-not-survive",
      },
      accessToken: "must-not-survive",
    });

    expect(normalized.connections).toEqual([
      {
        providerId: "stripe",
        status: "needs-attention",
        resourceName: "Billing",
      },
    ]);
    expect(normalized.resources).toEqual([{
      providerId: "neon",
      resourceId: "db-1",
      kind: "database",
      status: "needs-attention",
    }]);
    expect(normalized.deployments).toEqual([{
      providerId: "vercel",
      status: "connected",
      url: "https://example.test/app",
      branch: "main",
    }]);
    expect(JSON.stringify(normalized)).not.toMatch(/token|apiKey/i);
  });

  it("rejects non-deployment providers and unsafe deployment URLs", () => {
    expect(normalizeProjectIntegrations({
      version: 1,
      connections: [],
      deployment: { providerId: "stripe", status: "connected" },
    }).deployments).toEqual([]);

    expect(normalizeProjectIntegrations({
      version: 1,
      connections: [],
      deployment: {
        providerId: "vercel",
        status: "connected",
        url: "javascript:alert(1)",
      },
    }).deployments).toEqual([{ providerId: "vercel", status: "connected" }]);
  });

  it("normalizes resource observations without persisting credential-bearing endpoints", () => {
    const normalized = normalizeProjectIntegrations({
      version: 1,
      connections: [],
      resources: [
        {
          providerId: "supabase",
          resourceId: "database",
          kind: "database",
          endpoint: "https://user:password@example.test/database?token=secret",
          environment: "preview",
          componentId: "api",
          status: "connected",
          latestMigration: "20260807_add_jobs",
          lastObservedAt: "2026-08-07T11:00:00.000Z",
        },
      ],
      deployments: [],
    });

    expect(normalized.resources).toEqual([{
      providerId: "supabase",
      resourceId: "database",
      kind: "database",
      environment: "preview",
      componentId: "api",
      status: "connected",
      latestMigration: "20260807_add_jobs",
      lastObservedAt: "2026-08-07T11:00:00.000Z",
    }]);
    expect(JSON.stringify(normalized)).not.toContain("password");
    expect(JSON.stringify(normalized)).not.toContain("secret");
  });
});

describe("projectIntegrationsReducer", () => {
  it("adds and replaces one connection per provider without mutating the input", () => {
    const empty = createProjectIntegrationState();
    const connected = projectIntegrationsReducer(empty, {
      type: "set-connection",
      connection: {
        providerId: "supabase",
        status: "connected",
        resourceId: "project-1",
      },
    });
    const replaced = projectIntegrationsReducer(connected, {
      type: "set-connection",
      connection: {
        providerId: "supabase",
        status: "needs-attention",
        resourceId: "project-2",
      },
    });

    expect(empty.connections).toEqual([]);
    expect(replaced.connections).toEqual([{
      providerId: "supabase",
      status: "needs-attention",
      resourceId: "project-2",
    }]);
  });

  it("updates status, resources and deployments, then cascades when its connection is removed", () => {
    let state = projectIntegrationsReducer(createProjectIntegrationState(), {
      type: "set-connection",
      connection: { providerId: "vercel", status: "connected" },
    });
    state = projectIntegrationsReducer(state, {
      type: "set-resource",
      resource: {
        providerId: "vercel",
        resourceId: "web",
        kind: "functions",
        endpoint: "https://canopy.example",
        environment: "production",
        status: "connected",
        lastObservedAt: "2026-08-07T09:00:00.000Z",
      },
    });
    state = projectIntegrationsReducer(state, {
      type: "set-deployment",
      deployment: {
        providerId: "vercel",
        status: "connected",
        componentId: "web",
        environment: "production",
        url: "https://canopy.example",
        lastDeployedAt: "2026-08-07T10:00:00.000Z",
      },
    });
    state = projectIntegrationsReducer(state, {
      type: "set-status",
      providerId: "vercel",
      status: "needs-attention",
      message: " Reconnect the account ",
      lastCheckedAt: "2026-08-07T10:00:00.000Z",
    });

    expect(selectIntegrationsNeedingAttention(state)).toEqual([{
      providerId: "vercel",
      status: "needs-attention",
      message: "Reconnect the account",
      lastCheckedAt: "2026-08-07T10:00:00.000Z",
    }]);
    expect(state.deployments[0]?.url).toBe("https://canopy.example/");
    expect(selectResourcesByProvider(state, "vercel")).toHaveLength(1);

    state = projectIntegrationsReducer(state, {
      type: "remove-connection",
      providerId: "vercel",
    });
    expect(state).toEqual(createProjectIntegrationState());
  });

  it("upserts resources and deployment ids independently", () => {
    let state = projectIntegrationsReducer(createProjectIntegrationState(), {
      type: "set-resource",
      resource: {
        providerId: "neon",
        resourceId: "db",
        kind: "database",
        status: "connected",
      },
    });
    state = projectIntegrationsReducer(state, {
      type: "set-resource",
      resource: {
        providerId: "neon",
        resourceId: "db",
        kind: "database",
        status: "needs-attention",
        latestMigration: "0042",
      },
    });
    for (const lastDeployedAt of [
      "2026-08-07T10:00:00.000Z",
      "2026-08-07T11:00:00.000Z",
    ]) {
      state = projectIntegrationsReducer(state, {
        type: "record-deployment",
        deployment: {
          providerId: "vercel",
          deploymentId: "dep-1",
          status: "connected",
          lastDeployedAt,
        },
      });
    }
    expect(state.resources).toEqual([{
      providerId: "neon",
      resourceId: "db",
      kind: "database",
      status: "needs-attention",
      latestMigration: "0042",
    }]);
    expect(state.deployments).toHaveLength(1);
    expect(state.deployments[0].lastDeployedAt).toBe("2026-08-07T11:00:00.000Z");
  });

  it("ignores a status update for an integration that is not configured", () => {
    const empty = createProjectIntegrationState();
    expect(projectIntegrationsReducer(empty, {
      type: "set-status",
      providerId: "stripe",
      status: "connected",
    })).toEqual(empty);
  });
});

describe("project integration selectors", () => {
  it("selects configured, connected, attention, and available providers", () => {
    const state = normalizeProjectIntegrations({
      version: 1,
      connections: [
        { providerId: "neon", status: "connected" },
        { providerId: "sentry", status: "needs-attention" },
        { providerId: "resend", status: "disconnected" },
      ],
      resources: [],
      deployments: [
        {
          providerId: "vercel",
          deploymentId: "old-production",
          componentId: "web",
          environment: "production",
          status: "connected",
          lastDeployedAt: "2026-08-07T08:00:00.000Z",
        },
        {
          providerId: "cloudflare",
          deploymentId: "worker-preview",
          componentId: "worker",
          environment: "preview",
          status: "connected",
          lastDeployedAt: "2026-08-07T11:00:00.000Z",
        },
        {
          providerId: "vercel",
          deploymentId: "new-production",
          componentId: "web",
          environment: "production",
          status: "connected",
          lastDeployedAt: "2026-08-07T12:00:00.000Z",
        },
      ],
    });

    expect(selectProjectIntegration(state, "neon")?.status).toBe("connected");
    expect(selectConnectedIntegrations(state).map((item) => item.providerId)).toEqual(["neon"]);
    expect(selectIntegrationsNeedingAttention(state).map((item) => item.providerId)).toEqual([
      "sentry",
    ]);
    expect(selectAvailableProviders(state).map((provider) => provider.id)).not.toContain("resend");
    expect(selectAvailableProviders(state)).toHaveLength(INTEGRATION_PROVIDERS.length - 3);
    expect(selectLatestDeployment(state)?.deploymentId).toBe("new-production");
    expect(selectLatestDeploymentByEnvironment(state, "preview")?.deploymentId).toBe(
      "worker-preview",
    );
    expect(selectLatestDeploymentByComponent(state, "web")?.deploymentId).toBe(
      "new-production",
    );
  });
});

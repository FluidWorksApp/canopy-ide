// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../projects";
import { normalizeProjectIntegrations } from "../projectIntegrations";
import { IntegrationsPanel, type LocalIntegrationService } from "./IntegrationsPanel";

const project: Project = {
  id: "project-1",
  name: "Login app",
  components: [
    { id: "web", label: "Frontend", path: "/repo/web", role: "web" },
    { id: "api", label: "Backend", path: "/repo/api", role: "api" },
  ],
  vibe: {
    version: 1,
    enabled: true,
    dataStores: [{
      id: "users-db",
      label: "Users",
      engine: "postgresql",
      mode: "managed",
      providerId: "supabase",
      componentIds: ["api"],
      schemaPaths: ["db/schema.sql"],
      migrationPaths: ["db/migrations"],
      latestMigration: "0042_add_sessions",
    }],
    externalServices: [],
  },
};

const local: LocalIntegrationService[] = [
  {
    id: "/repo/web\0dev",
    component: "Frontend",
    name: "Web",
    state: "running",
    ports: [4173],
    canStart: false,
    canStop: true,
  },
  {
    id: "/repo/api\0dev",
    component: "Backend",
    name: "API",
    state: "stopped",
    ports: [],
    canStart: true,
    canStop: false,
  },
];

const state = normalizeProjectIntegrations({
  version: 1,
  connections: [{
    providerId: "supabase",
    status: "connected",
    resourceName: "Login app",
    lastCheckedAt: "2026-08-07T10:00:00.000Z",
  }],
  resources: [{
    providerId: "supabase",
    resourceId: "db-1",
    resourceName: "Production database",
    kind: "database",
    environment: "production",
    endpoint: "https://db.example.test",
    status: "connected",
    latestMigration: "0042_add_sessions",
  }],
  deployments: [
    {
      providerId: "vercel",
      deploymentId: "old",
      status: "connected",
      environment: "production",
      url: "https://old.example.test",
      lastDeployedAt: "2026-08-07T09:00:00.000Z",
    },
    {
      providerId: "fly",
      deploymentId: "new",
      resourceName: "Backend",
      status: "connected",
      environment: "production",
      url: "https://api.example.test",
      lastDeployedAt: "2026-08-07T11:00:00.000Z",
    },
  ],
});

const setup = () => {
  const actions = {
    onChange: vi.fn(),
    onAutomate: vi.fn(),
    onStartLocal: vi.fn(),
    onStopLocal: vi.fn(),
    onOpenLocal: vi.fn(),
    onOpenRemote: vi.fn(),
  };
  render(
    <IntegrationsPanel
      project={project}
      state={state}
      localServices={local}
      {...actions}
    />,
  );
  return actions;
};

describe("IntegrationsPanel", () => {
  it("keeps the local layer usable independently of cloud account state", () => {
    const actions = setup();
    fireEvent.click(screen.getByText(":4173"));
    fireEvent.click(screen.getByTitle("Start API"));
    fireEvent.click(screen.getByTitle("Stop Web"));

    expect(actions.onOpenLocal).toHaveBeenCalledWith(4173);
    expect(actions.onStartLocal).toHaveBeenCalledWith("/repo/api\0dev");
    expect(actions.onStopLocal).toHaveBeenCalledWith("/repo/web\0dev");
    expect(screen.getByText("Local runs stay available while an account is linking.")).toBeTruthy();
  });

  it("shows provider resources, migration snapshots, and the actual latest deployment", () => {
    const actions = setup();
    expect(screen.getAllByText(/0042_add_sessions/)).toHaveLength(2);
    expect(document.querySelector(".integration-deployment-latest")?.textContent).toContain("Backend");
    expect(document.querySelector(".integration-deployment-latest")?.textContent).toContain("latest");

    fireEvent.click(document.querySelector(".integration-deployment-latest .integration-text-action") as HTMLElement);
    expect(actions.onOpenRemote).toHaveBeenCalledWith("https://api.example.test/");
  });

  it("offers the full autonomous provider catalog and starts an API-first setup", () => {
    const actions = setup();
    fireEvent.click(screen.getByText("Add an integration"));

    expect(screen.getByText("Backend platforms")).toBeTruthy();
    expect(screen.getByText("Secrets & security")).toBeTruthy();
    expect(screen.getAllByText("CLI · API · MCP").length).toBeGreaterThan(0);
    const supabaseRow = screen.getAllByText("Supabase")
      .map((element) => element.closest(".integration-provider-row"))
      .find(Boolean);
    expect(supabaseRow?.textContent).toContain("needed");
    fireEvent.click(supabaseRow?.querySelector("button") as HTMLButtonElement);
    expect(actions.onAutomate).toHaveBeenCalledWith("supabase");
  });

  it("never renders a credential field or secret value", () => {
    setup();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/access[_ -]?token|api[_ -]?key/i);
  });
});

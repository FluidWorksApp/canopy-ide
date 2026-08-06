import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import {
  fleetRouteFromEvidence,
  inspectFleetRoute,
  inspectFleetTable,
} from "./fleetSnapshot";

const NOW = 1_700_000_000_000;
const claude = { id: "claude", name: "Claude Code", bin: "claude" };
const codex = { id: "codex", name: "Codex", bin: "codex" };
const aider = { id: "aider", name: "Aider", bin: "aider" };
const account = (agent: string, state: ipc.AccountStatus["state"]) => ({
  agent,
  state,
  account: state === "in" ? `${agent}@example.com` : null,
});
const plan = (agent: string, profile: string, used: number): ipc.PlanUsage => ({
  agent,
  profile,
  plan: "pro",
  windows: [{ label: "5h", used_percent: used, resets_at: null }],
  credits: null,
  observed: Math.floor(Date.now() / 1000),
});
const health = (agent: string): ipc.IntegrationHealth => ({
  agent,
  cli_installed: true,
  hooks: "ours",
  mcp: "ours",
});

afterEach(() => vi.restoreAllMocks());

describe("fleetRouteFromEvidence", () => {
  it("composes the exact CLI and profile inputs", () => {
    const route = fleetRouteFromEvidence(
      claude,
      "work",
      { claude: true },
      {
        accounts: {
          default: [account("claude", "out")],
          work: [account("claude", "in")],
        },
        plans: [plan("claude", "default", 95), plan("claude", "work", 10)],
        health: [health("claude")],
      },
      NOW,
    );

    expect(route.account?.state).toBe("in");
    expect(route.plan?.profile).toBe("work");
    expect(route.health).toBeUndefined();
    expect(route.state).toMatchObject({
      agent: "claude",
      profile: "work",
      kind: "ready",
      reasons: [],
    });
  });

  it("uses the resolved binary's installed state", () => {
    const route = fleetRouteFromEvidence(
      { ...claude, bin: "company-claude" },
      "default",
      { claude: true, "company-claude": false },
      { accounts: {} },
      NOW,
    );
    expect(route.state).toMatchObject({
      kind: "unusable",
      reasons: ["not-installed"],
    });
  });
});

describe("fleet inspection", () => {
  it("keeps failed optional probes unknown instead of inventing signed-out", async () => {
    vi.spyOn(ipc, "profileAccounts").mockRejectedValue(new Error("unreadable"));
    vi.spyOn(ipc, "planUsage").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(ipc, "agentIntegrationHealth").mockRejectedValue(
      new Error("unavailable"),
    );

    const route = await inspectFleetRoute(claude, "default", { claude: true });

    expect(route.state).toMatchObject({ kind: "ready", reasons: [] });
    expect(route.account).toBeUndefined();
    expect(route.plan).toBeNull();
    expect(route.health).toBeUndefined();
  });

  it("builds default routes for every CLI and named routes only where supported", async () => {
    vi.spyOn(ipc, "profileAccounts").mockImplementation(async (profile) =>
      profile === "work"
        ? [account("claude", "out"), account("codex", "in")]
        : [account("claude", "in"), account("codex", "in")],
    );
    vi.spyOn(ipc, "planUsage").mockResolvedValue([
      plan("claude", "default", 10),
      plan("codex", "work", 95),
    ]);
    vi.spyOn(ipc, "agentIntegrationHealth").mockResolvedValue([
      health("claude"),
      health("codex"),
    ]);

    const rows = await inspectFleetTable(
      [claude, codex, aider],
      [
        { id: "default", label: "Default", root: "/home", removable: false },
        { id: "work", label: "Work", root: "/work", removable: true },
      ],
      { claude: true, codex: true, aider: true },
    );

    expect(rows.map((row) => `${row.cli.id}:${row.profile}`)).toEqual([
      "claude:default",
      "codex:default",
      "aider:default",
      "claude:work",
      "codex:work",
    ]);
    expect(rows.find((row) => row.cli.id === "claude" && row.profile === "work")?.state)
      .toMatchObject({ kind: "unusable", reasons: ["signed-out"] });
    expect(rows.find((row) => row.cli.id === "codex" && row.profile === "work")?.state)
      .toMatchObject({ kind: "degraded", reasons: ["plan-critical"] });
  });
});

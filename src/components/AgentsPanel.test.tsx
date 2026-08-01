// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentsPanel } from "./AgentsPanel";
import type * as ipcTypes from "../ipc";

// Six agents in a project are six rows that used to all say "claude". These
// cover the one thing that tells them apart: the name of the tab each is
// running in — the CLI's own title for it, or the user's rename over that.

vi.mock("../ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve([]),
  contextClaims: () => Promise.resolve([]),
  onAgentClaims: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  onIntegrationHealth: () => Promise.resolve(() => {}),
  agentIntegrationHealth: () => Promise.resolve([]),
  agentHooksInstalled: () => Promise.resolve(true),
  contextReleaseClaim: () => Promise.resolve(),
  ptyKill: () => Promise.resolve(),
  sessionForget: () => Promise.resolve(),
  setupAgentHooks: () => Promise.resolve({ summary: "" }),
}));

const session = (over: Partial<ipcTypes.SessionStats> = {}): ipcTypes.SessionStats => ({
  id: 7,
  title: "shell",
  cwd: "/repo",
  total_cpu: 1,
  total_mem_bytes: 1000,
  quiet_ms: null,
  since_input_ms: null,
  output_bytes: 0,
  procs: [],
  ports: [],
  agent_hint: { bin: "claude", pkg: null, path: null, interactive: true },
  ...over,
});

const panel = (over: Partial<React.ComponentProps<typeof AgentsPanel>> = {}) =>
  render(
    <AgentsPanel
      visible={false}
      stats={[session()]}
      hookPath="/hook"
      roots={["/repo"]}
      shareContext={false}
      onShareContext={vi.fn()}
      {...over}
    />,
  );

describe("what a running agent is called", () => {
  it("takes the title the CLI gave its tab", () => {
    panel({ tabNames: new Map([[7, { title: "✳ Fix browser screenshots" }]]) });
    expect(screen.getByText("✳ Fix browser screenshots")).toBeTruthy();
    expect(screen.queryByText("claude")).toBeNull();
  });

  it("takes the user's rename over the CLI's title", () => {
    panel({
      tabNames: new Map([[7, { title: "✳ Fix browser screenshots", customTitle: "screenshots" }]]),
    });
    expect(screen.getByText("screenshots")).toBeTruthy();
  });

  it("names the CLI when its tab is still an untitled shell", () => {
    panel({ tabNames: new Map([[7, { title: "shell" }]]) });
    expect(screen.getByText("claude")).toBeTruthy();
  });

  it("names the CLI when the session has no tab at all", () => {
    // A detached micro-task runs with no tab in this window.
    panel({ tabNames: new Map() });
    expect(screen.getByText("claude")).toBeTruthy();
  });

  it("keeps rows apart when only their tab names differ", () => {
    panel({
      stats: [session({ id: 7 }), session({ id: 8 })],
      tabNames: new Map([
        [7, { title: "Fix the login redirect" }],
        [8, { title: "Android preview" }],
      ]),
    });
    expect(screen.getByText("Fix the login redirect")).toBeTruthy();
    expect(screen.getByText("Android preview")).toBeTruthy();
  });
});

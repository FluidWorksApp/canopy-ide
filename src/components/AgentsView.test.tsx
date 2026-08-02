// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsView } from "./AgentsView";
import type * as ipcTypes from "../ipc";

const digests: ipcTypes.SessionDigest[] = [];
const claims: ipcTypes.AgentClaim[] = [];

vi.mock("../ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve(digests),
  contextClaims: () => Promise.resolve(claims),
  onAgentClaims: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  onIntegrationHealth: () => Promise.resolve(() => {}),
  agentIntegrationHealth: () => Promise.resolve([]),
  agentUsage: () => Promise.resolve([]),
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

const page = (over: Partial<React.ComponentProps<typeof AgentsView>> = {}) =>
  render(
    <AgentsView
      active={false}
      projectName="canopy"
      roots={["/repo"]}
      stats={[session()]}
      hookPath="/hook"
      shareContext={false}
      onShareContext={vi.fn()}
      {...over}
    />,
  );

describe("the agents page", () => {
  it("names each running session by its tab, like the panel does", () => {
    page({
      stats: [session({ id: 7 }), session({ id: 8 })],
      tabNames: new Map([
        [7, { title: "Fix the login redirect" }],
        [8, { title: "Android preview" }],
      ]),
    });
    expect(screen.getByText("Fix the login redirect")).toBeTruthy();
    expect(screen.getByText("Android preview")).toBeTruthy();
  });

  it("counts what is running", () => {
    const { container } = page({ stats: [session({ id: 7 }), session({ id: 8 })] });
    const running = container.querySelector(".agv-stat");
    expect(within(running as HTMLElement).getByText("2")).toBeTruthy();
  });

  it("separates plain shells from agents", () => {
    const { container } = page({
      stats: [
        session({ id: 7 }),
        // No foreground program: a shell, not an agent.
        session({ id: 9, title: "zsh", agent_hint: null }),
      ],
    });
    expect(container.querySelectorAll(".agv-card")).toHaveLength(1);
    expect(container.querySelectorAll(".agv-term")).toHaveLength(1);
  });

  it("offers the empty state rather than an empty grid", () => {
    const { container } = page({ stats: [] });
    expect(container.querySelector(".agv-empty")).toBeTruthy();
    expect(container.querySelector(".agv-cards")).toBeNull();
  });

  it("opens a claim rather than leaving the row dead", async () => {
    claims.length = 0;
    claims.push({
      id: "c1",
      paths: ["/repo/src/auth.ts"],
      owner: "canopy (/repo)",
      note: "Rewriting the login redirect",
      at_ms: Date.now() - 60_000,
      released_at_ms: null,
      released_by: null,
      refusals: [],
    });
    const onOpenClaim = vi.fn();
    // Claims only load while the page is the tab in front.
    const { container } = page({ active: true, onOpenClaim });
    await waitFor(() => expect(container.querySelector(".agv-claim")).toBeTruthy());
    await userEvent.click(container.querySelector(".agv-claim") as HTMLElement);
    expect(onOpenClaim).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    claims.length = 0;
  });

  it("shows a question as an answerable card", () => {
    const onAnswer = vi.fn();
    page({
      onAnswer,
      pending: [
        {
          key: "q1",
          kind: "question",
          agent: "claude",
          ts: 0,
          message: "",
          cwd: "/repo",
          questions: [
            {
              question: "Which database?",
              header: "Storage",
              options: [{ label: "Postgres" }, { label: "SQLite" }],
            },
          ],
        } as never,
      ],
    });
    expect(screen.getByText("Which database?")).toBeTruthy();
    expect(screen.getByText("Needs your input")).toBeTruthy();
  });
});

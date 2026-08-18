// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentControlPanel } from "./AgentControlPanel";
import { LIFE_META } from "../../shared/agentLife";
import type * as ipcTypes from "../ipc";

const now = Math.floor(Date.now() / 1000);

const seams = vi.hoisted(() => ({
  digests: [] as unknown[],
  messages: [] as unknown[],
  severed: [] as unknown[],
  stats: [] as unknown[],
  severCalls: [] as { a: number; b: number; severed: boolean }[],
}));

vi.mock("../ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve(seams.digests),
  contextClaims: () => Promise.resolve([]),
  onAgentClaims: () => Promise.resolve(() => {}),
  contextMessages: () => Promise.resolve(seams.messages),
  onAgentMessage: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  ptyStats: () => Promise.resolve(seams.stats),
  onPtyStats: () => Promise.resolve(() => {}),
  meshSevered: () => Promise.resolve(seams.severed),
  meshSever: (a: number, b: number, severed: boolean) => {
    seams.severCalls.push({ a, b, severed });
    return Promise.resolve([]);
  },
}));

const session = (over: Partial<ipcTypes.SessionStats>): ipcTypes.SessionStats => ({
  id: 7,
  title: "claude",
  cwd: "/w/canopy",
  total_cpu: 0,
  total_mem_bytes: 1000,
  quiet_ms: 500_000,
  since_input_ms: 500_000,
  output_bytes: 10,
  procs: [],
  ports: [],
  agent_hint: { bin: "claude", pkg: null, path: null, interactive: true },
  ...over,
});

/** The lead in the main checkout, its executor in a workspace under it, and a
 *  bystander in another project. The lead's digest is fresh (working); the
 *  executor's went quiet long past the trust window, which the ladder answers
 *  with `unknown` — the case the panel must never dress up as idle. */
const digest = (over: Record<string, unknown>) => ({
  session_id: "s",
  agent: "claude",
  instance: "inst-1",
  state: "working",
  state_via: "turn-start",
  ...over,
});

function seed() {
  seams.severCalls = [];
  seams.severed = [];
  seams.digests = [
    digest({
      session_id: "s-lead",
      surface: "7",
      cwd: "/w/canopy",
      branch: "feat/panel",
      updated: now,
      first_prompt: "coordinate the panel build",
      prompts: ["coordinate the panel build", "check on the executor"],
      working_on: "stitching live status into the table",
    }),
    digest({
      session_id: "s-exec",
      surface: "8",
      cwd: "/w/canopy/.claude/worktrees/agent-x",
      updated: now - 3600,
      first_prompt: "build the settings page",
      prompts: ["build the settings page"],
    }),
    digest({
      session_id: "s-exec-2",
      surface: "10",
      cwd: "/w/canopy/.claude/worktrees/agent-y",
      updated: now,
      first_prompt: "test the settings page",
      prompts: ["test the settings page"],
    }),
  ];
  seams.messages = [
    {
      id: "m1",
      from_pty_id: 7,
      to_pty_id: 8,
      text: "brief: build the settings page",
      delivered:
        "[canopy: message from Coral Hawk, the agent in /w/canopy (terminal 7)] brief: build the settings page",
      instance: "inst-1",
      at_ms: 1000,
      submitted: true,
    },
    {
      id: "m4",
      from_pty_id: 7,
      to_pty_id: 10,
      text: "brief: test the settings page",
      delivered:
        "[canopy: message from Coral Hawk, the agent in /w/canopy (terminal 7)] brief: test the settings page",
      instance: "inst-1",
      at_ms: 1500,
      submitted: true,
    },
    {
      id: "m2",
      from_pty_id: 8,
      to_pty_id: 7,
      reply_to: "m1",
      text: "done",
      instance: "inst-1",
      at_ms: 2000,
      submitted: true,
    },
    // Traffic to a terminal that is no longer live draws nothing.
    {
      id: "m3",
      from_pty_id: 7,
      to_pty_id: 44,
      text: "gone",
      instance: "inst-1",
      at_ms: 3000,
      submitted: true,
    },
  ];
}

const allProjects = [
  { name: "canopy", roots: ["/w/canopy"] },
  { name: "other", roots: ["/w/other"] },
];

function renderPanel(mode: "graph" | "table", onJumpToPty?: (ptyId: number) => void) {
  seams.stats = [
    session({ id: 7, name: "Coral Hawk" }),
    session({ id: 8, cwd: "/w/canopy/.claude/worktrees/agent-x" }),
    session({ id: 10, cwd: "/w/canopy/.claude/worktrees/agent-y" }),
    session({
      id: 9,
      cwd: "/w/other",
      title: "codex",
      agent_hint: { bin: "codex", pkg: null, path: null, interactive: true },
    }),
  ];
  return render(
    <AgentControlPanel
      active
      mode={mode}
      allProjects={allProjects}
      onJumpToPty={onJumpToPty}
    />,
  );
}

describe("the control panel graph", () => {
  it("draws one project frame around agents from all of its component roots", async () => {
    seams.messages = [];
    seams.severed = [];
    seams.digests = [
      digest({ session_id: "website", surface: "21", cwd: "/w/coraa/website" }),
      digest({ session_id: "agent", surface: "22", cwd: "/w/coraa/coraa-agent" }),
    ];
    seams.stats = [
      session({ id: 21, cwd: "/w/coraa/website" }),
      session({ id: 22, cwd: "/w/coraa/coraa-agent" }),
    ];
    const { container } = render(
      <AgentControlPanel
        active
        mode="graph"
        allProjects={[{
          name: "CORAA",
          roots: ["/w/coraa/website", "/w/coraa/coraa-agent"],
        }]}
      />,
    );

    await waitFor(() => expect(container.querySelectorAll(".acp-node")).toHaveLength(2));
    expect(container.querySelectorAll(".acp-group")).toHaveLength(1);
    expect(container.querySelector(".acp-group-name")?.textContent).toBe("CORAA");
  });

  it("keeps a Canopy sibling worktree inside its owning project frame", async () => {
    seams.messages = [];
    seams.severed = [];
    seams.digests = [];
    seams.stats = [
      session({ id: 31, cwd: "/w/canopy" }),
      session({ id: 32, cwd: "/w/canopy-wt-agent-codex-20260818/src" }),
    ];
    const { container } = render(
      <AgentControlPanel active mode="graph" allProjects={allProjects} />,
    );

    await waitFor(() => expect(container.querySelectorAll(".acp-node")).toHaveLength(2));
    expect(container.querySelectorAll(".acp-group")).toHaveLength(1);
    expect(container.querySelector(".acp-group-name")?.textContent).toBe("canopy");
  });

  it("draws edges only where messages were recorded, oriented by who briefs", async () => {
    seed();
    const { container } = renderPanel("graph");
    await waitFor(() => {
      expect(container.querySelectorAll(".acp-edge")).toHaveLength(2);
    });
    // The two recorded spawn edges are 7↔8 and 7↔10; the bystander (9) and the
    // dead terminal (44) get nothing.
    const edge = container.querySelector(".acp-edge title");
    expect(edge?.textContent).toContain("between #7 and #8");
    expect(edge?.textContent).toContain("spawn lineage from #7");
    expect(container.querySelectorAll(".acp-edge-spawn")).toHaveLength(2);
    // All four live agents are nodes, grouped by checkout: both executor
    // workspaces fold into the canopy group, the bystander stands apart.
    expect(container.querySelectorAll(".acp-node")).toHaveLength(4);
    const groups = [...container.querySelectorAll(".acp-group-name")].map(
      (g) => g.textContent,
    );
    expect(groups).toEqual(["canopy", "other"]);

    // The lead owns the upper band. Siblings share the next band and consume
    // horizontal space instead of becoming the old flat vertical chain.
    const lead = screen.getByRole("button", { name: /Coral Hawk/ });
    const child8 = screen.getByRole("button", { name: /claude #8/i });
    const child10 = screen.getByRole("button", { name: /claude #10/i });
    expect(lead.style.top).toBe("96px");
    expect(child8.style.top).toBe(child10.style.top);
    expect(child8.style.top).not.toBe(lead.style.top);
    expect(child8.style.left).not.toBe(child10.style.left);
  });

  it("renders lifecycle states verbatim — a silent session is unknown, never idle", async () => {
    seed();
    renderPanel("graph");
    // The lead's fresh digest reads working; the executor went quiet an hour
    // ago (and the bystander never reported) and must say so in unknown's own
    // words.
    expect((await screen.findAllByText(LIFE_META.working.label)).length).toBeGreaterThan(0);
    const unknown = await screen.findAllByText(LIFE_META.unknown.label);
    expect(unknown.length).toBeGreaterThan(0);
    expect(screen.queryByText(LIFE_META.idle.label)).toBeNull();
  });

  it("keeps node inspection safe and makes sever a confirmed dedicated control", async () => {
    seed();
    const user = userEvent.setup();
    const jump = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = renderPanel("graph", jump);
    await waitFor(() => {
      expect(container.querySelectorAll(".acp-edge")).toHaveLength(2);
    });
    expect(container.querySelector(".acp-edge-severed")).toBeNull();

    // Clicking a node selects/inspects it and focuses its terminal. It never
    // shares the destructive sever affordance.
    const lead = screen.getByRole("button", { name: /Coral Hawk/ });
    await user.click(lead);
    expect(jump).toHaveBeenCalledWith(7);
    expect(lead.getAttribute("aria-pressed")).toBe("true");
    expect(seams.severCalls).toEqual([]);

    // The wire itself is inert. The small x asks before using meshSever.
    expect(container.querySelector<SVGGElement>(".acp-edge")!.style.pointerEvents).toBe(
      "none",
    );
    expect(seams.severCalls).toEqual([]);
    const severButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Sever connection between terminals #7 and #8"]',
    )!;
    await user.click(severButton);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(seams.severCalls).toEqual([]);
    confirm.mockReturnValue(true);
    await user.click(severButton);
    expect(seams.severCalls).toEqual([{ a: 7, b: 8, severed: true }]);

    // Reconnect keeps the established single-door path and is non-destructive.
    seams.severed = [{ a: 7, b: 8, instance: "inst-1", at_ms: 1 }];
    const second = renderPanel("graph");
    await waitFor(() => {
      expect(second.container.querySelector(".acp-edge-severed")).not.toBeNull();
    });
    await user.click(
      second.container.querySelector(
        'button[aria-label="Reconnect connection between terminals #7 and #8"]',
      )!,
    );
    expect(seams.severCalls).toEqual([
      { a: 7, b: 8, severed: true },
      { a: 7, b: 8, severed: false },
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });
});

describe("the control panel table", () => {
  it("is the same dataset flat: identity leading, initial prompt and current work", async () => {
    seed();
    renderPanel("table");
    const lead = await screen.findByText("Coral Hawk");
    expect(lead).toBeTruthy();
    // Identity detail: branch riding next to the name.
    expect(screen.getByText(/⎇ feat\/panel/)).toBeTruthy();
    // The initial prompt stays retained while the explicit status owns "now".
    expect(screen.getByText("coordinate the panel build")).toBeTruthy();
    expect(screen.getByText("stitching live status into the table")).toBeTruthy();
    expect(screen.queryByText("check on the executor")).toBeNull();
    // And the status column stays honest here too.
    expect(screen.getAllByText(LIFE_META.unknown.label).length).toBeGreaterThan(0);
    expect(screen.queryByText(LIFE_META.idle.label)).toBeNull();
  });
});

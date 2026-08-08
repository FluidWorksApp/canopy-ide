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
    }),
    digest({
      session_id: "s-exec",
      surface: "8",
      cwd: "/w/canopy/.claude/worktrees/agent-x",
      updated: now - 3600,
      first_prompt: "build the settings page",
      prompts: ["build the settings page"],
    }),
  ];
  seams.messages = [
    {
      id: "m1",
      from_pty_id: 7,
      to_pty_id: 8,
      text: "brief: build the settings page",
      instance: "inst-1",
      at_ms: 1000,
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

function renderPanel(mode: "graph" | "table") {
  seams.stats = [
    session({ id: 7 }),
    session({ id: 8, cwd: "/w/canopy/.claude/worktrees/agent-x" }),
    session({
      id: 9,
      cwd: "/w/other",
      title: "codex",
      agent_hint: { bin: "codex", pkg: null, path: null, interactive: true },
    }),
  ];
  return render(<AgentControlPanel active mode={mode} allProjects={allProjects} />);
}

describe("the control panel graph", () => {
  it("draws edges only where messages were recorded, oriented by who briefs", async () => {
    seed();
    const { container } = renderPanel("graph");
    await waitFor(() => {
      expect(container.querySelectorAll(".acp-edge")).toHaveLength(1);
    });
    // The one edge is 7↔8; the bystander (9) and the dead terminal (44) get
    // nothing. Every brief came from 7, so the record shows a lead.
    const edge = container.querySelector(".acp-edge title");
    expect(edge?.textContent).toContain("between #7 and #8");
    expect(edge?.textContent).toContain("briefs flow from #7");
    // All three live agents are nodes, grouped by checkout: the executor's
    // workspace folds into the canopy group, the bystander stands apart.
    expect(container.querySelectorAll(".acp-node")).toHaveLength(3);
    const groups = [...container.querySelectorAll(".acp-group-name")].map(
      (g) => g.textContent,
    );
    expect(groups).toEqual(["canopy", "other"]);
  });

  it("renders lifecycle states verbatim — a silent session is unknown, never idle", async () => {
    seed();
    renderPanel("graph");
    // The lead's fresh digest reads working; the executor went quiet an hour
    // ago (and the bystander never reported) and must say so in unknown's own
    // words.
    await screen.findByText(LIFE_META.working.label);
    const unknown = await screen.findAllByText(LIFE_META.unknown.label);
    expect(unknown.length).toBeGreaterThan(0);
    expect(screen.queryByText(LIFE_META.idle.label)).toBeNull();
  });

  it("severs a pair from its edge, and shows a severed pair as cut", async () => {
    seed();
    const user = userEvent.setup();
    const { container } = renderPanel("graph");
    await waitFor(() => {
      expect(container.querySelectorAll(".acp-edge")).toHaveLength(1);
    });
    expect(container.querySelector(".acp-edge-severed")).toBeNull();
    await user.click(container.querySelector(".acp-edge")!);
    expect(seams.severCalls).toEqual([{ a: 7, b: 8, severed: true }]);

    // With the pair severed, the edge renders cut and the click reconnects.
    seams.severed = [{ a: 7, b: 8, instance: "inst-1", at_ms: 1 }];
    const second = renderPanel("graph");
    await waitFor(() => {
      expect(second.container.querySelector(".acp-edge-severed")).not.toBeNull();
    });
    await user.click(second.container.querySelector(".acp-edge-severed")!);
    expect(seams.severCalls).toEqual([
      { a: 7, b: 8, severed: true },
      { a: 7, b: 8, severed: false },
    ]);
  });
});

describe("the control panel table", () => {
  it("is the same dataset flat: identity leading, initial prompt and current work", async () => {
    seed();
    renderPanel("table");
    const lead = await screen.findByText("claude #7");
    expect(lead).toBeTruthy();
    // Identity detail: branch riding next to the name.
    expect(screen.getByText(/⎇ feat\/panel/)).toBeTruthy();
    // The initial prompt is the retained one, the "now" column the latest.
    expect(screen.getByText("coordinate the panel build")).toBeTruthy();
    expect(screen.getByText("check on the executor")).toBeTruthy();
    // And the status column stays honest here too.
    expect(screen.getAllByText(LIFE_META.unknown.label).length).toBeGreaterThan(0);
    expect(screen.queryByText(LIFE_META.idle.label)).toBeNull();
  });
});

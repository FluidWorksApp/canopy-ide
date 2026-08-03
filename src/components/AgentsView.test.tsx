// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsView } from "./AgentsView";
import type * as ipcTypes from "../ipc";

const digests: ipcTypes.SessionDigest[] = [];
const claims: ipcTypes.AgentClaim[] = [];

// Mutable seam so single tests can fail the release without their own mock.
const seams = vi.hoisted(() => ({
  releaseClaim: undefined as ((ownerKey: string) => Promise<void>) | undefined,
}));

vi.mock("../ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve(digests),
  contextClaims: () => Promise.resolve(claims),
  onAgentClaims: () => Promise.resolve(() => {}),
  contextMessages: () => Promise.resolve([]),
  onAgentMessage: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  onIntegrationHealth: () => Promise.resolve(() => {}),
  agentIntegrationHealth: () => Promise.resolve([]),
  agentUsage: () => Promise.resolve([]),
  contextReleaseClaim: (ownerKey: string) =>
    seams.releaseClaim?.(ownerKey) ?? Promise.resolve(),
  ptyKill: () => Promise.resolve(),
  sessionForget: () => Promise.resolve(),
  setupAgentHooks: () => Promise.resolve({ summary: "" }),
}));

const claimOf = (over: Partial<ipcTypes.AgentClaim> = {}): ipcTypes.AgentClaim => ({
  id: "c1",
  paths: ["/repo/src/auth.ts"],
  owner: "canopy (/repo)",
  owner_key: "pty:7@inst-1",
  pty_id: 7,
  instance: "inst-1",
  note: "Rewriting the login redirect",
  at_ms: Date.now() - 60_000,
  released_at_ms: null,
  released_by: null,
  refusals: [],
  ...over,
});

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
    claims.push(claimOf());
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

describe("the attention axis on the page", () => {
  const BLOCKED = { kind: "blocked", since: 1, why: "permission" } as const;

  it("counts an attention-blocked agent under 'waiting on you' and sorts it first", () => {
    const { container } = page({
      stats: [session({ id: 7 }), session({ id: 8 })],
      tabNames: new Map([
        [7, { title: "quiet one" }],
        [8, { title: "blocked one" }],
      ]),
      attentionFor: (ptyId) => (ptyId === 8 ? BLOCKED : { kind: "none" }),
    });
    // The stat row: "waiting on you" reads 1, where NO_ATTENTION read 0.
    const stats = [...container.querySelectorAll(".agv-stat")];
    const waiting = stats.find((s) => s.textContent?.includes("waiting on you"));
    expect(within(waiting as HTMLElement).getByText("1")).toBeTruthy();
    // The blocked card leads the grid and carries the attention look.
    const cards = [...container.querySelectorAll(".agv-card")];
    expect(cards[0]?.textContent).toContain("blocked one");
    expect(cards[0]?.classList.contains("agv-card-attention")).toBe(true);
    expect(cards[1]?.classList.contains("agv-card-attention")).toBe(false);
  });
});

describe("claim rows on the page", () => {
  it("counts the agents a contested claim turned away", async () => {
    claims.length = 0;
    claims.push(
      claimOf({
        refusals: [
          { owner: "a (/x)", paths: ["/repo/src/auth.ts"], note: null, at_ms: 1 },
        ],
      }),
    );
    page({ active: true });
    expect(await screen.findByText("⛔ 1 turned away")).toBeTruthy();
    claims.length = 0;
  });

  it("releases by owner_key and surfaces a failure instead of swallowing it", async () => {
    claims.length = 0;
    claims.push(claimOf());
    const release = vi.fn(() => Promise.reject(new Error("not the holder")));
    seams.releaseClaim = release;
    const onNotice = vi.fn();
    page({ active: true, onNotice });
    await userEvent.click(await screen.findByText("Release"));
    expect(release).toHaveBeenCalledWith("pty:7@inst-1");
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("not the holder")),
    );
    seams.releaseClaim = undefined;
    claims.length = 0;
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsPanel } from "./AgentsPanel";
import type * as ipcTypes from "../ipc";

// Six agents in a project are six rows that used to all say "claude". These
// cover the one thing that tells them apart: the name of the tab each is
// running in — the CLI's own title for it, or the user's rename over that.

// Mutable seams so single tests can vary what the backend answers without
// their own module mock.
const seams = vi.hoisted(() => ({
  digests: [] as unknown[],
  claims: [] as unknown[],
  messages: [] as unknown[],
  releaseClaim: undefined as ((ownerKey: string) => Promise<void>) | undefined,
}));

vi.mock("../ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve(seams.digests),
  contextClaims: () => Promise.resolve(seams.claims),
  onAgentClaims: () => Promise.resolve(() => {}),
  contextMessages: () => Promise.resolve(seams.messages),
  onAgentMessage: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  onIntegrationHealth: () => Promise.resolve(() => {}),
  agentIntegrationHealth: () => Promise.resolve([]),
  agentHooksInstalled: () => Promise.resolve(true),
  instructionsScan: () => Promise.resolve([]),
  contextReleaseClaim: (ownerKey: string) =>
    seams.releaseClaim?.(ownerKey) ?? Promise.resolve(),
  ptyKill: () => Promise.resolve(),
  sessionForget: () => Promise.resolve(),
  setupAgentHooks: () => Promise.resolve({ summary: "" }),
}));

beforeEach(() => {
  seams.digests = [];
  seams.claims = [];
  seams.messages = [];
  seams.releaseClaim = undefined;
  localStorage.clear();
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

const digest = (over: Partial<ipcTypes.SessionDigest> = {}): ipcTypes.SessionDigest => ({
  session_id: "s-1",
  cwd: "/repo",
  agent: "claude",
  surface: "7",
  instance: "inst-1",
  updated: Math.floor(Date.now() / 1000) - 5,
  ...over,
});

const claim = (over: Partial<ipcTypes.AgentClaim> = {}): ipcTypes.AgentClaim => ({
  id: "c1",
  paths: ["/repo/src/auth.ts"],
  owner: "canopy (/repo)",
  owner_key: "pty:7@inst-1",
  pty_id: 7,
  instance: "inst-1",
  note: null,
  at_ms: Date.now() - 60_000,
  released_at_ms: null,
  released_by: null,
  refusals: [],
  ...over,
});

const BLOCKED = { kind: "blocked", since: 1, why: "permission" } as const;

describe("the shared-context dialog", () => {
  it("speaks the ladder's vocabulary, not the legacy idle boolean", async () => {
    // Two digests the old `d.idle ? "idle" : "active"` got wrong at once: a
    // session mid-turn (idle absent read as "active" — correct only by luck,
    // and rendered without any of the ladder's caution) and a legacy record
    // whose stale idle:true called a long-silent session "idle". The ladder
    // says "working" for the first and refuses a verdict on the second.
    seams.digests = [
      digest({ state: "working", state_via: "tool-activity" }),
      digest({
        session_id: "s-2",
        surface: "8",
        idle: true,
        updated: Math.floor(Date.now() / 1000) - 600,
      }),
    ];
    panel({ visible: true, shareContext: true });
    await userEvent.click(await screen.findByText("2 shared"));
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("no signal — may have stopped")).toBeTruthy();
    expect(screen.queryByText("active")).toBeNull();
  });
});

describe("the attention axis on the panel", () => {
  it("shows the needs-you chip for an agent the attention channel says is blocked", async () => {
    panel({
      visible: true,
      attentionFor: (ptyId) => (ptyId === 7 ? BLOCKED : { kind: "none" }),
    });
    expect(
      await screen.findByTitle("This agent is waiting for your answer"),
    ).toBeTruthy();
  });

  it("does not offer to hibernate a proven-idle agent that is blocked on you", async () => {
    // reclaimable's third clause — the guard the constant NO_ATTENTION had
    // disarmed. Proven idle via the digest, blocked via the attention channel:
    // the button must not appear.
    seams.digests = [digest({ state: "idle", state_via: "turn-boundary" })];
    const hibernateTitle =
      "Hibernate — frees memory now; resume later from Restorable with its history";
    const { unmount } = panel({ visible: true });
    // Sanity: without the block the same digest does offer hibernation.
    expect(await screen.findByTitle(hibernateTitle)).toBeTruthy();
    unmount();
    panel({ visible: true, attentionFor: () => BLOCKED });
    await screen.findByTitle("This agent is waiting for your answer");
    expect(screen.queryByTitle(hibernateTitle)).toBeNull();
  });
});

describe("auto-hibernation's refusal toast", () => {
  it("says it once per roster, not once per stats tick", async () => {
    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({ autoHibernate: true, maxLiveAgents: 1 }),
    );
    const onNotice = vi.fn();
    const stats = [session({ id: 7 }), session({ id: 8 })];
    const { rerender } = panel({ visible: true, stats, onNotice });
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Over the agent cap")),
    );
    // A stats tick: same sessions, fresh array identity — what the 2s poll
    // hands every render. The refusal must not repeat.
    rerender(
      <AgentsPanel
        visible={true}
        stats={[...stats]}
        hookPath="/hook"
        roots={["/repo"]}
        shareContext={false}
        onShareContext={vi.fn()}
        onNotice={onNotice}
      />,
    );
    rerender(
      <AgentsPanel
        visible={true}
        stats={[...stats]}
        hookPath="/hook"
        roots={["/repo"]}
        shareContext={false}
        onShareContext={vi.fn()}
        onNotice={onNotice}
      />,
    );
    expect(
      onNotice.mock.calls.filter(([m]) => String(m).includes("Over the agent cap")),
    ).toHaveLength(1);
  });
});

describe("claim rows", () => {
  it("counts the agents a contested claim turned away", async () => {
    seams.claims = [
      claim({
        refusals: [
          { owner: "a (/x)", paths: ["/repo/src/auth.ts"], note: null, at_ms: 1 },
          { owner: "b (/y)", paths: ["/repo/src/auth.ts"], note: null, at_ms: 2 },
        ],
      }),
    ];
    panel({ visible: true });
    expect(await screen.findByText("⛔ 2")).toBeTruthy();
  });

  it("releases by owner_key and surfaces a failure instead of swallowing it", async () => {
    seams.claims = [claim()];
    const release = vi.fn(() => Promise.reject(new Error("not the holder")));
    seams.releaseClaim = release;
    const onNotice = vi.fn();
    panel({ visible: true, onNotice });
    await userEvent.click(await screen.findByText("Release"));
    expect(release).toHaveBeenCalledWith("pty:7@inst-1");
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("not the holder")),
    );
  });
});

describe("agent messages", () => {
  const msg = (over: Partial<ipcTypes.MeshMessage> = {}): ipcTypes.MeshMessage => ({
    id: "m1",
    from_pty_id: 3,
    from_cwd: "/repo",
    to_pty_id: 7,
    text: "rebase onto main before you push",
    at_ms: 1,
    submitted: true,
    ...over,
  });

  // A message lands in its target's composer looking exactly like the user
  // typed it, so the log is the only place the reach-in is recoverable.
  it("says which terminal reached into which", async () => {
    seams.messages = [msg()];
    panel({ visible: true });
    expect(await screen.findByText("terminal 3 → terminal 7")).toBeTruthy();
    expect(screen.getByText("rebase onto main before you push")).toBeTruthy();
  });

  it("calls out a message that never got its return", async () => {
    seams.messages = [msg({ submitted: false })];
    panel({ visible: true });
    expect(await screen.findByText("unsent")).toBeTruthy();
  });

  // The companion has no terminal, and the row must not invent one for it.
  it("names the companion rather than a terminal id it doesn't have", async () => {
    seams.messages = [msg({ from_pty_id: null, from_cwd: null })];
    panel({ visible: true });
    expect(await screen.findByText("companion → terminal 7")).toBeTruthy();
  });

  // A pty id stops meaning anything across app runs; the CLI's name never
  // does, so when the hook captured one the route leads with it.
  it("names the agents on each end when it knows them", async () => {
    seams.messages = [msg({ from_agent: "claude", to_agent: "codex" })];
    panel({ visible: true });
    expect(await screen.findByText("claude 3 → codex 7")).toBeTruthy();
  });

  // The store keeps hundreds; the panel leads with the recent few and makes
  // the rest a click, not a scroll past everything else the panel is for.
  it("shows only the newest few until View all is asked for", async () => {
    seams.messages = Array.from({ length: 12 }, (_, i) =>
      msg({ id: `m${i + 1}`, text: `message ${i + 1}`, at_ms: i + 1 }),
    );
    panel({ visible: true });
    // Newest first: m12 is visible, the oldest are cut.
    expect(await screen.findByText("message 12")).toBeTruthy();
    expect(screen.queryByText("message 1")).toBeNull();
    expect(screen.getByText("message 5")).toBeTruthy();
    expect(screen.queryByText("message 4")).toBeNull();

    await userEvent.click(screen.getByText("View all 12 messages"));
    expect(screen.getByText("message 1")).toBeTruthy();
    await userEvent.click(screen.getByText("Show recent only"));
    expect(screen.queryByText("message 1")).toBeNull();
  });

  it("offers no View all when everything already fits", async () => {
    seams.messages = [msg()];
    panel({ visible: true });
    await screen.findByText("terminal 3 → terminal 7");
    expect(screen.queryByText(/View all/)).toBeNull();
  });
});

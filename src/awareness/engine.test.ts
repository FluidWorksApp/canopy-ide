import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({}));
vi.mock("../attention", () => ({ postAttention: vi.fn() }));
vi.mock("../brainCall", () => ({ askBrain: vi.fn() }));
const settings = vi.hoisted(() => ({ awarenessEnabled: true, awarenessHotspots: {} as Record<string, string[]> }));
vi.mock("../settings", () => ({ getSettings: () => settings }));

import type * as ipc from "../ipc";
import type { AgentTurnEnd } from "../agentTurns";
import type { BrainAnswer, BrainRequest } from "../brainCall";
import { awarenessStatus, handleTurn, setAwarenessDepsForTests, type AwarenessDeps } from "./engine";
import { publishAwarenessRoster, resetAwarenessRosterForTests } from "./roster";

const NOW = 1_100_000;

const turn: AgentTurnEnd = {
  turnId: "s-ana:1000000",
  ptyId: 1,
  sessionId: "s-ana",
  cli: "cli-a",
  cwd: "/repo",
  root: "/repo",
  prompt: "rename priceFor to quote",
  filesTouched: ["src/pricing.ts", "src/routes.ts"],
  startedAt: 1_000_000,
  endedAt: 1_060_000,
};

const edit = (over: Partial<ipc.AgentEdit>): ipc.AgentEdit => ({
  ts: 1030,
  path: "src/pricing.ts",
  tool: "Edit",
  old: null,
  new: null,
  present: true,
  ...over,
});

const NOTE = "Ana's agent renamed priceFor to quote in pricing.ts. Your cart.ts still calls priceFor.";

function makeDeps(over: Partial<AwarenessDeps> = {}) {
  const calls = {
    ask: vi.fn(async (_req: BrainRequest<unknown>): Promise<BrainAnswer<unknown>> => ({
      ok: true as const,
      text: "",
      value: [{ relevant: true, note: NOTE, risk: "conflict" as const }],
      costUsd: 0.001,
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      model: null,
    })),
    deliver: vi.fn(async (_pty: number, _inst: string, id: string, _text: string) => `m-${id}`),
    claim: vi.fn(async (_pty: number, _paths: string[], _owner: string, _note: string) => "Claimed 1 path(s)."),
    append: vi.fn(async (_root: string, draft: unknown) => draft as never),
    post: vi.fn(() => "att"),
  };
  const deps = {
    enabled: () => settings.awarenessEnabled,
    remote: () => false,
    roots: () => ["/repo"],
    instance: async () => "inst",
    digests: async () =>
      [
        {
          session_id: "s-ben",
          cwd: "/repo/.wt/ben",
          agent: "cli-b",
          state: "working",
          surface: "2",
          instance: "inst",
          files: ["src/cart.ts"],
        },
        // Closed terminals and other launches are not peers.
        { session_id: "s-old", cwd: "/repo", state: "ended", surface: "3", instance: "inst", files: ["src/pricing.ts"] },
        { session_id: "s-other", cwd: "/repo", state: "working", surface: "4", instance: "other", files: ["src/pricing.ts"] },
      ] as ipc.SessionDigest[],
    livePtys: async () => [1, 2, 4],
    edits: async (_cwd: string, sessionId: string) =>
      sessionId === "s-ana"
        ? [
            edit({ old: "export function priceFor(x) {}", new: "export function quote(x) {}" }),
            edit({ path: "src/routes.ts", ts: 1031, old: "a", new: "b" }),
          ]
        : [edit({ path: "src/routes.ts", ts: 1090, old: "c", new: "d" })],
    claims: async () => [],
    claimHistory: async () => [],
    checkouts: async () => ["/repo", "/repo/.wt/ben"],
    churn: async () => [],
    references: async () => [{ symbol: "quote", files: ["/repo/src/cart.ts"] }],
    now: () => NOW,
    ...calls,
    ...over,
  } as unknown as Partial<AwarenessDeps>;
  setAwarenessDepsForTests(deps);
  return calls;
}

beforeEach(() => {
  settings.awarenessEnabled = true;
  settings.awarenessHotspots = {};
  resetAwarenessRosterForTests();
  publishAwarenessRoster("p", [
    { ptyId: 1, name: "Ana's agent", agent: "cli-a", title: "Pricing rename", description: null },
    { ptyId: 2, name: "Ben's agent", agent: "cli-b", title: "Cart discounts", description: "apply coupons" },
  ]);
});

describe("handleTurn", () => {
  it("asks the brain once for the overlapping agent and delivers its note through the mesh", async () => {
    const c = makeDeps();
    await handleTurn(turn);

    expect(c.ask).toHaveBeenCalledTimes(1);
    const req = c.ask.mock.calls[0][0];
    expect(req).toMatchObject({ feature: "awareness", tier: "background", json: true, cwd: "/repo" });
    expect(req.prompt).toContain("rename priceFor to quote");
    expect(req.prompt).toContain("Agent 1: Ben's agent");
    expect(req.prompt).toContain("Task: Cart discounts — apply coupons");
    expect(req.prompt).toContain("src/cart.ts (uses a changed symbol: quote)");
    expect(req.prompt).toContain("+ export function quote(x) {}");

    const toBen = c.deliver.mock.calls.filter(([pty, , id]) => pty === 2 && id.startsWith("aw-") && !id.startsWith("aw-hs"));
    expect(toBen).toHaveLength(1);
    const [, instance, , text] = toBen[0];
    expect(instance).toBe("inst");
    expect(text).toContain("Heads-up from the Canopy workspace: Ana's agent just changed");
    expect(text).toContain(NOTE);
    expect(text).toContain("Check before you continue editing these files.");
    // Files are named in the receiving agent's own checkout.
    expect(text).toContain("/repo/.wt/ben/src/cart.ts");

    const noteEntry = c.append.mock.calls.map(([, d]) => d as { kind: string; data: { kind: string } }).find((d) => d.data.kind === "note");
    expect(noteEntry).toMatchObject({
      kind: "awareness",
      author: { kind: "brain", name: "awareness" },
      ref: { kind: "session", id: "s-ben" },
      data: {
        kind: "note",
        to: { sessionId: "s-ben", ptyId: 2, name: "Ben's agent" },
        from: { sessionId: "s-ana", name: "Ana's agent" },
        note: NOTE,
        risk: "conflict",
        delivered: true,
        symbols: ["quote"],
      },
    });
    expect(c.post).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Told Ben's agent: Ana's agent changed"), body: NOTE, tone: "warn" }),
    );
    expect(awarenessStatus()).toEqual({ state: "on" });
  });

  it("claims a hotspot both agents touched and warns both, without the brain", async () => {
    const c = makeDeps();
    await handleTurn(turn);
    expect(c.claim).toHaveBeenCalledWith(1, ["/repo/src/routes.ts"], "Ana's agent (/repo)", expect.stringContaining("src/routes.ts"));
    const hs = c.deliver.mock.calls.filter(([, , id]) => id.startsWith("aw-hs"));
    expect(hs.map(([pty]) => pty).sort()).toEqual([1, 2]);
    expect(hs.find(([pty]) => pty === 1)![3]).toContain("Canopy claimed it for you");
    expect(hs.find(([pty]) => pty === 2)![3]).toContain("now holds a claim on it");
  });

  it("dedupes: the same change is neither judged nor delivered twice", async () => {
    const c = makeDeps();
    await handleTurn(turn);
    const delivered = c.deliver.mock.calls.length;
    await handleTurn({ ...turn, turnId: "again" });
    expect(c.ask).toHaveBeenCalledTimes(1);
    expect(c.deliver.mock.calls.length).toBe(delivered);
  });

  it("skips agents the brain judges unaffected", async () => {
    const c = makeDeps({
      ask: vi.fn(async () => ({
        ok: true as const, text: "", value: [{ relevant: false, note: "", risk: "none" as const }] as never,
        costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, model: null,
      })),
    });
    await handleTurn(turn);
    expect(c.deliver.mock.calls.filter(([, , id]) => !id.startsWith("aw-hs"))).toHaveLength(0);
  });

  it("degrades quietly without a brain: hotspot warnings still go, the board says why", async () => {
    const c = makeDeps({ ask: vi.fn(async () => ({ ok: false as const, reason: "no-brain" as const, message: "none" })) });
    await handleTurn(turn);
    expect(c.deliver.mock.calls.every(([, , id]) => id.startsWith("aw-hs"))).toBe(true);
    expect(c.deliver).toHaveBeenCalled();
    expect(awarenessStatus()).toMatchObject({ state: "paused", reason: "no-brain" });
  });

  it("does nothing when switched off", async () => {
    settings.awarenessEnabled = false;
    const c = makeDeps();
    await handleTurn(turn);
    expect(c.ask).not.toHaveBeenCalled();
    expect(c.deliver).not.toHaveBeenCalled();
    expect(c.claim).not.toHaveBeenCalled();
    expect(awarenessStatus()).toEqual({ state: "off" });
  });

  it("respects the per-project hotspot override", async () => {
    settings.awarenessHotspots = { "/repo": ["docs/"] };
    const c = makeDeps();
    await handleTurn(turn);
    expect(c.claim).not.toHaveBeenCalled();
  });
});

describe("cloud workspaces", () => {
  it("runs when the IDE is on a cloud workspace, giving the brain no workspace path", async () => {
    const c = makeDeps({ remote: () => true });
    await handleTurn(turn);
    expect(c.ask).toHaveBeenCalledTimes(1);
    expect(c.ask.mock.calls[0][0].cwd).toBe("");
    expect(c.deliver).toHaveBeenCalled();
    expect(c.claim).toHaveBeenCalled();
    expect(awarenessStatus()).toEqual({ state: "on" });
  });

  it("tells an agent in another cloud workspace on the same repository, through its service", async () => {
    const deliverCloud = vi.fn(async () => "msg-1");
    const c = makeDeps({
      digests: async () => [],
      origin: async () => "git@github.com:Acme/Shop.git",
      currentWorkspace: () => "ws-here",
      cloud: async () => [
        {
          id: "ws-cara",
          name: "cara-cloud",
          online: true,
          agents: [
            { ptyId: 7, name: "Cara's agent", agent: "cli-c", task: "Checkout flow", repo: "https://github.com/acme/shop", root: "/workspace/shop", files: [{ path: "src/cart.ts", ts: NOW - 60_000 }] },
            { ptyId: 8, name: "Other repo", agent: "cli-c", task: null, repo: "https://github.com/acme/other", root: "/workspace/other", files: [{ path: "src/cart.ts", ts: NOW }] },
          ],
        },
        // The workspace this IDE runs against: its agents are already local.
        { id: "ws-here", name: "here", online: true, agents: [{ ptyId: 9, name: "dup", agent: null, task: null, repo: "https://github.com/acme/shop", root: "/workspace/shop", files: [{ path: "src/cart.ts", ts: NOW }] }] },
      ],
      deliverCloud,
    } as Partial<AwarenessDeps>);
    await handleTurn(turn);
    expect(c.ask).toHaveBeenCalledTimes(1);
    expect(c.ask.mock.calls[0][0].prompt).toContain("Cara's agent in cara-cloud");
    expect(deliverCloud).toHaveBeenCalledTimes(1);
    const [workspace, pty, text] = deliverCloud.mock.calls[0] as unknown as [string, number, string];
    expect([workspace, pty]).toEqual(["ws-cara", 7]);
    expect(text).toContain("/workspace/shop/src/cart.ts");
    expect(c.deliver.mock.calls.filter(([pty]) => pty === 7)).toHaveLength(0);
    const entry = c.append.mock.calls.map(([, d]) => d as { data: { to: { workspace?: string } } }).find((d) => d.data.to.workspace);
    expect(entry?.data.to).toMatchObject({ ptyId: 7, workspace: "ws-cara" });
  });
});

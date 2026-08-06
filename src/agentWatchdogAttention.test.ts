import { beforeEach, describe, expect, it } from "vitest";
import { resetActiveView, setActiveTab } from "./activeView";
import { attentionItems, postAttention } from "./attention";
import { AGENT_WATCHDOG_LIMITS } from "./agentWatchdog";
import {
  clearAgentWatchdogAttention,
  resetAgentWatchdogAttentionForTest,
  tickAgentWatchdogAttention,
  type AgentWatchdogTarget,
} from "./agentWatchdogAttention";
import type { AgentLifeView } from "./agentLifeStore";

const T0 = 1_700_000_000_000;
const TARGET: AgentWatchdogTarget = {
  tabId: "term-7",
  label: "Fix checkout",
  path: "/repo",
};

const view = (over: Partial<AgentLifeView> = {}): AgentLifeView => ({
  ptyId: 7,
  sessionId: "s-1",
  life: {
    state: "working",
    confidence: "proven",
    via: "turn-start",
    since: T0 / 1000,
    note: "working",
    agent: "claude",
  },
  attention: { kind: "none" },
  ...over,
});

const tick = (agent: AgentLifeView, at: number) =>
  tickAgentWatchdogAttention({
    views: [agent],
    targets: new Map([[agent.ptyId, TARGET]]),
    projectId: "p1",
    projectName: "Storefront",
    at,
  });

const postBlocked = () =>
  postAttention({
    kind: "question",
    tone: "info",
    title: "Allow the deploy command?",
    body: "claude",
    source: "agent",
    projectId: "p1",
    projectName: "Storefront",
    where: { kind: "terminal", ptyId: 7, path: "/repo" },
    dedupeKey: "agent:s-1",
    ts: T0,
  });

beforeEach(() => {
  localStorage.clear();
  resetActiveView();
  resetAgentWatchdogAttentionForTest();
});

describe("agent watchdog attention", () => {
  it("posts one W1 question for repeated ticks in the same quiet episode", () => {
    const quiet = view({
      life: {
        state: "unknown",
        confidence: "inferred",
        via: "none",
        reason: "went-quiet",
        since: T0 / 1000,
        note: "went quiet",
        agent: "claude",
      },
    });

    tick(quiet, T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs);
    const [first] = attentionItems();
    tick(quiet, T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs + 60_000);

    expect(attentionItems()).toHaveLength(1);
    expect(attentionItems()[0].id).toBe(first.id);
    expect(first).toMatchObject({
      kind: "question",
      tone: "warn",
      title: "Fix checkout went quiet 5 min ago — look?",
      dedupeKey: `W1:7:${T0}`,
      where: { kind: "terminal", ptyId: 7, path: "/repo" },
    });

    tick(view(), T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs + 120_000);
    expect(attentionItems()[0]).toMatchObject({
      id: first.id,
      resolvedAt: expect.any(Number),
      resolution: "withdrawn",
    });
  });

  it("bumps the existing blocked item instead of posting a W2 duplicate", () => {
    const id = postBlocked();
    const blocked = view({
      attention: { kind: "blocked", since: T0, why: "permission" },
    });

    tick(blocked, T0 + AGENT_WATCHDOG_LIMITS.blockedUnseenMs);
    tick(blocked, T0 + AGENT_WATCHDOG_LIMITS.blockedUnseenMs + 60_000);

    expect(attentionItems()).toHaveLength(1);
    expect(attentionItems()[0]).toMatchObject({
      id,
      title: "Allow the deploy command?",
      body: "claude",
      tone: "error",
      dedupeKey: "agent:s-1",
      ts: T0,
    });
  });

  it("withdraws quiet questions when their project sampling edge unmounts", () => {
    const quiet = view({
      life: {
        state: "unknown",
        confidence: "inferred",
        via: "none",
        reason: "went-quiet",
        since: T0 / 1000,
        note: "went quiet",
        agent: "claude",
      },
    });

    tick(quiet, T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs);
    clearAgentWatchdogAttention("p1");

    expect(attentionItems()[0]).toMatchObject({
      resolution: "withdrawn",
      resolvedAt: expect.any(Number),
    });
  });

  it("withdraws W1 questions left in local storage by an earlier app run", () => {
    postAttention({
      kind: "question",
      tone: "warn",
      title: "Old agent went quiet 5 min ago — look?",
      source: "agent",
      dedupeKey: `W1:99:${T0}`,
      ts: T0,
    });

    tick(view(), T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs);

    expect(attentionItems()[0]).toMatchObject({
      resolution: "withdrawn",
      resolvedAt: expect.any(Number),
    });
  });

  it("waits for the existing blocked item before recording W2", () => {
    const blocked = view({
      attention: { kind: "blocked", since: T0, why: "permission" },
    });
    const at = T0 + AGENT_WATCHDOG_LIMITS.blockedUnseenMs;

    tick(blocked, at);
    expect(attentionItems()).toEqual([]);

    const id = postBlocked();
    tick(blocked, at + 5_000);
    expect(attentionItems()).toHaveLength(1);
    expect(attentionItems()[0]).toMatchObject({ id, tone: "error" });
  });

  it("takes seen from the active terminal before escalating W2", () => {
    const blocked = view({
      attention: { kind: "blocked", since: T0, why: "question" },
    });
    const at = T0 + AGENT_WATCHDOG_LIMITS.blockedUnseenMs;
    postBlocked();

    setActiveTab("p1", "term-7", "terminal");
    tick(blocked, at);
    expect(attentionItems()[0].tone).toBe("info");

    resetActiveView();
    tick(blocked, at);
    expect(attentionItems()).toHaveLength(1);
    expect(attentionItems()[0].tone).toBe("error");
  });
});

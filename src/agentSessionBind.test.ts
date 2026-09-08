// The bug these lock down: an agent that had finished — Stop fired, digest on
// disk reading `idle / turn-boundary / proven` — sat in the WORKING bucket
// indefinitely.
//
// Nothing was wrong with the ladder or the manifest. The tab strip resolved
// pty→session from the hook-event ring alone, that ring is capped app-wide at
// 200 entries across every CLI in every open project, and a session that
// finished an hour ago had long since been evicted. No session id meant no
// digest lookup, a null digest meant the ladder fell past every hook rung to
// "the process tree is burning CPU" — which is a whole-subtree sum, clears its
// 2% floor on a claude sitting idle beside a tsserver, and re-stamps its own
// timestamp on every stats tick. There is no decay on that rung, so it is a
// permanent trap: `declaredQuiet` stays false, the tab never enters
// `provenQuiet`, and settleGroups is never even asked to schedule a fall.
//
// `resolveSessions` already existed for exactly this, with a header describing
// the two-answers problem, and was called from nowhere.
import { describe, expect, it } from "vitest";
import { resolveSessions } from "../shared/agentLife/bind";
import { bucketFor, declaredQuiet, LIFE_META, NO_ATTENTION } from "../shared/agentLife";
import { lifeFor } from "./agentLifeStore";
import { trimAgentEvents } from "../shared/notifications";
import type { AgentEventEntry } from "../shared/notifications";

const digest = (over: Record<string, unknown> = {}) =>
  ({
    session_id: "sess-42",
    surface: "10",
    instance: "run-1",
    updated: 1000,
    ...over,
  }) as never;

describe("resolveSessions", () => {
  it("still binds a terminal whose events have aged out of the ring", () => {
    const bound = resolveSessions({
      digests: [digest()],
      events: [], // evicted
      instance: "run-1",
      livePtys: new Set([10]),
    });
    expect(bound.sessionByPty.get(10)).toBe("sess-42");
    expect(bound.digestBySession.get("sess-42")).toBeTruthy();
  });

  it("prefers the event stamp, which cannot name a recycled pty", () => {
    const bound = resolveSessions({
      digests: [digest({ session_id: "stale", surface: "10" })],
      events: [{ ts: 5, data: { pty: 10, sessionId: "live" } }],
      instance: "run-1",
      livePtys: new Set([10]),
    });
    expect(bound.sessionByPty.get(10)).toBe("live");
  });

  it("takes the launch command's bond before anything has spoken", () => {
    // codex emits no hook event on resume until its next prompt, so without
    // the seed a restored tab is unbound and its resume banner's paint burst
    // reads as "working".
    const bound = resolveSessions({
      digests: [],
      events: [],
      instance: "run-1",
      livePtys: new Set([10]),
      seeds: new Map([[10, "sess-resumed"]]),
    });
    expect(bound.sessionByPty.get(10)).toBe("sess-resumed");
  });

  it("lets a later event correct the seed when the CLI swaps ids", () => {
    const bound = resolveSessions({
      digests: [],
      events: [{ ts: 9, data: { pty: 10, sessionId: "sess-new" } }],
      instance: "run-1",
      livePtys: new Set([10]),
      seeds: new Map([[10, "sess-resumed"]]),
    });
    expect(bound.sessionByPty.get(10)).toBe("sess-new");
  });

  it("never staples another app launch's session onto this pty", () => {
    // A pty id is only unique within one launch, and the sessions dir is
    // shared across restarts.
    const bound = resolveSessions({
      digests: [digest({ instance: "run-0" })],
      events: [],
      instance: "run-1",
      livePtys: new Set([10]),
    });
    expect(bound.sessionByPty.has(10)).toBe(false);
  });
});

describe("the whole chain, as the strip runs it", () => {
  /** A finished claude beside a tsserver: subtree CPU above the 2% floor, and
   *  a digest that says the turn ended over an hour ago. */
  const now = 100_000;
  const finished = {
    session_id: "sess-42",
    surface: "10",
    instance: "run-1",
    // Seconds, the same units the ladder is handed as `now`.
    updated: now - 3600,
    agent: "claude",
    state: "idle",
    state_via: "turn-boundary",
    state_confidence: "proven",
  };
  const busySubtree = {
    id: 10,
    total_cpu: 3.1,
    agent_hint: "claude",
  } as never;

  it("reads WORKING off the CPU rung when the binding is lost", () => {
    // What the strip did: no event stamp, so no session id, so no digest.
    const life = lifeFor({ digest: null, stats: busySubtree, now });
    expect(life.state).toBe("working");
    expect(life.via).toBe("cpu");
    // And it is a trap, not a slow fall: `since` is re-stamped to now on every
    // tick, so nothing ages out of it.
    expect(life.since).toBe(now);
    expect(declaredQuiet(life)).toBe(false);
  });

  it("reads idle once the surface fallback recovers the digest", () => {
    const bound = resolveSessions({
      digests: [finished as never],
      events: [],
      instance: "run-1",
      livePtys: new Set([10]),
    });
    const sid = bound.sessionByPty.get(10);
    const life = lifeFor({
      digest: sid ? (bound.digestBySession.get(sid) as never) : null,
      stats: busySubtree,
      now,
    });
    expect(life.state).toBe("idle");
    expect(life.via).toBe("turn-boundary");
    // Which is what lets the tab fall out of WORKING at all.
    expect(declaredQuiet(life)).toBe(true);
    expect(bucketFor(life, NO_ATTENTION)).not.toBe("active");
  });
});

describe("a verdict is only as good as the evidence it is given", () => {
  // The agent detail header derived its own verdict from a digest frozen at
  // mount, with no process evidence at all. Past hookTrustSecs (300s) the
  // digest stops being believed -- correctly, it is what stops a `working`
  // from a session that died on Tuesday standing forever -- and with nothing
  // to corroborate it the ladder falls to `unknown`. So a session busy for
  // more than five minutes read "no signal -- may have stopped" while the tab
  // strip, looking at the same session's CPU, had it under WORKING.
  const now = 100_000;
  const busyFor20Min = {
    session_id: "sess-42",
    agent: "claude",
    state: "working",
    state_via: "tool-activity",
    updated: now - 1200,
  } as never;

  it("reads 'may have stopped' from a stale digest alone", () => {
    const life = lifeFor({ digest: busyFor20Min, now });
    expect(life.state).toBe("unknown");
    expect(LIFE_META[life.state].label).toBe("no signal — may have stopped");
  });

  it("reads working from the same digest once the pty is in evidence", () => {
    // Not by trusting the digest longer -- by reaching the rungs that need a
    // live process, which the detail view had no way to reach.
    const life = lifeFor({
      digest: busyFor20Min,
      stats: { id: 10, total_cpu: 12.0, agent_hint: "claude" } as never,
      now,
    });
    expect(life.state).toBe("working");
    expect(bucketFor(life, NO_ATTENTION)).toBe("active");
  });
});

describe("trimAgentEvents", () => {
  const ev = (pty: number, sessionId: string, ts: number): AgentEventEntry =>
    ({ ts, data: { pty, sessionId } }) as AgentEventEntry;

  it("keeps a quiet terminal's only stamp when a busy one floods the ring", () => {
    const quiet = ev(10, "sess-quiet", 0);
    const flood = Array.from({ length: 50 }, (_, i) => ev(20, "sess-busy", i + 1));
    const kept = trimAgentEvents([quiet, ...flood], 10);
    expect(kept).toContain(quiet);
    // A plain slice(-10) would have dropped it, which is the bug.
    expect([quiet, ...flood].slice(-10)).not.toContain(quiet);
  });

  it("keeps only the newest stamp per pty, so the retained set stays bounded", () => {
    const old = ev(10, "sess-a", 0);
    const newer = ev(10, "sess-a", 1);
    const flood = Array.from({ length: 30 }, (_, i) => ev(20, "sess-b", i + 2));
    const kept = trimAgentEvents([old, newer, ...flood], 5);
    expect(kept).toContain(newer);
    expect(kept).not.toContain(old);
  });

  it("preserves arrival order and leaves a short ring alone", () => {
    const entries = [ev(1, "a", 1), ev(2, "b", 2), ev(3, "c", 3)];
    expect(trimAgentEvents(entries, 10)).toBe(entries);
    expect(trimAgentEvents(entries, 2).map((e) => e.ts)).toEqual([1, 2, 3]);
  });
});

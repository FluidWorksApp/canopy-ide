// The transition table the producer never had. `state_for` in canopy_hook.rs
// decided the lifecycle of every agent in the app and had no unit test at all —
// three grep hits: the definition, one comment, one call site.
import { describe, expect, it } from "vitest";
import { agentLife, type LifeEvidence, type PtyEvidence } from "./ladder";
import { ALL_FIDELITY, fidelityFor, reachableStates } from "./fidelity";
import { POLICY } from "./policy";
import { reclaimable } from "./compose";
import { NO_ATTENTION } from "./vocabulary";

const NOW = 1_800_000_000;
const ago = (s: number) => NOW - s;

const live = (over: Partial<Extract<PtyEvidence, { kind: "live" }>> = {}): PtyEvidence => ({
  kind: "live",
  hint: { bin: "claude", interactive: true },
  cpu: 0,
  quietForMs: 60_000,
  ...over,
});

const ev = (over: Partial<LifeEvidence>): LifeEvidence => ({ now: NOW, ...over });

describe("rung 0 — the process is gone", () => {
  it("beats a waiting digest that outlived its session", () => {
    const life = agentLife(
      ev({ digest: { state: "waiting", state_via: "structured-block", agent: "claude", updated: ago(60) }, pty: { kind: "gone" } }),
    );
    expect(life.state, "symptom B: a dead agent must not sit in Needs you").toBe("ended");
    expect(life.via).toBe("process-gone");
    expect(life.confidence).toBe("proven");
  });

  it("reads an absent agent_hint as ended, not as an absence of news", () => {
    const life = agentLife(
      ev({ digest: { state: "working", state_via: "tool-activity", agent: "claude", updated: ago(5) }, pty: live({ hint: null, cpu: 90 }) }),
    );
    expect(life.state).toBe("ended");
    expect(life.via).toBe("process-gone");
  });
});

describe("rungs 1-4 — what the CLI proved", () => {
  it("takes SessionEnd as ended", () => {
    const life = agentLife(ev({ digest: { state: "ended", state_via: "session-end", agent: "claude", updated: ago(10) } }));
    expect(life).toMatchObject({ state: "ended", via: "session-end", confidence: "proven" });
  });

  it("takes a structured block as proven waiting", () => {
    const life = agentLife(ev({ digest: { state: "waiting", state_via: "structured-block", agent: "claude", updated: ago(10) } }));
    expect(life).toMatchObject({ state: "waiting", confidence: "proven" });
  });

  it("takes an attention-only CLI's block as waiting, but only reported", () => {
    const life = agentLife(ev({ digest: { state: "waiting", state_via: "declared-block", agent: "aider", updated: ago(10) } }));
    expect(life.state).toBe("waiting");
    expect(life.confidence, "aider cannot say whether it finished or is asking").toBe("reported");
    expect(life.note).toMatch(/cannot say whether it finished/);
  });

  it("takes a turn boundary as idle", () => {
    const life = agentLife(ev({ digest: { state: "idle", state_via: "turn-boundary", agent: "claude", updated: ago(10) } }));
    expect(life).toMatchObject({ state: "idle", confidence: "proven" });
  });

  it("downgrades a CLI whose hooks are written but inert", () => {
    expect(fidelityFor("codex").needsTrust).toBe(true);
    const life = agentLife(ev({ digest: { state: "idle", state_via: "turn-boundary", agent: "codex", updated: ago(10) } }));
    expect(life.confidence).toBe("reported");
    expect(reclaimable(life, NO_ATTENTION), "an unproven idle is not a licence to SIGTERM").toBe(false);
  });
});

describe("rungs 5-6 — a turn in flight decays, it does not persist", () => {
  it("believes a fresh working claim", () => {
    const life = agentLife(ev({ digest: { state: "working", state_via: "tool-activity", agent: "claude", updated: ago(5) } }));
    expect(life).toMatchObject({ state: "working", via: "tool-activity" });
  });

  // Carried over verbatim from agentState.test.ts: codex hit its usage limit,
  // printed the error, returned to its prompt and fired no Stop.
  it("stops believing a working session that went quiet in every sense", () => {
    const life = agentLife(
      ev({ digest: { state: "working", state_via: "tool-activity", agent: "codex", updated: ago(840) }, pty: live({ cpu: 0, quietForMs: 600_000 }) }),
    );
    expect(life.state).toBe("unknown");
    expect(life.reason).toBe("went-quiet");
    expect(life.state, "unknown is not finished — nothing may reclaim it").not.toBe("idle");
  });

  // Also carried over: an hour into a cargo build is still working.
  it("keeps believing a long tool call that is burning CPU", () => {
    const life = agentLife(
      ev({ digest: { state: "working", state_via: "tool-activity", agent: "claude", updated: ago(3600) }, pty: live({ cpu: 90, quietForMs: 600_000 }) }),
    );
    expect(life.state).toBe("working");
    expect(life.via).toBe("cpu");
  });

  it("keeps believing a pause shorter than the trust window", () => {
    const life = agentLife(
      ev({ digest: { state: "working", state_via: "turn-start", agent: "claude", updated: ago(POLICY.hookTrustSecs - 1) }, pty: live({ cpu: 0, quietForMs: 600_000 }) }),
    );
    expect(life.state, "a pause while the model responds is not a stopped session").toBe("working");
  });

  it("does not resurrect a claim from a clock that ran backwards", () => {
    const life = agentLife(ev({ digest: { state: "working", state_via: "tool-activity", agent: "claude", updated: NOW + 600 } }));
    expect(life.state).toBe("working");
  });
});

describe("rung 7 — the terminal is painting", () => {
  it("gives a CLI with no working-capable hooks an honest working", () => {
    expect(reachableStates("aider")).not.toContain("working");
    const life = agentLife(ev({ digest: { state: "waiting", state_via: "declared-block", agent: "aider", updated: ago(9999) }, pty: live({ quietForMs: 200 }) }));
    // The stale declared-block is the higher rung and still wins; but with no
    // digest at all, output alone answers.
    const bare = agentLife(ev({ digest: { agent: "aider" }, pty: live({ quietForMs: 200 }) }));
    expect(bare.state).toBe("working");
    expect(bare.via).toBe("output");
    expect(life.state).toBe("waiting");
  });

  it("does not read the CLI's echo of a keystroke as work", () => {
    const life = agentLife(ev({ digest: { agent: "amp" }, pty: live({ quietForMs: 900, sinceInputMs: 200 }) }));
    expect(life.state, "output that trails the keystroke is the echo").not.toBe("working");
  });

  it("does read output that outlives the echo window as work", () => {
    const life = agentLife(ev({ digest: { agent: "amp" }, pty: live({ quietForMs: 100, sinceInputMs: 4_000 }) }));
    expect(life.state).toBe("working");
  });

  it("treats a build with no output channel as no corroboration", () => {
    const life = agentLife(ev({ digest: { agent: "amp" }, pty: live({ quietForMs: undefined, cpu: 0 }) }));
    expect(life.state).toBe("unknown");
  });
});

describe("the manifest gates the rungs", () => {
  it("never fabricates waiting for a CLI that cannot report it", () => {
    for (const f of ALL_FIDELITY) {
      if (f.notification !== "none" && f.notification !== "unmapped") continue;
      if (f.structuredBlock.length) continue;
      for (const state of ["waiting", "idle", "working", "ended"]) {
        for (const via of ["declared-block", "structured-block", undefined]) {
          const life = agentLife(
            ev({ digest: { state, state_via: via, agent: f.id, updated: ago(1) }, pty: live() }),
          );
          expect(life.state, `${f.id} cannot prove waiting via ${via}`).not.toBe("waiting");
        }
      }
    }
  });

  it("names amp and agy as the CLIs that gate", () => {
    expect(fidelityFor("amp").notification).toBe("none");
    expect(fidelityFor("agy").notification).toBe("unmapped");
    expect(reachableStates("amp")).not.toContain("waiting");
  });

  it("reports cli-cannot-report rather than inventing a state", () => {
    const life = agentLife(ev({ digest: { state: "waiting", state_via: "declared-block", agent: "agy", updated: ago(1) }, pty: live({ cpu: 0, quietForMs: 600_000 }) }));
    expect(life.state).toBe("unknown");
    expect(life.reason).toBe("cli-cannot-report");
  });

  it("gives every CLI ended through the process rung even when it cannot say so", () => {
    for (const f of ALL_FIDELITY) {
      const life = agentLife(ev({ digest: { state: "working", state_via: "tool-activity", agent: f.id, updated: ago(1) }, pty: { kind: "gone" } }));
      expect(life.state, `${f.id} reaches ended through the process`).toBe("ended");
    }
  });
});

describe("silence is asymmetric", () => {
  it("never decays a block — silence is what being blocked looks like", () => {
    const life = agentLife(
      ev({ digest: { state: "waiting", state_via: "structured-block", agent: "claude", updated: ago(864_000) }, pty: live({ cpu: 0, quietForMs: 999_999 }) }),
    );
    expect(life.state).toBe("waiting");
  });

  it("only ever contradicts working", () => {
    const quiet = live({ cpu: 0, quietForMs: 999_999 });
    for (const [state, via] of [["idle", "turn-boundary"], ["ended", "session-end"], ["waiting", "structured-block"]] as const) {
      const life = agentLife(ev({ digest: { state, state_via: via, agent: "claude", updated: ago(864_000) }, pty: quiet }));
      expect(life.state, `${state} is ended by an event, so age says nothing about it`).toBe(state);
    }
  });
});

describe("ended is proven only", () => {
  it("cannot be reached by any amount of quiet", () => {
    for (const cpu of [0, 1, 50]) {
      for (const quietForMs of [0, 1_000, 10_000_000]) {
        for (const secs of [0, 300, 86_400]) {
          const life = agentLife(
            ev({ digest: { state: "working", state_via: "tool-activity", agent: "claude", updated: ago(secs) }, pty: live({ cpu, quietForMs }) }),
          );
          expect(life.state).not.toBe("ended");
        }
      }
    }
  });
});

describe("uncertainty is named, never coerced", () => {
  it("says store-only for a row read from a CLI's own history", () => {
    const life = agentLife(ev({ digest: { agent: "claude", store: true, updated: ago(10) } }));
    expect(life.state).toBe("unknown");
    expect(life.reason, "the portal used to write `d.state || 'idle'` here").toBe("store-only");
  });

  it("says foreign-instance for another launch's digest", () => {
    const life = agentLife(ev({ digest: { state: "working", state_via: "turn-start", agent: "claude", foreign: true, updated: ago(1) } }));
    expect(life.state).toBe("unknown");
    expect(life.reason).toBe("foreign-instance");
  });

  it("says never-reported when nothing has spoken at all", () => {
    const life = agentLife(ev({ pty: live({ cpu: 0, quietForMs: 999_999 }) }));
    expect(life.state).toBe("unknown");
    expect(life.reason).toBe("never-reported");
  });

  it("is never reclaimable, at any confidence, for any CLI", () => {
    for (const f of ALL_FIDELITY) {
      const life = agentLife(ev({ digest: { agent: f.id, store: true } }));
      expect(reclaimable(life, NO_ATTENTION), `${f.id} unknown is not finished`).toBe(false);
    }
  });
});

describe("startup", () => {
  it("says starting rather than unknown while a process boots", () => {
    const life = agentLife(ev({ pty: live({ cpu: 0, quietForMs: 999_999, firstSeen: ago(3) }) }));
    expect(life.state).toBe("starting");
  });

  it("stops saying it once the grace is spent", () => {
    const life = agentLife(ev({ pty: live({ cpu: 0, quietForMs: 999_999, firstSeen: ago(POLICY.startupGraceSecs + 1) }) }));
    expect(life.state).toBe("unknown");
  });
});

describe("aider's full trace", () => {
  it("is waiting, reported, and never reclaimable", () => {
    const life = agentLife(ev({ digest: { state: "waiting", state_via: "declared-block", agent: "aider", updated: ago(30) } }));
    expect(life).toMatchObject({ state: "waiting", confidence: "reported" });
    expect(reclaimable(life, NO_ATTENTION), "hibernation used to SIGTERM this session mid-turn").toBe(false);
  });

  it("can never be proven idle, whatever the digest says", () => {
    const life = agentLife(ev({ digest: { state: "idle", state_via: "turn-boundary", agent: "aider", updated: ago(30) }, pty: live({ cpu: 0, quietForMs: 999_999 }) }));
    expect(life.state, "aider declares no endsTurn event, so the rung is dead for it").not.toBe("idle");
  });
});

describe("legacy digests", () => {
  it("reads a pre-upgrade waiting as declared, never structured", () => {
    const life = agentLife(ev({ digest: { state: "waiting", agent: "claude", updated: ago(10) } }));
    expect(life.via, "the old producer decided from message text; we cannot tell which kind after the fact").toBe("declared-block");
  });

  it("still decays a pre-upgrade working", () => {
    const life = agentLife(ev({ digest: { state: "working", agent: "claude", updated: ago(9999) }, pty: live({ cpu: 0, quietForMs: 999_999 }) }));
    expect(life.state).toBe("unknown");
  });
});

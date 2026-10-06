import { describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import {
  checkoutKey,
  deriveEdges,
  initialPrompt,
  isSevered,
  lineageLayers,
  nodeLabel,
  severedOnlyEdges,
} from "./meshLinks";

const msg = (over: Partial<ipc.MeshMessage>): ipc.MeshMessage => ({
  id: "m1",
  from_pty_id: 1,
  from_cwd: "/repo",
  to_pty_id: 2,
  text: "take src/auth.ts",
  instance: "inst-1",
  at_ms: 1000,
  submitted: true,
  ...over,
});

const live = new Set([1, 2, 3]);

describe("edges derive from the recorded messages and nothing else", () => {
  it("one edge per pair, with the traffic counted and the newest send on top", () => {
    const edges = deriveEdges(
      [
        msg({ id: "m1", from_pty_id: 1, to_pty_id: 2, at_ms: 1000 }),
        msg({ id: "m2", from_pty_id: 2, to_pty_id: 1, at_ms: 2000, reply_to: "m1" }),
        msg({ id: "m3", from_pty_id: 1, to_pty_id: 3, at_ms: 3000 }),
      ],
      "inst-1",
      live,
    );
    expect(edges).toHaveLength(2);
    const pair12 = edges.find((e) => e.a === 1 && e.b === 2);
    expect(pair12?.count).toBe(2);
    expect(pair12?.lastId).toBe("m2");
    expect(pair12?.lastFrom).toBe(2);
    expect(pair12?.relation).toBe("inferred");
    expect(edges.find((e) => e.a === 1 && e.b === 3)?.count).toBe(1);
  });

  it("orients lead→worker only when every brief came from one side", () => {
    // 1 briefs 2; 2 only ever replies: the record shows a lead.
    const led = deriveEdges(
      [
        msg({ id: "m1", from_pty_id: 1, to_pty_id: 2 }),
        msg({ id: "m2", from_pty_id: 2, to_pty_id: 1, reply_to: "m1", at_ms: 2000 }),
        msg({ id: "m3", from_pty_id: 1, to_pty_id: 2, at_ms: 3000 }),
      ],
      "inst-1",
      live,
    );
    expect(led[0].lead).toBe(1);
    expect(led[0].relation).toBe("inferred");

    // Both sides originate briefs: no hierarchy in the data, none rendered.
    const mutual = deriveEdges(
      [
        msg({ id: "m1", from_pty_id: 1, to_pty_id: 2 }),
        msg({ id: "m2", from_pty_id: 2, to_pty_id: 1, at_ms: 2000 }),
      ],
      "inst-1",
      live,
    );
    expect(mutual[0].lead).toBeNull();
    expect(mutual[0].relation).toBe("traffic");
  });

  it("uses a recorded spawn opening as primary lineage, ahead of later traffic", () => {
    const spawned = deriveEdges(
      [
        msg({
          id: "spawn",
          from_pty_id: 1,
          to_pty_id: 2,
          text: "build the settings page",
          delivered: "[canopy: message from Moss, the agent in /repo (terminal 1)] build the settings page",
        }),
        // The child later originates a brief. That makes traffic bidirectional,
        // but it does not rewrite the persisted parent/child fact.
        msg({ id: "later", from_pty_id: 2, to_pty_id: 1, at_ms: 2000 }),
      ],
      "inst-1",
      live,
    );
    expect(spawned[0]).toMatchObject({ lead: 1, relation: "spawn" });

    const meshNotice = deriveEdges(
      [
        msg({
          text: "a long mesh body",
          delivered: "[canopy: message from Moss (terminal 1)] New mesh message m1 — read it with canopy_mesh get m1.",
        }),
      ],
      "inst-1",
      live,
    );
    expect(meshNotice[0].relation).toBe("inferred");
  });

  it("ignores other launches, dead terminals, and companion sends", () => {
    const edges = deriveEdges(
      [
        msg({ id: "m1", instance: "older-launch" }),
        msg({ id: "m2", from_pty_id: 9, to_pty_id: 2 }), // 9 is not live
        msg({ id: "m3", from_pty_id: null }), // the companion has no node
      ],
      "inst-1",
      live,
    );
    expect(edges).toHaveLength(0);
  });

  it("keeps a severed pair on screen after its traffic ages out", () => {
    const severed: ipc.SeveredPair[] = [
      { a: 1, b: 2, instance: "inst-1", at_ms: 1 },
      { a: 1, b: 9, instance: "inst-1", at_ms: 1 }, // dead end: nothing to draw
      { a: 1, b: 3, instance: "other", at_ms: 1 }, // another launch's pair
    ];
    const extra = severedOnlyEdges(severed, "inst-1", live, []);
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ a: 1, b: 2, count: 0 });
    // …but not twice when the observed edge already exists.
    const observed = deriveEdges([msg({})], "inst-1", live);
    expect(severedOnlyEdges(severed, "inst-1", live, observed)).toHaveLength(0);
  });

  it("severed state is per pair, unordered, and per launch", () => {
    const severed: ipc.SeveredPair[] = [{ a: 1, b: 2, instance: "inst-1", at_ms: 1 }];
    expect(isSevered(severed, "inst-1", 2, 1)).toBe(true);
    expect(isSevered(severed, "inst-1", 1, 3)).toBe(false);
    expect(isSevered(severed, "other", 1, 2)).toBe(false);
  });
});

describe("lineage layout", () => {
  it("puts a parent above horizontally-spaced children deterministically", () => {
    const edges = deriveEdges(
      [
        msg({
          id: "child-3",
          from_pty_id: 1,
          to_pty_id: 3,
          text: "third",
          delivered: "[canopy: message from Lead (terminal 1)] third",
        }),
        msg({
          id: "child-2",
          from_pty_id: 1,
          to_pty_id: 2,
          text: "second",
          delivered: "[canopy: message from Lead (terminal 1)] second",
        }),
      ],
      "inst-1",
      live,
    );
    expect(lineageLayers([3, 1, 2], edges)).toEqual([[1], [2, 3]]);
    expect(lineageLayers([2, 3, 1], [...edges].reverse())).toEqual([[1], [2, 3]]);
  });

  it("prefers spawn lineage over inference and leaves malformed cycles finite", () => {
    const edge = (
      a: number,
      b: number,
      lead: number,
      relation: "spawn" | "inferred",
    ) => ({
      a,
      b,
      lead,
      relation,
      count: 1,
      lastId: "m",
      lastAtMs: 1,
      lastFrom: lead,
    });
    expect(
      lineageLayers(
        [1, 2, 3],
        [edge(2, 3, 2, "inferred"), edge(1, 3, 1, "spawn")],
      ),
    ).toEqual([[1, 2], [3]]);
    expect(
      lineageLayers(
        [1, 2],
        [edge(1, 2, 1, "spawn"), edge(1, 2, 2, "spawn")],
      ),
    ).toEqual([[2], [1]]);
  });
});

describe("grouping folds a workspace into the checkout it was made under", () => {
  it("a lead in the main checkout and its executor share one group", () => {
    expect(checkoutKey("/w/canopy")).toBe("/w/canopy");
    expect(checkoutKey("/w/canopy/.claude/worktrees/agent-x")).toBe("/w/canopy");
    expect(checkoutKey("/w/canopy/.claude/worktrees/agent-x/src")).toBe("/w/canopy");
    expect(checkoutKey("/w/canopy-wt-agent-codex-1")).toBe("/w/canopy");
    expect(checkoutKey("/w/canopy-wt-agent-codex-1/src")).toBe("/w/canopy");
    expect(checkoutKey("/w/other")).not.toBe(checkoutKey("/w/canopy"));
  });
});

describe("node identity", () => {
  it("composes the strongest identity the record has", () => {
    const { primary, detail } = nodeLabel({
      agentLabel: "Claude Code",
      ptyId: 7,
      tabTitle: "fix login",
      branch: "feat/login",
    });
    expect(primary).toBe("Claude Code #7");
    expect(detail).toBe("fix login · ⎇ feat/login");
  });

  it("a substrate name, once it exists, replaces the composite whole", () => {
    const { primary } = nodeLabel({
      name: "Ivy",
      agentLabel: "Claude Code",
      ptyId: 7,
    });
    expect(primary).toBe("Ivy");
  });

  it("never invents: an unidentified terminal is a terminal", () => {
    const { primary, detail } = nodeLabel({ ptyId: 3 });
    expect(primary).toBe("terminal #3");
    expect(detail).toBe("");
  });
});

describe("the table's prompts", () => {
  it("prefers the retained first prompt over the rotating window", () => {
    expect(
      initialPrompt({ first_prompt: "build the panel", prompts: ["later ask"] }),
    ).toBe("build the panel");
  });

  it("falls back to the oldest human prompt for pre-upgrade digests", () => {
    expect(
      initialPrompt({ prompts: ["<task-notification>x</task-notification>", "real ask", "later"] }),
    ).toBe("real ask");
    expect(initialPrompt({ prompts: [] })).toBeUndefined();
    expect(initialPrompt(undefined)).toBeUndefined();
  });
});

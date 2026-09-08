import { describe, expect, it } from "vitest";
import {
  loadWorkflowDefinitions,
  STARTER_WORKFLOW_DEFINITION,
  validateWorkflowDefinition,
  workflowAcceptsTrigger,
  type WorkflowDefinition,
} from "./workflowDefinition";
import { AGENT_CLIS } from "./projects";

const context = {
  projectRoot: "/repo",
  componentRoots: new Set(["/repo", "/repo/web"]),
};

const valid = (): WorkflowDefinition => ({
  schemaVersion: 1,
  id: "review",
  version: "1",
  name: "Review a change",
  triggers: [{ kind: "manual" }, { kind: "pr.comment", mentions: ["@canopy"] }],
  constraints: { componentRoots: ["/repo"], branchPatterns: ["feat/*"] },
  start: "review",
  steps: [
    {
      id: "review",
      name: "Review",
      kind: "agent",
      prompt: "Review the patch",
      capabilities: ["workspace-read"],
    },
    {
      id: "gate",
      name: "Check evidence",
      kind: "gate",
      capabilities: [],
      evidence: { stepId: "review", predicate: "attempt.completed" },
    },
  ],
  edges: [
    { from: "review", on: "success", to: "gate" },
    { from: "review", on: "failure", to: "$failed" },
    { from: "gate", on: "pass", to: "$completed" },
    { from: "gate", on: "fail", to: "$failed" },
  ],
});

const errorsFor = (mutate: (definition: WorkflowDefinition) => void) => {
  const definition = valid();
  mutate(definition);
  const result = validateWorkflowDefinition(definition, context);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
};

describe("validateWorkflowDefinition", () => {
  it("accepts a complete evidence-shaped definition", () => {
    expect(validateWorkflowDefinition(valid(), context)).toEqual({
      ok: true,
      definition: valid(),
    });
  });

  it("accepts portable component-root paths in committed definitions", () => {
    const definition = valid();
    definition.constraints.componentRoots = ["."];
    expect(validateWorkflowDefinition(definition, context).ok).toBe(true);
  });

  it("ships a safe starter definition that passes the same validator", () => {
    expect(validateWorkflowDefinition(STARTER_WORKFLOW_DEFINITION, context).ok).toBe(true);
  });

  it("validates reusable agent blocks and step references", () => {
    const definition = valid();
    definition.agents = [{
      id: "reviewer",
      name: "Opus reviewer",
      type: "claude",
      config: { model: "opus", effort: "high" },
      prompt: "Review evidence precisely.",
    }];
    const step = definition.steps[0];
    if (step.kind === "agent") step.agent = "reviewer";
    expect(validateWorkflowDefinition(definition, context).ok).toBe(true);

    expect(errorsFor((candidate) => {
      const agentStep = candidate.steps[0];
      if (agentStep.kind === "agent") agentStep.agent = "missing";
    })).toContain("workflow.steps[0].agent does not name a reusable agent block");
    expect(errorsFor((candidate) => {
      candidate.agents = [{ id: "wrong", name: "Wrong", type: "agy", config: { effort: "ultra" } }];
    })).toContain("workflow.agents[0].config.effort is not a supported value");
    expect(errorsFor((candidate) => {
      candidate.agents = [{ id: "wrong", name: "Wrong", type: "claude", config: { region: "us" } }];
    })).toContain("workflow.agents[0].config.region is not declared by claude");
  });

  it("validates new configuration fields from an agent-type manifest", () => {
    AGENT_CLIS.push({
      id: "future-agent",
      name: "Future Agent",
      bin: "future-agent",
      icon: "F",
      execution: {
        fields: [{
          key: "region",
          label: "Region",
          control: "select",
          choices: [{ value: "apac", label: "Asia Pacific" }],
        }],
        launchArgs: () => [],
      },
    });
    try {
      const definition = valid();
      definition.agents = [{
        id: "regional",
        name: "Regional agent",
        type: "future-agent",
        config: { region: "apac" },
      }];
      expect(validateWorkflowDefinition(definition, context).ok).toBe(true);
    } finally {
      AGENT_CLIS.splice(AGENT_CLIS.findIndex((agent) => agent.id === "future-agent"), 1);
    }
  });

  it("rejects schema and capability violations", () => {
    expect(errorsFor((definition) => { definition.schemaVersion = 2 as 1; })).toContain(
      "unsupported workflow schemaVersion",
    );
    expect(errorsFor((definition) => { definition.steps[0].capabilities = []; })).toContain(
      "workflow.steps[0] must declare workspace-read",
    );
    expect(errorsFor((definition) => {
      definition.triggers.push({ kind: "issue.opened", mentions: ["@canopy"] });
    })).toContain("workflow.triggers[2].mentions is only valid for comment events");
  });

  it("reports malformed variant bodies instead of throwing", () => {
    const definition = valid() as unknown as Record<string, unknown>;
    definition.steps = [
      { id: "ask", name: "Ask", kind: "human", capabilities: [] },
      {
        id: "gate",
        name: "Gate",
        kind: "gate",
        capabilities: [],
        evidence: { stepId: "ask" },
      },
    ];
    definition.start = "ask";
    definition.edges = [
      { from: "ask", on: "approve", to: "gate" },
      { from: "gate", on: "pass", to: "$completed" },
      { from: "gate", on: "fail", to: "$failed" },
    ];
    expect(() => validateWorkflowDefinition(definition, context)).not.toThrow();
    const result = validateWorkflowDefinition(definition, context);
    expect(result.ok ? [] : result.errors).toEqual(
      expect.arrayContaining([
        "workflow.steps[0].card is required",
        "workflow.steps[1].evidence.predicate is invalid",
      ]),
    );
  });

  it("rejects missing edge targets, evidence sources, and exit cases", () => {
    expect(errorsFor((definition) => { definition.edges[0].to = "missing"; }).join(" ")).toContain(
      "does not land",
    );
    expect(
      errorsFor((definition) => {
        const gate = definition.steps[1];
        if (gate.kind === "gate") gate.evidence.stepId = "missing";
      }).join(" "),
    ).toContain("missing evidence step");
    expect(errorsFor((definition) => { definition.edges.pop(); }).join(" ")).toContain(
      "has no fail exit",
    );
  });

  it("requires cycles to use an explicit capped loop with an exhausted exit", () => {
    expect(
      errorsFor((definition) => {
        definition.edges[2].to = "review";
      }).join(" "),
    ).toContain("cycle without a bounded loop");

    const definition = valid();
    definition.edges[2] = {
      from: "gate",
      on: "pass",
      to: "review",
      loop: { maxRounds: 2, exhaustedTo: "$completed" },
    };
    expect(validateWorkflowDefinition(definition, context).ok).toBe(true);
  });

  it("rejects constraints outside observed component roots", () => {
    expect(
      errorsFor((definition) => {
        definition.constraints.componentRoots = ["/elsewhere"];
        definition.constraints.branchPatterns = ["../main"];
      }).join(" "),
    ).toMatch(/unobserved project root.*unsafe pattern/);
  });
});

describe("workflow definition loading and triggers", () => {
  it("secret-scans and validates the whole catalog before returning any definition", async () => {
    const good = JSON.stringify(valid());
    const credential = ["ghp", "123456789012345678901234567890123456"].join("_");
    const unsafe = JSON.stringify({ ...valid(), id: "unsafe", token: credential });
    const result = await loadWorkflowDefinitions("/repo", context, {
      readDir: async () => [
        { name: "good.json", path: "/repo/.canopy/workflows/good.json", is_dir: false },
        { name: "unsafe.json", path: "/repo/.canopy/workflows/unsafe.json", is_dir: false },
      ],
      readText: async (path) => (path.endsWith("good.json") ? good : unsafe),
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContain(
      "unsafe.json: definition contains a credential value",
    );
  });

  it("wires manual and filtered PR-comment provenance", () => {
    const definition = valid();
    expect(
      workflowAcceptsTrigger(definition, {
        kind: "manual",
        eventId: "manual-1",
        occurredAt: 1,
        payload: {},
      }),
    ).toBe(true);
    expect(
      workflowAcceptsTrigger(definition, {
        kind: "pr.comment",
        eventId: "comment-1",
        occurredAt: 2,
        payload: { repo: "repo", body: "please @canopy review" },
      }),
    ).toBe(true);
    expect(
      workflowAcceptsTrigger(definition, {
        kind: "pr.comment",
        eventId: "comment-2",
        occurredAt: 3,
        payload: { repo: "repo", body: "plain comment" },
      }),
    ).toBe(false);
  });

  it("matches issue lifecycle and filtered issue-comment provenance", () => {
    const definition = valid();
    definition.triggers.push(
      { kind: "issue.opened", repo: "/repo" },
      { kind: "issue.comment", repo: "/repo", mentions: ["@canopy"] },
    );
    expect(workflowAcceptsTrigger(definition, {
      kind: "issue.opened",
      eventId: "issue-opened-1",
      occurredAt: 4,
      payload: { repo: "/repo", issueId: "#42" },
    })).toBe(true);
    expect(workflowAcceptsTrigger(definition, {
      kind: "issue.opened",
      eventId: "issue-opened-2",
      occurredAt: 5,
      payload: { repo: "/other", issueId: "#42" },
    })).toBe(false);
    expect(workflowAcceptsTrigger(definition, {
      kind: "issue.comment",
      eventId: "issue-comment-1",
      occurredAt: 6,
      payload: { repo: "/repo", issueId: "#42", body: "please @canopy investigate" },
    })).toBe(true);
    expect(workflowAcceptsTrigger(definition, {
      kind: "issue.comment",
      eventId: "issue-comment-2",
      occurredAt: 7,
      payload: { repo: "/repo", issueId: "#42", body: "plain comment" },
    })).toBe(false);
  });

  it("accepts issue events in watch steps", () => {
    const definition = valid();
    definition.steps = [{
      id: "wait",
      name: "Wait for an issue comment",
      kind: "watch",
      event: "issue.comment",
      capabilities: [],
    }];
    definition.start = "wait";
    definition.edges = [
      { from: "wait", on: "pass", to: "$completed" },
      { from: "wait", on: "fail", to: "$failed" },
    ];
    expect(validateWorkflowDefinition(definition, context).ok).toBe(true);
  });

  it("distinguishes an absent workflow directory from a failed read", async () => {
    const missing = await loadWorkflowDefinitions("/repo", context, {
      readDir: async () => { throw new Error("No such file"); },
      readText: async () => "",
    });
    expect(missing).toEqual({ ok: true, definitions: [] });
    const denied = await loadWorkflowDefinitions("/repo", context, {
      readDir: async () => { throw new Error("permission denied"); },
      readText: async () => "",
    });
    expect(denied).toMatchObject({ ok: false });
  });
});

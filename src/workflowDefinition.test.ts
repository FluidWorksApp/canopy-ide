import { describe, expect, it } from "vitest";
import {
  loadWorkflowDefinitions,
  validateWorkflowDefinition,
  workflowAcceptsTrigger,
  type WorkflowDefinition,
} from "./workflowDefinition";

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

  it("rejects schema and capability violations", () => {
    expect(errorsFor((definition) => { definition.schemaVersion = 2 as 1; })).toContain(
      "unsupported workflow schemaVersion",
    );
    expect(errorsFor((definition) => { definition.steps[0].capabilities = []; })).toContain(
      "workflow.steps[0] must declare workspace-read",
    );
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

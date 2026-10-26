import { describe, expect, it } from "vitest";
import {
  ABSENT,
  parseVerdict,
  renderWorkflowPrompt,
  TRIGGER_VALUE_MAX,
  verdictPath,
  verdictProtocol,
  workflowRunDir,
} from "./workflowPrompt";

const scope = {
  runId: "run-7",
  runDir: "/repo/.canopy/workflow-runs/run-7",
  round: 2,
  trigger: { request: "Add tiered donations", specPath: "docs/designs/tiers.md", number: 42 },
};

describe("workflow run paths", () => {
  it("keeps run artifacts inside the worktree, whatever the trailing slash", () => {
    expect(workflowRunDir("/repo/", "run-7")).toBe("/repo/.canopy/workflow-runs/run-7");
    expect(workflowRunDir("/repo", "run-7")).toBe("/repo/.canopy/workflow-runs/run-7");
  });

  it("gives every round of a step its own verdict file", () => {
    const dir = workflowRunDir("/repo", "run-7");
    expect(verdictPath(dir, "critic", 1)).not.toBe(verdictPath(dir, "critic", 2));
    expect(verdictPath(dir, "critic", 1)).toBe(`${dir}/verdicts/critic.r1.json`);
  });
});

describe("renderWorkflowPrompt", () => {
  it("fills the run, round and trigger placeholders", () => {
    expect(
      renderWorkflowPrompt(
        "Spec {{trigger.request}} at {{trigger.specPath}} in {{ run.dir }} ({{run.id}}, round {{round}}, #{{trigger.number}})",
        scope,
      ),
    ).toBe(
      "Spec Add tiered donations at docs/designs/tiers.md in /repo/.canopy/workflow-runs/run-7 (run-7, round 2, #42)",
    );
  });

  it("says a missing trigger value is missing instead of leaving a hole", () => {
    expect(renderWorkflowPrompt("Research: {{trigger.researchId}}", scope)).toBe(
      `Research: ${ABSENT}`,
    );
    expect(renderWorkflowPrompt("{{trigger.toString}}", scope)).toBe(ABSENT);
  });

  it("leaves braces it does not own alone", () => {
    expect(renderWorkflowPrompt("Use {{handlebars}} and {{trigger.}}", scope)).toBe(
      "Use {{handlebars}} and {{trigger.}}",
    );
  });

  it("caps an oversized payload value so it cannot crowd out the brief", () => {
    const rendered = renderWorkflowPrompt("{{trigger.body}}", {
      ...scope,
      trigger: { body: "x".repeat(TRIGGER_VALUE_MAX * 2) },
    });
    expect(Array.from(rendered)).toHaveLength(TRIGGER_VALUE_MAX);
    expect(rendered.endsWith("…")).toBe(true);
  });
});

describe("verdicts", () => {
  it("names the exact file and choices the executor will read", () => {
    const line = verdictProtocol("/run/verdicts/critic.r1.json", ["clean", "findings"]);
    expect(line).toContain("/run/verdicts/critic.r1.json");
    expect(line).toContain('"clean", "findings"');
  });

  it("accepts only a declared verdict", () => {
    expect(parseVerdict('{"verdict":"findings"}', ["clean", "findings"])).toBe("findings");
    expect(parseVerdict('{"verdict":" clean "}', ["clean", "findings"])).toBe("clean");
    expect(parseVerdict('{"verdict":"maybe"}', ["clean", "findings"])).toBeNull();
    expect(parseVerdict("not json", ["clean"])).toBeNull();
    expect(parseVerdict(null, ["clean"])).toBeNull();
  });
});

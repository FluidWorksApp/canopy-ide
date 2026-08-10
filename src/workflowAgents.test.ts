import { describe, expect, it } from "vitest";
import { workflowAgentPrompt, workflowAgentSelection } from "./workflowAgents";

describe("workflow reusable agents", () => {
  it("combines the reusable role with each use's task prompt", () => {
    const block = {
      id: "reviewer", name: "Reviewer", type: "claude",
      config: { model: "opus", effort: "high" }, prompt: "Be a rigorous reviewer.",
    };
    const step = {
      id: "review", name: "Review", kind: "agent" as const,
      agent: "reviewer", prompt: "Review the authentication change.",
      capabilities: ["workspace-read" as const],
    };
    expect(workflowAgentPrompt(block, step)).toBe(
      "Be a rigorous reviewer.\n\nReview the authentication change.",
    );
    expect(workflowAgentSelection(block)).toMatchObject({ model: "opus", effort: "high" });
  });
});

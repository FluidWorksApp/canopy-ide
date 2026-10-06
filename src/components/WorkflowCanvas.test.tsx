// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../ipc";
import { AGENT_CLIS } from "../projects";
import type { WorkflowDefinition } from "../workflowDefinition";
import { WorkflowCanvas } from "./WorkflowCanvas";

vi.mock("../ipc", () => ({ profilesList: vi.fn(), fsReadDir: vi.fn(), fsReadText: vi.fn() }));

const definition = (): WorkflowDefinition => ({
  schemaVersion: 1,
  id: "future-workflow",
  version: "1",
  name: "Future workflow",
  agents: [{ id: "regional", name: "Regional agent", type: "future-agent", config: { region: "apac" } }],
  triggers: [{ kind: "manual" }],
  constraints: { componentRoots: ["."], branchPatterns: ["*"] },
  start: "use-agent",
  steps: [{
    id: "use-agent", name: "Use agent", kind: "agent", agent: "regional",
    capabilities: ["workspace-read"], prompt: "Do the work.",
  }],
  edges: [
    { from: "use-agent", on: "success", to: "$completed" },
    { from: "use-agent", on: "failure", to: "$failed" },
  ],
});

function Harness() {
  const [value, setValue] = useState(definition);
  return <WorkflowCanvas definition={value} projectRoot="/repo" onChange={setValue} />;
}

describe("WorkflowCanvas agent manifests", () => {
  beforeEach(() => {
    vi.mocked(ipc.profilesList).mockResolvedValue([]);
    vi.mocked(ipc.fsReadDir).mockResolvedValue([]);
    AGENT_CLIS.push({
      id: "future-agent",
      name: "Future Agent",
      bin: "future-agent",
      icon: "F",
      execution: {
        fields: [{
          key: "region", label: "Region", control: "select",
          choices: [
            { value: "apac", label: "Asia Pacific" },
            { value: "eu", label: "Europe" },
          ],
        }],
        launchArgs: () => [],
      },
    });
  });

  afterEach(() => {
    const index = AGENT_CLIS.findIndex((agent) => agent.id === "future-agent");
    if (index >= 0) AGENT_CLIS.splice(index, 1);
  });

  it("renders and edits a new agent field without canvas-specific code", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Regional agent/ }));
    const region = screen.getByLabelText("Region") as HTMLSelectElement;
    expect(region.value).toBe("apac");
    fireEvent.change(region, { target: { value: "eu" } });
    expect((screen.getByLabelText("Region") as HTMLSelectElement).value).toBe("eu");
  });
});

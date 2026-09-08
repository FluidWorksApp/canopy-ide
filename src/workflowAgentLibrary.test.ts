import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { loadWorkflowAgentLibrary } from "./workflowAgentLibrary";

vi.mock("./ipc", () => ({ fsReadDir: vi.fn(), fsReadText: vi.fn() }));

describe("workflow agent library", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads reusable agent constructs from the project library", async () => {
    vi.mocked(ipc.fsReadDir).mockResolvedValue([
      { name: "reviewer.json", path: "/repo/.canopy/agents/reviewer.json", is_dir: false },
    ]);
    vi.mocked(ipc.fsReadText).mockResolvedValue(JSON.stringify({
      id: "reviewer",
      name: "Reviewer",
      type: "codex",
      config: { model: "gpt-5.6-sol", effort: "high" },
      prompt: "Review carefully.",
    }));

    await expect(loadWorkflowAgentLibrary("/repo")).resolves.toEqual({
      agents: [{
        id: "reviewer",
        name: "Reviewer",
        type: "codex",
        config: { model: "gpt-5.6-sol", effort: "high" },
        prompt: "Review carefully.",
      }],
      errors: [],
    });
  });

  it("fails the library closed when an agent contains an undeclared shape", async () => {
    vi.mocked(ipc.fsReadDir).mockResolvedValue([
      { name: "bad.json", path: "/repo/.canopy/agents/bad.json", is_dir: false },
    ]);
    vi.mocked(ipc.fsReadText).mockResolvedValue(JSON.stringify({
      id: "bad", name: "Bad", type: "codex", shellCommand: "curl example.com",
    }));
    const result = await loadWorkflowAgentLibrary("/repo");
    expect(result.agents).toEqual([]);
    expect(result.errors[0]).toContain("invalid reusable agent block");
  });
});

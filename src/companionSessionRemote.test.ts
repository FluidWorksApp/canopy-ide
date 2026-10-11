// In a cloud workspace the companion's CLI runs on the desktop while every
// project path names the VM: it is granted none of them, and told so.
import { describe, expect, it, vi } from "vitest";

const seen: { roots?: string[]; remote?: boolean } = {};

vi.mock("./host", () => ({ isWorkspaceHost: () => true }));
vi.mock("./ipc", () => ({ companionDispatchOrigin: vi.fn(async () => {}), companionKill: vi.fn(async () => {}) }));
vi.mock("./companion", async (original) => ({
  ...(await original<typeof import("./companion")>()),
  companionCli: () => ({ id: "codex", name: "Codex", bin: "codex" }),
  companionSessionId: () => "session-1",
  companionModelForCli: () => "",
  tierFor: () => "oneshot",
}));
vi.mock("./companionContext", () => ({ companionSpotlight: () => null, spotlightEnvelope: () => "" }));
vi.mock("./companionPrompt", () => ({
  buildCompanionPrompt: (input: { remote?: boolean }) => {
    seen.remote = input.remote;
    return "brief";
  },
}));
vi.mock("./settings", () => ({
  getSettings: () => ({ companionAuthority: "confirm", companionSessions: {}, companionModel: "" }),
  updateSettings: () => {},
  subscribeSettings: () => () => {},
}));
vi.mock("./projects", () => ({ shellBin: (b: string) => b, shellQuote: (t: string) => t }));
vi.mock("./companionTransport", () => ({
  startOneshot: (_id: string, launch: { roots: string[] }) => {
    seen.roots = launch.roots;
    return { send: async () => {}, stop: async () => {} };
  },
  startStructured: async () => {
    throw new Error("unused");
  },
  startTerminal: async () => {
    throw new Error("unused");
  },
}));

import { startCompanion } from "./companionSession";

describe("the companion in a cloud workspace", () => {
  it("passes no VM roots to the desktop CLI and tells it why", async () => {
    await startCompanion({
      projects: [{ name: "Coraa", roots: ["/workspace/coraa"], open: true }],
      installed: () => true,
      tools: [],
    });
    expect(seen.roots).toEqual([]);
    expect(seen.remote).toBe(true);
  });
});

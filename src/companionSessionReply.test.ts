// An agent's reply to a companion request, as a turn in the companion's own
// session: shown as that agent, never as the owner, and labelled with the
// conversation it belongs to before it is sent.
import { describe, expect, it, vi } from "vitest";
import type { StructuredRunnerEvent } from "./structuredEvents";

const calls: string[] = [];
let emit: ((e: StructuredRunnerEvent) => void) | null = null;

vi.mock("./ipc", () => ({
  companionDispatchOrigin: vi.fn(async (origin: string | null) => {
    calls.push(`origin ${origin}`);
  }),
  companionKill: vi.fn(async () => {}),
}));
vi.mock("./companion", () => ({
  actionPolicy: () => "confirm",
  companionCli: () => ({ id: "codex", name: "Codex", bin: "codex" }),
  companionLaunchRoots: () => [],
  companionModelForCli: () => "",
  companionSessionId: () => "session-1",
  forgetCompanionSession: () => {},
  tierFor: () => "oneshot",
}));
vi.mock("./companionContext", () => ({ companionSpotlight: () => null, spotlightEnvelope: () => "" }));
vi.mock("./companionPrompt", () => ({ buildCompanionPrompt: () => "brief" }));
vi.mock("./settings", () => ({
  getSettings: () => ({ companionAuthority: "confirm", companionSessions: {}, companionModel: "" }),
  updateSettings: () => {},
}));
vi.mock("./projects", () => ({ shellBin: (b: string) => b, shellQuote: (t: string) => t }));
vi.mock("./companionTransport", () => ({
  startOneshot: (_id: string, _launch: unknown, sink: { emit: (e: StructuredRunnerEvent) => void }) => {
    emit = sink.emit;
    return {
      send: async (wire: string) => {
        calls.push(`send ${wire}`);
      },
      stop: async () => {},
    };
  },
  startStructured: async () => {
    throw new Error("unused");
  },
  startTerminal: async () => {
    throw new Error("unused");
  },
}));

import { askCompanion, companionState, sendToCompanion, startCompanion } from "./companionSession";

describe("an agent's reply in the companion's session", () => {
  it("is shown as the agent, labelled with its origin, and answered like any turn", async () => {
    await startCompanion({ projects: [], installed: () => true, tools: [] });
    emit!({ kind: "ready" } as StructuredRunnerEvent);
    expect(companionState().status).toBe("ready");

    const answered = askCompanion("CI is green.", "[canopy: reply from Fern …]\n\nCI is green.", {
      origin: "slack:item-0001",
      from: "Fern · terminal 7",
    });
    await vi.waitFor(() => expect(calls).toContain("send [canopy: reply from Fern …]\n\nCI is green."));
    const shown = companionState().messages.at(-2)!;
    expect(shown.who).toBe("agent");
    expect(shown.from).toBe("Fern · terminal 7");
    expect(shown.text).toBe("CI is green.");
    // Labelled before it was sent, so a request it mints answers to Slack.
    expect(calls.indexOf("origin slack:item-0001")).toBeLessThan(calls.indexOf("send [canopy: reply from Fern …]\n\nCI is green."));

    emit!({ kind: "delta", text: "Fern says CI is green." } as StructuredRunnerEvent);
    emit!({ kind: "turnEnd" } as StructuredRunnerEvent);
    await expect(answered).resolves.toEqual({ text: "Fern says CI is green.", failed: false });

    // The owner's own chat clears the label again.
    calls.length = 0;
    await sendToCompanion("thanks");
    expect(calls[0]).toBe("origin null");
    expect(companionState().messages.at(-2)!.who).toBe("you");
  });
});

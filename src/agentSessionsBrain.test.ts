import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./brainCall", () => ({ askBrain: vi.fn() }));

import { askBrain } from "./brainCall";
import { workingOnNow, type SessionRow } from "./agentSessions";
import { brainSessionTitle, resetBrainSessionTitlesForTests } from "./brainSessionTitle";

const askMock = askBrain as unknown as ReturnType<typeof vi.fn>;
const OPENING = "the login page keeps redirecting back to itself after I sign in, can you find out why";

const row = (digest: Partial<SessionRow["digest"]> = {}): SessionRow =>
  ({
    session: { id: 7 },
    agent: null,
    dir: "app",
    digest: { session_id: "s", first_prompt: OPENING, prompts: [OPENING, "yes do it"], ...digest },
  }) as unknown as SessionRow;

beforeEach(async () => {
  localStorage.clear();
  resetBrainSessionTitlesForTests();
  askMock.mockReset();
});

describe("a session's one-liner", () => {
  it("falls back to the latest message until the brain has summarised it", async () => {
    expect(workingOnNow(row())).toBe("yes do it");
    askMock.mockImplementation(async (req: { validate: (v: unknown) => unknown }) => ({
      ok: true,
      text: "",
      value: req.validate({ title: "Fix login redirect loop", summary: "Find why sign-in loops back to login." }),
    }));
    await brainSessionTitle(OPENING);
    expect(workingOnNow(row())).toBe("Find why sign-in loops back to login.");
  });

  it("never outranks what the agent published itself", async () => {
    askMock.mockImplementation(async (req: { validate: (v: unknown) => unknown }) => ({
      ok: true,
      text: "",
      value: req.validate({ title: "Fix login redirect loop", summary: "Brain summary." }),
    }));
    await brainSessionTitle(OPENING);
    expect(workingOnNow(row({ working_on: "Tracing the auth middleware" }))).toBe("Tracing the auth middleware");
    const agentNamed = new Map([[7, { agentName: "Login bug", description: "Agent's focus" }]]);
    expect(workingOnNow(row(), agentNamed)).toBe("Agent's focus");
    // A prompt-derived description (no agent name yet) yields to the brain.
    const heuristic = new Map([[7, { promptName: "the login page…", description: "yes do it" }]]);
    expect(workingOnNow(row(), heuristic)).toBe("Brain summary.");
  });
});

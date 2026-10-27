import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The three-strikes walk renders a dozen rounds; give a loaded machine room.
vi.setConfig({ testTimeout: 20_000 });

vi.mock("../ledger", async () => (await import("../test/fakeLedger")).fakeLedger);
const ipcMock = vi.hoisted(() => ({
  gitLog: vi.fn(),
  gitRemoteUrl: vi.fn(),
  gitCommitPatch: vi.fn(),
  gitDiff: vi.fn(async () => ""),
  browserRunOp: vi.fn(async () => null),
}));
vi.mock("../ipc", () => ipcMock);
const brain = vi.hoisted(() => ({ askBrain: vi.fn() }));
vi.mock("../brainCall", () => brain);
const turns = vi.hoisted(() => ({ listener: null as null | ((t: unknown) => void) }));
vi.mock("../agentTurns", () => ({
  onAgentTurnEnd: (cb: (t: unknown) => void) => {
    turns.listener = cb;
    return () => {
      turns.listener = null;
    };
  },
}));
const share = vi.hoisted(() => ({
  openShareDialog: vi.fn(),
  buildReportCard: vi.fn(async (agent: string, title: string, body: string) => ({ type: "report", v: 1, agent, title, body })),
}));
vi.mock("../shareCards", () => share);

import { fakeLedger } from "../test/fakeLedger";
import { BuilderLensPanel } from "./BuilderLensPanel";
import { resetLensCheckpointsForTests } from "../lensCheckpoints";
import { resetLensLayersForTests } from "../lensLayers";
import type { BuilderSession } from "../vibeBuilderSessionTypes";

const project = {
  id: "p1",
  name: "Shop",
  components: [{ id: "c1", label: "web", path: "/repo" }],
  vibe: { version: 1 as const, enabled: true, componentId: "c1" },
};

const session = () =>
  ({ send: vi.fn(), state: { persona: {} }, events$: { subscribe: () => () => {} } }) as unknown as BuilderSession & {
    send: ReturnType<typeof vi.fn>;
  };

/** A brain that answers by what is asked: summary, diagnosis or layer map. */
function brainAnswers(answers: { summary?: unknown; diagnosis?: (prompt: string) => unknown; layers?: unknown }) {
  brain.askBrain.mockImplementation(async (req: { prompt: string; validate?: (v: unknown) => unknown }) => {
    const raw = req.prompt.includes("DIAGNOSE ONLY")
      ? answers.diagnosis?.(req.prompt)
      : req.prompt.includes("Group the project into three layers")
        ? answers.layers
        : answers.summary;
    const value = raw && req.validate ? req.validate(raw) : raw;
    return value
      ? { ok: true, text: "", value, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, model: null }
      : { ok: false, reason: "no-brain", message: "No agent is connected" };
  });
}

const DIAG = {
  likelyCause: "The sign-up form sends the password under the wrong name",
  evidence: ["POST /api/signup → 400"],
  suggestedFix: "Send the password under the name the server expects",
  confidence: "high",
  layer: "auth",
};

beforeEach(() => {
  fakeLedger.reset();
  resetLensCheckpointsForTests();
  resetLensLayersForTests();
  vi.clearAllMocks();
  localStorage.clear();
  ipcMock.gitLog.mockResolvedValue([
    { hash: "h2", short: "h2", author: "a", date: "2026-10-27T10:00:00Z", subject: "vibe: add buy button", refs: "" },
    { hash: "h1", short: "h1", author: "a", date: "2026-10-27T09:00:00Z", subject: "initial", refs: "" },
  ]);
  ipcMock.gitRemoteUrl.mockResolvedValue("");
  ipcMock.gitCommitPatch.mockResolvedValue({ patch: "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+x" });
});
afterEach(cleanup);

describe("BuilderLensPanel — checkpoints", () => {
  it("shows the brain's plain-language summary on the checkpoint list and restores by that title", async () => {
    brainAnswers({ summary: { title: "Added a Buy button", whatChanged: "Shoppers can now buy from the product page.", layer: "view", risk: "low" } });
    const s = session();
    render(<BuilderLensPanel project={project} session={s} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    expect(screen.getByText("Go back to when it worked")).toBeTruthy();
    expect(await screen.findByText("Added a Buy button")).toBeTruthy();
    expect(screen.getByText(/Shoppers can now buy/)).toBeTruthy();
    expect(screen.getByText("View")).toBeTruthy();
    expect(brain.askBrain.mock.calls[0][0]).toMatchObject({ feature: "lens", tier: "background", json: true });

    fireEvent.click(screen.getByRole("button", { name: "Go back to here" }));
    expect(s.send).toHaveBeenCalledWith("Go back to “Added a Buy button”.", expect.objectContaining({ context: expect.stringContaining("h2") }));
  });

  it("falls back to what was asked for when summaries are turned off", async () => {
    localStorage.setItem("canopy.settings", JSON.stringify({ lensAutoSummaries: false }));
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    expect(await screen.findByText("add buy button")).toBeTruthy();
    expect(brain.askBrain).not.toHaveBeenCalled();
  });

  it("adds finished agent turns in this project as steps", async () => {
    brainAnswers({ summary: { title: "Made the header blue", whatChanged: "The top bar is blue now.", layer: "view", risk: "low" } });
    render(<BuilderLensPanel project={project} session={session()} />);
    await waitFor(() => expect(turns.listener).toBeTruthy());
    act(() => turns.listener!({ turnId: "t1", cwd: "/repo/src", prompt: "make header blue", filesTouched: ["/repo/src/Header.tsx"], endedAt: Date.parse("2026-10-27T11:00:00Z") }));
    act(() => turns.listener!({ turnId: "t2", cwd: "/elsewhere", prompt: "nope", filesTouched: [], endedAt: 1 }));
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    expect((await screen.findAllByText("Made the header blue")).length).toBeGreaterThan(0);
    expect(screen.queryByText("nope")).toBeNull();
  });

  it("makes layer ownership visible with a one-click approval request", async () => {
    brainAnswers({ summary: null });
    await fakeLedger.appendLedger("/repo", {
      kind: "memory",
      ref: { kind: "lens-layers", id: "project" },
      data: {
        map: {
          areas: { data: { summary: "d", files: [] }, logic: { summary: "l", files: [] }, view: { summary: "v", files: [] } },
          globs: { data: [], auth: ["src/auth/**"], deploy: [], integration: [] },
        },
      },
    });
    await fakeLedger.appendLedger("/repo", { kind: "rule", ref: { kind: "lens-layer", id: "auth" }, data: { type: "layer-owner", layer: "auth", owner: "Sam" } });
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    expect(await screen.findByText("Sign-in & accounts is owned by Sam — your change will be sent for their approval.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await waitFor(() => expect(share.openShareDialog).toHaveBeenCalled());
    expect(share.openShareDialog.mock.calls[0][0]).toMatchObject({ kind: "share", card: { type: "report", title: expect.stringContaining("Sign-in") } });
    expect(share.buildReportCard.mock.calls[0][2]).toContain("src/auth/login.ts");
  });
});

describe("BuilderLensPanel — something's wrong", () => {
  it("diagnoses read-only, shows convergence, and fixes only on request", async () => {
    brainAnswers({ diagnosis: () => DIAG });
    const s = session();
    render(<BuilderLensPanel project={project} session={s} />);
    fireEvent.click(screen.getByRole("tab", { name: "Something’s wrong" }));
    fireEvent.change(screen.getByLabelText("What’s wrong?"), { target: { value: "Sign up does nothing" } });
    fireEvent.click(screen.getByLabelText(/Get a second opinion/));
    fireEvent.click(screen.getByRole("button", { name: "Find the cause" }));

    expect((await screen.findAllByText(DIAG.likelyCause)).length).toBe(2);
    expect(screen.getByText("Both looks agree on the cause.")).toBeTruthy();
    const diagCalls = brain.askBrain.mock.calls.filter((c) => c[0].prompt.includes("DIAGNOSE ONLY"));
    expect(diagCalls).toHaveLength(2);
    expect(diagCalls.every((c) => c[0].tier === "main")).toBe(true);
    expect(s.send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fix it" }));
    await waitFor(() => expect(s.send).toHaveBeenCalled());
    expect(s.send.mock.calls[0][0]).toBe("Please fix this: Sign up does nothing");
    expect(s.send.mock.calls[0][1].context).toContain(DIAG.likelyCause);
    expect(await screen.findByText("Did that fix it?")).toBeTruthy();
    expect(fakeLedger.rows.some((r) => r.kind === "outcome" && r.status === "pending")).toBe(true);
  });

  it("after three failed fixes offers Restart from plan instead of a fourth try", async () => {
    brainAnswers({ diagnosis: () => DIAG });
    await fakeLedger.appendLedger("/repo", { kind: "plan", data: { steps: ["sign-up form", "api"] } });
    const s = session();
    render(<BuilderLensPanel project={project} session={s} />);
    fireEvent.click(screen.getByRole("tab", { name: "Something’s wrong" }));
    fireEvent.change(screen.getByLabelText("What’s wrong?"), { target: { value: "Sign up does nothing" } });

    for (let attempt = 1; attempt <= 3; attempt++) {
      fireEvent.click(screen.getByRole("button", { name: "Find the cause" }));
      fireEvent.click(await screen.findByRole("button", { name: "Fix it" }));
      fireEvent.click(await screen.findByRole("button", { name: "Still broken" }));
      await waitFor(() => expect(screen.queryByText("Did that fix it?")).toBeNull());
    }
    expect(await screen.findByRole("button", { name: "Restart from plan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix it" })).toBeNull();
    expect(s.send).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "Restart from plan" }));
    await waitFor(() => expect(s.send).toHaveBeenCalledTimes(4));
    const [text, opts] = s.send.mock.calls[3];
    expect(text).toContain("add buy button");
    expect(opts.context).toContain("h2");
    expect(opts.context).toContain("sign-up form");
  });

  it("says plainly when there is no brain", async () => {
    brainAnswers({ diagnosis: () => null });
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Something’s wrong" }));
    fireEvent.change(screen.getByLabelText("What’s wrong?"), { target: { value: "broken" } });
    fireEvent.click(screen.getByRole("button", { name: "Find the cause" }));
    expect((await screen.findByRole("alert")).textContent).toContain("No agent is connected");
  });
});

describe("BuilderLensPanel — layers and notices", () => {
  it("shows the brain's Data / Logic / View map with clickable file lists and lets an engineer claim a layer", async () => {
    brainAnswers({
      layers: {
        data: { summary: "Keeps orders and customers.", files: ["prisma/schema.prisma"] },
        logic: { summary: "Handles checkout.", files: ["src/api/checkout.ts"] },
        view: { summary: "The shop pages.", files: ["src/pages/index.tsx"] },
        globs: { data: ["prisma/**"], auth: ["src/auth/**"], deploy: [], integration: [] },
      },
    });
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "How it’s built" }));
    expect(await screen.findByText("Keeps orders and customers.")).toBeTruthy();
    expect(screen.queryByText("prisma/schema.prisma")).toBeNull();
    fireEvent.click(screen.getByText("Keeps orders and customers."));
    expect(screen.getByText("prisma/schema.prisma")).toBeTruthy();
    expect(screen.getByText("src/auth/**")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "I own sign-in & accounts" }));
    expect(await screen.findByText("Owned by Sam")).toBeTruthy();
    expect(fakeLedger.rows.some((r) => r.kind === "rule" && (r.data as { owner?: string }).owner === "Sam")).toBe(true);
  });

  it("recommends team rules on a shared repository, without blocking", async () => {
    brainAnswers({});
    ipcMock.gitRemoteUrl.mockResolvedValue("git@github.com:acme/shop.git");
    render(<BuilderLensPanel project={project} session={session()} />);
    expect(await screen.findByText(/aren’t checked against team rules yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Team rules" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/aren’t checked against team rules yet/)).toBeNull();
  });

  it("links to the rules editor once team rules exist", async () => {
    brainAnswers({});
    ipcMock.gitRemoteUrl.mockResolvedValue("https://github.com/acme/shop");
    await fakeLedger.appendLedger("/repo", { kind: "rule", ref: { kind: "gate", id: "g" }, data: {} });
    const opened = vi.fn();
    window.addEventListener("canopy:open-settings", opened);
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Team rules" }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: "rules" });
    window.removeEventListener("canopy:open-settings", opened);
  });
});

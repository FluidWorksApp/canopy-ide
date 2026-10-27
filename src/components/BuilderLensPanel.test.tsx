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
  gatesPolicyWrite: vi.fn(async () => "/policy.json"),
  receiptRunCheck: vi.fn(),
}));
/** The git a restore runs, answered like a clean checkout one version ahead. */
const gitCalls: string[][] = [];
function fakeGit() {
  ipcMock.receiptRunCheck.mockImplementation(async (_cwd: string, argv: string[]) => {
    gitCalls.push(argv);
    const a = argv.slice(1);
    const stdout =
      a[0] === "rev-parse" && a[1] === "--verify"
        ? `${a[2].replace("^{commit}", "")}\n`
        : a[0] === "rev-parse"
          ? "c0ffee00\n"
          : a[0] === "diff" && a[1] === "--name-status"
            ? "M\tsrc/app.tsx\nA\tsrc/new.tsx\n"
            : a[0] === "diff" && a[1] === "-R"
              ? "diff --git a/src/app.tsx b/src/app.tsx\n-new\n+old\n"
              : a[0] === "diff" && a[1] === "--cached"
                ? "src/app.tsx\nsrc/new.tsx\n"
                : "";
    return { code: 0, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 1, spawnError: null };
  });
}
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
const share = vi.hoisted(() => ({ openShareDialog: vi.fn() }));
vi.mock("../shareCards", async (orig) => ({
  ...(await orig<typeof import("../shareCards")>()),
  openShareDialog: share.openShareDialog,
  repoRefFor: async () => ({ host: "github.com", slug: "acme/shop" }),
}));

import { fakeLedger } from "../test/fakeLedger";
import { BuilderLensPanel } from "./BuilderLensPanel";
import { resetLensCheckpointsForTests } from "../lensCheckpoints";
import { resetLensLayersForTests } from "../lensLayers";
import { recordStep, resetLensStepsForTests } from "../lensSteps";
import { registerRulesEditor, resetGateNoticesForTests } from "../gates/events";
import { setTeamIdentityFetchForTests } from "../teamIdentity";
import { resetLensApprovalsForTests } from "../lensApprovals";
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
  resetLensStepsForTests();
  resetGateNoticesForTests();
  resetLensApprovalsForTests();
  setTeamIdentityFetchForTests(async () => ({ user: { id: "u-alex", name: "Alex", email: "alex@example.test" } }));
  vi.clearAllMocks();
  localStorage.clear();
  gitCalls.length = 0;
  fakeGit();
  ipcMock.gitLog.mockResolvedValue([
    { hash: "a2a2a2a2", short: "a2a2a2a", author: "a", date: "2026-10-27T10:00:00Z", subject: "vibe: add buy button", refs: "" },
    { hash: "a1a1a1a1", short: "a1a1a1a", author: "a", date: "2026-10-27T09:00:00Z", subject: "initial", refs: "" },
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

    // Going back shows what changes, then restores as a new version — no
    // Build session needed, nothing sent to it.
    fireEvent.click(screen.getByRole("button", { name: "Go back to here" }));
    const dialog = await screen.findByRole("dialog", { name: "Go back to Added a Buy button" });
    expect(await screen.findByText("src/new.tsx")).toBeTruthy();
    expect(dialog.textContent).toContain("2 files will change");
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(await screen.findByText(/Back to “Added a Buy button”: 2 files restored/)).toBeTruthy();
    expect(gitCalls).toContainEqual(["git", "read-tree", "-u", "--reset", "a2a2a2a2"]);
    expect(gitCalls).toContainEqual(["git", "commit", "--no-verify", "-q", "-m", "vibe: Back to Added a Buy button"]);
    expect(gitCalls.some((c) => c.includes("reset") && c.includes("--hard"))).toBe(false);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("restores without a Build session", async () => {
    brainAnswers({ summary: null });
    render(<BuilderLensPanel project={project} session={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go back to here" }));
    expect(await screen.findByText("src/new.tsx")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(await screen.findByText(/Back to “add buy button”/)).toBeTruthy();
  });

  it("falls back to what was asked for when summaries are turned off", async () => {
    localStorage.setItem("canopy.settings", JSON.stringify({ lensAutoSummaries: false }));
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    expect(await screen.findByText("add buy button")).toBeTruthy();
    expect(brain.askBrain).not.toHaveBeenCalled();
  });

  it("lists steps that finished while the panel wasn't open, summarised", async () => {
    brain.askBrain.mockImplementation(async (req: { prompt: string; validate?: (v: unknown) => unknown }) => {
      const raw = req.prompt.includes("make header blue")
        ? { title: "Made the header blue", whatChanged: "The top bar is blue now.", layer: "view", risk: "low" }
        : null;
      const value = raw && req.validate ? req.validate(raw) : raw;
      return value ? { ok: true, text: "", value, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, model: null } : { ok: false, reason: "no-brain", message: "x" };
    });
    // Recorded app-wide (lensSteps), before the panel ever mounts.
    const turn = (turnId: string, cwd: string, prompt: string) =>
      ({ turnId, ptyId: 1, sessionId: "s1", cli: "c", cwd, root: "/repo", prompt, filesTouched: ["/repo/src/Header.tsx"], startedAt: 1, endedAt: Date.parse("2026-10-27T11:00:00Z") });
    const deps = {
      summarize: (await import("../lensCheckpoints")).summarizeCheckpoint,
      range: async () => null,
      files: async () => [],
      autoSummaries: () => true,
    };
    await recordStep(turn("s1:1", "/repo/src", "make header blue"), [{ root: "/repo", builder: true }], deps);
    await recordStep(turn("s1:2", "/elsewhere", "nope"), [{ root: "/repo", builder: true }], deps);
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    expect((await screen.findAllByText("Made the header blue")).length).toBe(1);
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
    await fakeLedger.appendLedger("/repo", {
      kind: "rule",
      ref: { kind: "lens-layer", id: "auth" },
      data: { type: "layer-owner", layer: "auth", owner: "Sam", ownerId: "u-sam" },
    });
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    expect(await screen.findByText(/Sign-in & accounts is owned by Sam — changes to it wait for their approval\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await waitFor(() => expect(share.openShareDialog).toHaveBeenCalled());
    // A layer-approval card, addressed to the owner, carrying the files.
    expect(share.openShareDialog.mock.calls[0][0]).toMatchObject({
      kind: "share",
      to: "u-sam",
      card: { type: "layer-approval", layer: "auth", owner: "u-sam", files: ["src/auth/login.ts"], project: "Shop" },
    });
    // Once asked, the banner gives way to where the request stands.
    expect(await screen.findByText("Waiting for Sam to approve the Sign-in & accounts change.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send for approval" })).toBeNull();
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

    // Restart goes back to the last saved version directly (previewed), then
    // asks Build to rebuild from the plan.
    fireEvent.click(screen.getByRole("button", { name: "Restart from plan" }));
    expect(await screen.findByText("src/new.tsx")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back and restart" }));
    await waitFor(() => expect(s.send).toHaveBeenCalledTimes(4));
    expect(gitCalls).toContainEqual(["git", "read-tree", "-u", "--reset", "a2a2a2a2"]);
    const [text, opts] = s.send.mock.calls[3];
    expect(text).toContain("add buy button");
    expect(opts.context).toContain("already back to saved version a2a2a2a2");
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

    // Who claims is the signed-in team member, not a typed name.
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(await screen.findByText(/You’re signed in as Alex/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I own sign-in & accounts" }));
    expect(await screen.findByText("Owned by Alex")).toBeTruthy();
    expect(
      fakeLedger.rows.some((r) => r.kind === "rule" && (r.data as { ownerId?: string }).ownerId === "u-alex"),
    ).toBe(true);
    // Ownership is enforced: the policy now carries the layer's gate, with
    // the owner's own sessions exempt.
    await waitFor(() => expect(ipcMock.gatesPolicyWrite).toHaveBeenCalled());
    const policy = ipcMock.gatesPolicyWrite.mock.calls.at(-1)![1] as { gates: { id: string; exceptMembers?: string[] }[] };
    expect(policy.gates).toContainEqual(expect.objectContaining({ id: "lens-layer:auth", exceptMembers: ["u-alex"] }));
  });

  it("asks a signed-out person to sign in before claiming", async () => {
    setTeamIdentityFetchForTests(async () => {
      throw new Error("unauthorized");
    });
    brainAnswers({});
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "How it’s built" }));
    expect(await screen.findByText(/Sign in to Canopy to own a layer/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "I own sign-in & accounts" }) as HTMLButtonElement).disabled).toBe(true);
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

  it("links to this project's Rules panel when it's there to open", async () => {
    brainAnswers({});
    ipcMock.gitRemoteUrl.mockResolvedValue("https://github.com/acme/shop");
    const off = registerRulesEditor(() => ["/repo"]);
    const opened = vi.fn();
    window.addEventListener("canopy:open-settings", opened);
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Team rules" }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: "rules", cwd: "/repo" });
    window.removeEventListener("canopy:open-settings", opened);
    off();
  });

  it("says nothing once an enforced team rule exists", async () => {
    brainAnswers({});
    ipcMock.gitRemoteUrl.mockResolvedValue("https://github.com/acme/shop");
    await fakeLedger.appendLedger("/repo", {
      kind: "rule",
      data: { type: "rule", text: "No migrations", tag: "enforced", approved: true, gate: { type: "deny-path-write", globs: ["migrations/"] } },
    });
    render(<BuilderLensPanel project={project} session={session()} />);
    fireEvent.click(screen.getByRole("tab", { name: "What changed" }));
    await screen.findByText("add buy button");
    expect(screen.queryByText(/aren’t checked against team rules yet/)).toBeNull();
  });
});

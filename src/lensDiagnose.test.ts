import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ledger", async () => (await import("./test/fakeLedger")).fakeLedger);
const ipcMock = vi.hoisted(() => ({ browserRunOp: vi.fn() }));
vi.mock("./ipc", () => ipcMock);
const preview = vi.hoisted(() => ({ ctx: null as null | { tabId: string; url: string } }));
vi.mock("./vibePreviewContext", () => ({ getVibePreviewContext: () => preview.ctx }));

import { fakeLedger } from "./test/fakeLedger";
import type { askBrain } from "./brainCall";
import {
  FIX_STRIKE_LIMIT,
  canTryAnotherFix,
  diagnose,
  diagnosePrompt,
  diagnosesConverge,
  fixAttempts,
  fixRequest,
  previewEvidence,
  restartFromPlanRequest,
  settleFixAttempt,
  startFixAttempt,
  strikesFrom,
  symptomKey,
  validateDiagnosis,
  type Diagnosis,
} from "./lensDiagnose";

const AUTH_A: Diagnosis = {
  likelyCause: "The sign-up form sends the password field under the wrong name, so the server rejects it",
  evidence: ["POST /api/signup → 400"],
  suggestedFix: "Rename the password field the form sends so the server accepts it",
  confidence: "high",
  layer: "auth",
};
const AUTH_B: Diagnosis = {
  ...AUTH_A,
  likelyCause: "The last change renamed the password field in the sign-up form; the server rejects the request",
  suggestedFix: "Send the password field under the name the server expects",
};
const AUTH_OTHER: Diagnosis = {
  ...AUTH_A,
  likelyCause: "Session cookies expire immediately",
  suggestedFix: "Extend cookie lifetime",
};
const VIEW: Diagnosis = { ...AUTH_A, layer: "view", likelyCause: "The button is hidden behind a banner", suggestedFix: "Move the banner" };

const input = {
  symptom: "Sign up does nothing",
  consoleErrors: ["TypeError: x is undefined"],
  failedRequests: ["POST /api/signup → 400"],
  recentChanges: ["Renamed the sign-up fields"],
  pageUrl: "http://localhost:5173/signup",
};

type Ask = typeof askBrain & ReturnType<typeof vi.fn>;
const answering = (byFraming: (prompt: string) => unknown) =>
  vi.fn(async (req: { prompt: string; validate?: (v: unknown) => unknown }) => {
    const raw = byFraming(req.prompt);
    if (raw instanceof Error) return { ok: false, reason: "failed", message: raw.message };
    const value = req.validate ? req.validate(raw) : raw;
    return value == null
      ? { ok: false, reason: "invalid-output", message: "junk" }
      : { ok: true, text: "", value, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, model: null };
  }) as unknown as Ask;
const isSecond = (prompt: string) => prompt.includes("sceptical");

beforeEach(() => {
  fakeLedger.reset();
  vi.clearAllMocks();
  preview.ctx = null;
});

describe("diagnosis prompt and validation", () => {
  it("is diagnose-only and carries the symptom, browser evidence and recent changes", () => {
    const p = diagnosePrompt(input);
    expect(p).toContain("DIAGNOSE ONLY");
    expect(p).toContain("Sign up does nothing");
    expect(p).toContain("TypeError: x is undefined");
    expect(p).toContain("POST /api/signup → 400");
    expect(p).toContain("Renamed the sign-up fields");
    expect(p).toContain("http://localhost:5173/signup");
  });

  it("frames the second opinion differently", () => {
    expect(diagnosePrompt(input, "symptom-first")).not.toEqual(diagnosePrompt(input, "change-first"));
    expect(isSecond(diagnosePrompt(input, "change-first"))).toBe(true);
    expect(isSecond(diagnosePrompt(input, "symptom-first"))).toBe(false);
  });

  it("says when nothing was captured rather than leaving it out", () => {
    expect(diagnosePrompt({ symptom: "x", consoleErrors: [], failedRequests: [], recentChanges: [] })).toContain("none captured");
  });

  it("validates the answer shape", () => {
    expect(validateDiagnosis({ ...AUTH_A, confidence: "HIGH", layer: "Auth" })).toMatchObject({ confidence: "high", layer: "auth" });
    expect(validateDiagnosis({ ...AUTH_A, layer: "backend" })).toBeNull();
    expect(validateDiagnosis({ ...AUTH_A, confidence: "sure" })).toBeNull();
    expect(validateDiagnosis({ ...AUTH_A, likelyCause: "" })).toBeNull();
    expect(validateDiagnosis({ ...AUTH_A, evidence: "not a list" })?.evidence).toEqual([]);
  });
});

describe("diagnose", () => {
  it("runs one read-only main-tier brain call by default", async () => {
    const ask = answering(() => AUTH_A);
    const r = await diagnose("/repo", input, {}, { ask });
    expect(r).toEqual({ ok: true, primary: AUTH_A });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ feature: "lens", tier: "main", json: true, cwd: "/repo" });
  });

  it("second opinion: two framings in parallel that converge", async () => {
    const ask = answering((p) => (isSecond(p) ? AUTH_B : AUTH_A));
    const r = await diagnose("/repo", input, { secondOpinion: true }, { ask });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, primary: AUTH_A, second: AUTH_B, convergence: "agree" });
  });

  it("second opinion: different layers disagree", async () => {
    const ask = answering((p) => (isSecond(p) ? VIEW : AUTH_A));
    expect(await diagnose("/repo", input, { secondOpinion: true }, { ask })).toMatchObject({ convergence: "disagree" });
  });

  it("second opinion: one look failing still gives the other, with nothing to compare", async () => {
    const ask = answering((p) => (isSecond(p) ? new Error("boom") : AUTH_A));
    expect(await diagnose("/repo", input, { secondOpinion: true }, { ask })).toEqual({ ok: true, primary: AUTH_A, second: null });
    const ask2 = answering((p) => (isSecond(p) ? AUTH_B : new Error("boom")));
    expect(await diagnose("/repo", input, { secondOpinion: true }, { ask: ask2 })).toEqual({ ok: true, primary: AUTH_B, second: null });
  });

  it("reports a failure only when no look succeeded", async () => {
    const ask = answering(() => new Error("signed out"));
    expect(await diagnose("/repo", input, { secondOpinion: true }, { ask })).toEqual({ ok: false, message: "signed out" });
  });
});

describe("convergence", () => {
  it("agrees on same layer with overlapping cause, partly on same layer only, disagrees across layers", () => {
    expect(diagnosesConverge(AUTH_A, AUTH_B)).toBe("agree");
    expect(diagnosesConverge(AUTH_A, AUTH_OTHER)).toBe("partly");
    expect(diagnosesConverge(AUTH_A, VIEW)).toBe("disagree");
    expect(diagnosesConverge(AUTH_A, AUTH_A)).toBe("agree");
  });
});

describe("three strikes", () => {
  it("counts failed and abandoned fixes since the last success", () => {
    expect(strikesFrom([])).toBe(0);
    expect(strikesFrom([{ ts: 1, status: "failed" }, { ts: 2, status: "failed" }])).toBe(2);
    expect(strikesFrom([{ ts: 1, status: "failed" }, { ts: 2, status: "fixed" }, { ts: 3, status: "failed" }])).toBe(1);
    expect(strikesFrom([{ ts: 3, status: "pending" }, { ts: 2, status: "failed" }])).toBe(2);
  });

  it("allows three tries and not a fourth", () => {
    expect(FIX_STRIKE_LIMIT).toBe(3);
    expect(canTryAnotherFix(2)).toBe(true);
    expect(canTryAnotherFix(3)).toBe(false);
  });

  it("treats the same problem worded differently as one symptom", () => {
    expect(symptomKey("Sign up does NOTHING!")).toBe(symptomKey("  sign up does nothing "));
  });

  it("records attempts in the ledger and reaches the cap after three failures", async () => {
    for (let i = 0; i < 3; i++) {
      const a = await startFixAttempt("/repo", { symptom: "Sign up does nothing", diagnosis: AUTH_A });
      expect(a?.status).toBe("pending");
      await settleFixAttempt("/repo", a!, "failed");
    }
    const attempts = await fixAttempts("/repo", "sign up does nothing!");
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.kind === "outcome" && a.status === "failed")).toBe(true);
    expect(canTryAnotherFix(strikesFrom(attempts))).toBe(false);
  });

  it("settles a still-pending attempt as failed when another fix starts", async () => {
    await startFixAttempt("/repo", { symptom: "x broke", diagnosis: AUTH_A });
    await startFixAttempt("/repo", { symptom: "x broke", diagnosis: AUTH_B });
    const attempts = await fixAttempts("/repo", "x broke");
    expect(attempts.map((a) => a.status).sort()).toEqual(["failed", "pending"]);
    expect(strikesFrom(attempts)).toBe(2);
  });

  it("a fix that worked resets the count", async () => {
    const a = await startFixAttempt("/repo", { symptom: "y", diagnosis: AUTH_A });
    await settleFixAttempt("/repo", a!, "fixed");
    expect(strikesFrom(await fixAttempts("/repo", "y"))).toBe(0);
  });
});

describe("handing work to the fixing agent", () => {
  it("attaches the diagnosis as context, apart from the person's words", () => {
    const r = fixRequest("Sign up does nothing", AUTH_A);
    expect(r.text).toBe("Please fix this: Sign up does nothing");
    expect(r.context).toContain(AUTH_A.likelyCause);
    expect(r.context).toContain(AUTH_A.suggestedFix);
    expect(r.context).toContain("POST /api/signup → 400");
  });

  it("restart from plan names the last good version, the plan and what failed", () => {
    const r = restartFromPlanRequest({
      symptom: "Sign up does nothing",
      checkpoint: { sha: "abc123", title: "Added sign-up" },
      plan: "1. form 2. api",
      tried: [AUTH_A],
    });
    expect(r.text).toContain("Added sign-up");
    expect(r.context).toContain("abc123");
    expect(r.context).toContain("without rewriting history");
    expect(r.context).toContain("1. form 2. api");
    expect(r.context).toContain(AUTH_A.likelyCause);
  });
});

describe("preview evidence", () => {
  it("is empty without a preview", async () => {
    expect(await previewEvidence("p")).toEqual({ consoleErrors: [], failedRequests: [], pageUrl: null });
    expect(ipcMock.browserRunOp).not.toHaveBeenCalled();
  });

  it("reads console errors and failed requests from the Build preview", async () => {
    preview.ctx = { tabId: "t1", url: "http://localhost:5173/" };
    ipcMock.browserRunOp.mockImplementation(async (_tab: string, op: { op: string }) =>
      op.op === "console"
        ? { done: true, ok: true, data: { messages: [{ level: "log", text: "hi" }, { level: "error", text: "Boom" }, { level: "error", text: "Boom" }] } }
        : { done: true, ok: true, data: { requests: [{ url: "/ok", status: 200 }, { url: "/api", method: "POST", status: 500 }, { url: "/x", error: "net::ERR" }] } },
    );
    const e = await previewEvidence("p");
    expect(e.consoleErrors).toEqual(["Boom"]);
    expect(e.failedRequests).toEqual(["POST /api → 500", "GET /x → net::ERR"]);
    expect(e.pageUrl).toBe("http://localhost:5173/");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./brainCall", () => ({ askBrain: vi.fn() }));

import { askBrain } from "./brainCall";
import {
  brainConnection,
  checkBrainConnection,
  noteBrainOutcome,
  resetBrainConnectionForTests,
  subscribeBrainConnection,
} from "./brainStatus";

const askMock = askBrain as unknown as ReturnType<typeof vi.fn>;
const cli = { id: "brain-cli", name: "Brain CLI" };
const ok = {
  ok: true as const,
  text: "OK",
  costUsd: 0,
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  model: null,
};

beforeEach(() => {
  resetBrainConnectionForTests();
  vi.clearAllMocks();
});

describe("brain connection", () => {
  it("starts unknown", () => {
    expect(brainConnection()).toEqual({ state: "unknown", cli: null, label: null, checkedAt: null });
  });

  it("follows outcomes passively", () => {
    noteBrainOutcome(ok, cli, { now: 5 });
    expect(brainConnection()).toEqual({ state: "connected", cli: "brain-cli", label: "Brain CLI", checkedAt: 5 });
    noteBrainOutcome({ ok: false, reason: "rate-limited", message: "limit" }, cli);
    expect(brainConnection()).toMatchObject({ state: "rate-limited", message: "limit" });
    // A feature's own failure is not evidence the connection broke…
    noteBrainOutcome({ ok: false, reason: "timeout", message: "slow" }, cli);
    expect(brainConnection().state).toBe("rate-limited");
    // …nor is a budget refusal, which never reached the CLI.
    noteBrainOutcome({ ok: false, reason: "over-budget", message: "cap" }, cli);
    expect(brainConnection().state).toBe("rate-limited");
    // A bad answer is still an answer.
    noteBrainOutcome({ ok: false, reason: "invalid-output", message: "?" }, cli);
    expect(brainConnection().state).toBe("connected");
    noteBrainOutcome({ ok: false, reason: "signed-out", message: "/login" }, cli);
    expect(brainConnection().state).toBe("signed-out");
    noteBrainOutcome({ ok: false, reason: "no-brain", message: "none" }, null);
    expect(brainConnection()).toMatchObject({ state: "missing", cli: null, label: null });
    // But a probe's failure is.
    noteBrainOutcome({ ok: false, reason: "failed", message: "boom" }, cli, { probe: true });
    expect(brainConnection()).toMatchObject({ state: "error", message: "boom" });
  });

  it("probes on the background tier, shows checking, and coalesces", async () => {
    let finish!: () => void;
    askMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            noteBrainOutcome(ok, cli);
            resolve(ok);
          };
        }),
    );
    const seen: string[] = [];
    const off = subscribeBrainConnection(() => seen.push(brainConnection().state));
    const a = checkBrainConnection("/repo");
    const b = checkBrainConnection();
    expect(a).toBe(b);
    expect(brainConnection().state).toBe("checking");
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(askMock.mock.calls[0][0]).toMatchObject({ feature: "connect-probe", tier: "background", cwd: "/repo" });
    finish();
    expect((await a).state).toBe("connected");
    expect(seen).toEqual(["checking", "connected"]);
    off();
  });

  it("reports an error when the probe itself throws", async () => {
    askMock.mockRejectedValueOnce(new Error("bridge down"));
    expect((await checkBrainConnection()).state).toBe("error");
  });
});

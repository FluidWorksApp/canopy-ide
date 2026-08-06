import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  promoteAcrossRoutes,
  type AttemptOutcome,
} from "./failureClassifier";

describe("classifyFailure", () => {
  it("reads provider throttling as a route failure", () => {
    expect(classifyFailure({ text: "Error: 429 Too Many Requests" })).toEqual({
      class: "route",
      signature: "rate-limited",
    });
  });

  it("reads a spent plan as a route failure", () => {
    expect(
      classifyFailure({ agent: "claude", text: "Claude usage limit reached." }).class,
    ).toBe("route");
  });

  it("reads the wire as transient", () => {
    expect(classifyFailure({ text: "fetch failed: ECONNRESET" })).toEqual({
      class: "transient",
      signature: "network",
    });
  });

  it("reads a context overflow as the task's problem", () => {
    expect(classifyFailure({ text: "prompt is too long: maximum context" }).class).toBe(
      "task",
    );
  });

  it("matches case-insensitively", () => {
    expect(classifyFailure({ text: "RATE LIMIT exceeded" }).signature).toBe(
      "rate-limited",
    );
  });

  it("never guesses: unmatched text is unknown with no signature", () => {
    expect(classifyFailure({ text: "something novel happened" })).toEqual({
      class: "unknown",
      signature: null,
    });
  });
});

describe("promoteAcrossRoutes", () => {
  const outcome = (route: string, signature: string, cls: "route" | "transient"): AttemptOutcome => ({
    route,
    verdict: { class: cls, signature },
  });

  it("the same route-level signature on two routes promotes to task", () => {
    expect(
      promoteAcrossRoutes([
        outcome("claude:default", "auth-expired", "route"),
        outcome("codex:default", "auth-expired", "route"),
      ]),
    ).toBe("task");
  });

  it("one route failing twice is still that route's problem", () => {
    expect(
      promoteAcrossRoutes([
        outcome("claude:default", "rate-limited", "route"),
        outcome("claude:default", "rate-limited", "route"),
      ]),
    ).toBeNull();
  });

  it("transient recurrence never promotes — providers share bad minutes", () => {
    expect(
      promoteAcrossRoutes([
        outcome("claude:default", "network", "transient"),
        outcome("codex:default", "network", "transient"),
      ]),
    ).toBeNull();
  });

  it("different signatures on different routes prove nothing", () => {
    expect(
      promoteAcrossRoutes([
        outcome("claude:default", "rate-limited", "route"),
        outcome("codex:default", "auth-expired", "route"),
      ]),
    ).toBeNull();
  });
});

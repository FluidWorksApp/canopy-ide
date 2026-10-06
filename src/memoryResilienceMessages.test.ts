import { describe, expect, it } from "vitest";
import {
  memoryPressureMessage,
  rendererRecoveryNotice,
  type RecoveryIncidentLike,
} from "./memoryResilienceMessages";

const incident = (
  overrides: Partial<RecoveryIncidentLike>,
): RecoveryIncidentLike => ({
  at_ms: 1,
  kind: "heartbeat_stall",
  generation: 4,
  detail: 30_000,
  outcome: "reload_started",
  ...overrides,
});

describe("memory resilience messages", () => {
  it("uses platform-neutral pressure copy and promises no terminal destruction", () => {
    const message = memoryPressureMessage(
      { level: 2, available_bytes: 512, total_bytes: 4_096 },
      (bytes) => `${bytes} B`,
    );
    expect(message).toContain("System memory is critically low");
    expect(message).toContain("512 B of 4096 B available");
    expect(message).toContain("running terminal processes remain attached");
    expect(message).not.toMatch(/Mac|Windows|Linux|force-quit/i);
  });

  it("reports only a completed replacement and deduplicates it", () => {
    const incidents = [
      incident({ at_ms: 10, generation: 7 }),
      incident({
        at_ms: 10,
        kind: "renderer_registered",
        generation: 8,
        detail: 0,
        outcome: "ready",
      }),
    ];
    const notice = rendererRecoveryNotice(incidents, null);
    expect(notice?.key).toBe("10:8");
    expect(notice?.body).toContain("Running terminals stayed in the native host");
    expect(rendererRecoveryNotice(incidents, notice!.key)).toBeNull();
  });

  it("does not claim recovery for a failed reload or registration alone", () => {
    expect(
      rendererRecoveryNotice(
        [incident({ outcome: "reload_failed" }), incident({ kind: "renderer_registered", outcome: "ready" })],
        null,
      ),
    ).toBeNull();
    expect(
      rendererRecoveryNotice(
        [incident({ kind: "renderer_registered", generation: 9, outcome: "ready" })],
        null,
      ),
    ).toBeNull();
    expect(
      rendererRecoveryNotice(
        [
          incident({ at_ms: 1, generation: 1 }),
          incident({ at_ms: 2, kind: "renderer_registered", generation: 2, outcome: "ready" }),
          incident({ at_ms: 3, kind: "renderer_registered", generation: 3, outcome: "ready" }),
        ],
        "1:2",
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  checkpointDecision,
  reconcileCheckpoint,
  type CheckpointContext,
  type CheckpointRecord,
} from "./vibeCheckpoints";

const SAFE: CheckpointContext = {
  isolatedOrGreenfield: true,
  cleanAtTurnStart: true,
  lineageUnchanged: true,
  pathsExclusive: true,
  secretScanClean: true,
  noOpenIncident: true,
  verification: "verified",
};

describe("checkpointDecision", () => {
  it("checkpoints only the fully safe case", () => {
    expect(checkpointDecision(SAFE)).toEqual({ checkpoint: true });
  });

  it("every single unsafe condition refuses on its own", () => {
    const flips: [keyof CheckpointContext, unknown][] = [
      ["isolatedOrGreenfield", false],
      ["cleanAtTurnStart", false],
      ["lineageUnchanged", false],
      ["pathsExclusive", false],
      ["secretScanClean", false],
      ["noOpenIncident", false],
      ["verification", "incomplete"],
    ];
    for (const [key, value] of flips) {
      const d = checkpointDecision({ ...SAFE, [key]: value } as CheckpointContext);
      expect(d.checkpoint, key).toBe(false);
      if (!d.checkpoint) expect(d.reasons, key).toHaveLength(1);
    }
  });

  it("reports every reason, not just the first", () => {
    const d = checkpointDecision({
      ...SAFE,
      cleanAtTurnStart: false,
      secretScanClean: false,
      verification: "failed",
    });
    if (d.checkpoint) throw new Error("should refuse");
    expect(d.reasons).toEqual(["dirty-at-start", "secrets-flagged", "not-verified"]);
  });
});

describe("reconcileCheckpoint", () => {
  const record = (phase: CheckpointRecord["phase"], commit?: string): CheckpointRecord => ({
    checkpointId: "cp-1",
    attemptId: "a-1",
    phase,
    title: "add checkout page",
    commit: commit ?? null,
    at: 1,
  });

  it("keeps a sealed record whose commit exists", () => {
    expect(reconcileCheckpoint(record("sealed", "abc"), () => true, null)).toEqual({
      action: "keep",
    });
  });

  it("voids a sealed record whose commit vanished — never trusted blind", () => {
    expect(reconcileCheckpoint(record("sealed", "abc"), () => false, null)).toEqual({
      action: "void",
    });
  });

  it("seals an intent whose commit landed before the crash", () => {
    expect(reconcileCheckpoint(record("intent"), () => true, "abc")).toEqual({
      action: "seal",
      commit: "abc",
    });
  });

  it("voids an intent with no commit — nothing happened, say so", () => {
    expect(reconcileCheckpoint(record("intent"), () => false, null)).toEqual({
      action: "void",
    });
  });
});

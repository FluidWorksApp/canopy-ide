import { describe, expect, it } from "vitest";
import { checkpointDecision, type CheckpointContext } from "./vibeCheckpoints";

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

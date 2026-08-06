// Whether a turn may checkpoint itself — the safety half of vibe history.
// Pure policy (plan 0109, "Checkpoints"): the impure half that runs git and
// writes two-phase records asks this module first, and the answer is
// deliberately conservative. An auto-commit that swallows a stranger's
// uncommitted work is worse than no checkpoint at all, which is why dirty,
// shared, unverified or incident-marked work gets a diff baseline and an
// explicit button instead.

import type { VerificationOutcome } from "./vibeVerification";

export interface CheckpointContext {
  /** The turn ran in a dedicated isolated worktree, or the project is
   *  vibe-greenfield (created by Build mode, no engineer history to trample). */
  isolatedOrGreenfield: boolean;
  /** Repo was clean at turn start apart from this attempt's own changes. */
  cleanAtTurnStart: boolean;
  /** Nothing else moved the branch under us since the turn began. */
  lineageUnchanged: boolean;
  /** No other session holds claims overlapping the changed paths. */
  pathsExclusive: boolean;
  /** The secret scan over the changed files came back clean. */
  secretScanClean: boolean;
  /** No safety incident (watchdog, permission stall) is open on the attempt. */
  noOpenIncident: boolean;
  verification: VerificationOutcome;
}

export type CheckpointDecision =
  | { checkpoint: true }
  /** Why not, in the order a person should hear them — the surface offers a
   *  diff view and an explicit "save this version" instead. */
  | { checkpoint: false; reasons: CheckpointRefusal[] };

export type CheckpointRefusal =
  | "shared-or-converted-dirty"
  | "dirty-at-start"
  | "lineage-moved"
  | "paths-contested"
  | "secrets-flagged"
  | "incident-open"
  | "not-verified";

export function checkpointDecision(c: CheckpointContext): CheckpointDecision {
  const reasons: CheckpointRefusal[] = [];
  if (!c.isolatedOrGreenfield) reasons.push("shared-or-converted-dirty");
  if (!c.cleanAtTurnStart) reasons.push("dirty-at-start");
  if (!c.lineageUnchanged) reasons.push("lineage-moved");
  if (!c.pathsExclusive) reasons.push("paths-contested");
  if (!c.secretScanClean) reasons.push("secrets-flagged");
  if (!c.noOpenIncident) reasons.push("incident-open");
  if (c.verification !== "verified") reasons.push("not-verified");
  return reasons.length === 0 ? { checkpoint: true } : { checkpoint: false, reasons };
}

/** Two-phase checkpoint records: intent is written before git moves, the
 *  record is sealed after, and anything found unsealed at startup is
 *  reconciled against what git actually says — never trusted, never deleted
 *  blind. This vocabulary is the contract with the tasks store. */
export interface CheckpointRecord {
  checkpointId: string;
  attemptId: string;
  phase: "intent" | "sealed";
  /** What the turn was titled; becomes the history row's label. */
  title: string;
  /** Set at seal time: the commit that IS this checkpoint. */
  commit?: string | null;
  at: number;
}

export type CheckpointReconciliation =
  | { action: "keep" } // sealed and the commit exists
  | { action: "seal"; commit: string } // intent whose commit landed before the crash
  | { action: "void" }; // intent with no commit — nothing happened, say so

export function reconcileCheckpoint(
  record: CheckpointRecord,
  commitExists: (sha: string) => boolean,
  commitForIntent: string | null,
): CheckpointReconciliation {
  if (record.phase === "sealed") {
    return record.commit && commitExists(record.commit)
      ? { action: "keep" }
      : { action: "void" };
  }
  return commitForIntent && commitExists(commitForIntent)
    ? { action: "seal", commit: commitForIntent }
    : { action: "void" };
}

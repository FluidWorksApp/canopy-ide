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

// A two-phase checkpoint record used to be declared here — intent written
// before git moves, sealed after, reconciled at startup against what git
// actually says. It was removed rather than finished, and the reasoning is
// worth keeping because the temptation to re-add it will recur.
//
// Nothing ever wrote a record. No store table held one, no path created one at
// intent time, and `reconcileCheckpoint` had no caller, so it could only ever
// have reconciled an empty set. What the code actually does is commit, then
// append the event that labels the commit a checkpoint.
//
// That ordering is not the protocol, but it fails in the safe direction. A
// crash between the two leaves a real commit that nothing labels: the user sees
// one fewer restore point than they earned. The protocol would have protected
// against the same crash leaving a *label with no commit* — a restore point
// that does not exist, which is the failure that loses work.
//
// So the surface was doing nothing except telling readers a guarantee was in
// place. Keeping a defined-but-unwritten protocol is a silent substitute for
// the guarantee it names; if this is built later, build it whole — a store
// table, a write at both ends, a startup pass — and prove it with a killed
// process, not with types.

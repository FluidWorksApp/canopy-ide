// An agent start that has to wait for a machine switch. Starting an agent on a
// machine other than the live one needs the window to move there first (the
// window has one live machine); this carries the intent across that move so the
// person asks once, not twice.
//
// What survives the move is stated in terms that mean the same on both
// machines: the project by its canonical id (placement/identity.ts), and the
// component by its label. Raw project ids are per machine and would match
// nothing. The intent is kept briefly and removed when taken, so it can never
// fire days later, or twice.
import { sameTarget, targetKey, type Target } from "./types";

const KEY = "canopy:pending-launch:v1";
/** Long enough for a workspace to wake and the window to reload; short enough
 *  that a switch the person abandoned cannot start an agent later. */
export const PENDING_LAUNCH_TTL_MS = 10 * 60_000;

export interface PendingLaunch {
  /** The agent's registry id. */
  agentId: string;
  /** Canonical id of the project (`canonicalProjectId`). */
  projectId: string;
  /** The component to start in, by label; the project's first one when absent or unmatched. */
  componentLabel?: string;
  /** What to start instead of a plain agent: a PR review or conflict
   *  resolution, or work on a ticket. The payload is the PR or ticket as the
   *  tracker returned it (plain data), not anything machine-specific. */
  then?: { kind: "pr-review" | "pr-resolve" | "ticket" | "resume"; payload: unknown };
  /** Where it was asked to run. */
  target: Target;
  at: number;
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function setPendingLaunch(intent: Omit<PendingLaunch, "at">, now = Date.now()): void {
  try {
    storage()?.setItem(KEY, JSON.stringify({ ...intent, at: now }));
  } catch {
    /* Without storage the person simply starts the agent again after the switch. */
  }
}

function read(now: number): PendingLaunch | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingLaunch> & { target?: Target };
    const target = v.target;
    const valid =
      typeof v.agentId === "string" &&
      typeof v.projectId === "string" &&
      typeof v.at === "number" &&
      target &&
      (target.kind === "local" || (target.kind === "remote" && typeof target.workspaceId === "string"));
    if (!valid || now - (v.at as number) > PENDING_LAUNCH_TTL_MS || (v.at as number) > now + 60_000) {
      storage()?.removeItem(KEY);
      return null;
    }
    return v as PendingLaunch;
  } catch {
    return null;
  }
}

/** The waiting intent, when it is for this machine and this project; removed as
 *  it is returned. An intent for anywhere else is left alone, so the project that
 *  should start the agent still finds it. */
export function takePendingLaunch(active: Target, projectId: string, now = Date.now()): PendingLaunch | null {
  const intent = read(now);
  if (!intent) return null;
  if (!sameTarget(intent.target, active) || intent.projectId !== projectId) return null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* A removal that fails leaves the TTL to expire it. */
  }
  return intent;
}

export const clearPendingLaunch = (): void => {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* Nothing to clear. */
  }
};

/** For messages: where the intent is headed. */
export const pendingTargetKey = (intent: PendingLaunch): string => targetKey(intent.target);

import {
  sameTarget,
  targetKey,
  type PlacementDecision,
  type Preference,
  type ResourceSnapshot,
  type Target,
} from "./types";

export interface PlacementInput {
  preference?: Preference;
  projectPref?: Preference;
  agentPref?: Preference;
  resources: ResourceSnapshot[];
  /** Targets the project is already set up on. Local is assumed present when omitted. */
  projectAvailability?: Target[];
  /** Keep a running thread where it is, if that target still has room. */
  sticky?: Target;
}

/** Agent beats project beats global; "auto" defers to the next level. */
export function effectivePreference(i: Pick<PlacementInput, "preference" | "projectPref" | "agentPref">): Preference {
  for (const p of [i.agentPref, i.projectPref, i.preference]) if (p && p !== "auto") return p;
  return "balance";
}

const hasRoom = (r: ResourceSnapshot) => r.online && r.capacity > 0 && r.activeAgents < r.capacity;
const side = (r: ResourceSnapshot) => (r.target.kind === "local" ? "local" : "remote");

function utilization(r: ResourceSnapshot) {
  return r.capacity > 0 ? r.activeAgents / r.capacity : 1;
}

/** Lowest utilization first, then cpu, then more free memory, then a stable key. */
function compare(a: ResourceSnapshot, b: ResourceSnapshot, tie: "local" | "remote" | null) {
  // A target whose load is unknown is not idle: rank it after any known one.
  const k = Number(!!a.loadUnknown) - Number(!!b.loadUnknown);
  if (k) return k;
  const u = utilization(a) - utilization(b);
  if (u) return u;
  const c = (a.cpuLoad ?? 0) - (b.cpuLoad ?? 0);
  if (c) return c;
  const m = (b.memFree ?? 0) - (a.memFree ?? 0);
  if (m) return m;
  if (tie && side(a) !== side(b)) return side(a) === tie ? -1 : 1;
  return targetKey(a.target).localeCompare(targetKey(b.target));
}

export function choosePlacement(input: PlacementInput): PlacementDecision {
  const pref = effectivePreference(input);
  const local: Target = { kind: "local" };
  const available = input.projectAvailability ?? [local];
  const isSetUp = (t: Target) => t.kind === "local" || available.some((a) => sameTarget(a, t));
  const usable = input.resources.filter(hasRoom);
  const none = (reason: string): PlacementDecision => ({ target: null, reason, alternatives: [], needsSetup: false });
  if (!usable.length) return none("No target is online with free capacity.");

  const done = (r: ResourceSnapshot, reason: string): PlacementDecision => ({
    target: r.target,
    reason,
    alternatives: usable.filter((o) => o !== r).sort((a, b) => compare(a, b, null)).map((o) => o.target),
    needsSetup: !isSetUp(r.target),
  });

  if (input.sticky) {
    const s = usable.find((r) => sameTarget(r.target, input.sticky as Target));
    if (s) return done(s, "Staying on the target this thread already uses.");
  }

  const tie = pref === "local" || pref === "remote" ? pref : null;
  // Targets the project already lives on win over ones that need setup,
  // unless nothing set up has room.
  const rank = (rs: ResourceSnapshot[]) => {
    const ready = rs.filter((r) => isSetUp(r.target));
    return (ready.length ? ready : rs).sort((a, b) => compare(a, b, tie));
  };

  if (pref === "local" || pref === "remote") {
    const wanted = rank(usable.filter((r) => side(r) === pref));
    if (wanted.length) return done(wanted[0], `Your preference is ${pref}.`);
    const other = pref === "local" ? "remote" : "local";
    const fallback = rank(usable.filter((r) => side(r) === other));
    const why = input.resources.some((r) => side(r) === pref && !r.online)
      ? `${pref} is offline`
      : `${pref} is full or unavailable`;
    return done(fallback[0], `${why}, so this runs ${other} instead.`);
  }

  const best = rank(usable)[0];
  return done(best, "Lowest utilization among online targets.");
}

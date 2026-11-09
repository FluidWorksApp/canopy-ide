import {
  automaticPreference,
  sameTarget,
  targetKey,
  type PlacementDecision,
  type Preference,
  type ResolvedPreference,
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

/** Agent beats project beats global. Only inheritance defers to the next level. */
export function effectivePreference(
  input: Pick<PlacementInput, "preference" | "projectPref" | "agentPref">,
): ResolvedPreference {
  for (const preference of [input.agentPref, input.projectPref, input.preference]) {
    if (preference && preference.mode !== "inherit") return preference;
  }
  return automaticPreference();
}

const hasRoom = (resource: ResourceSnapshot) =>
  resource.online && resource.capacity > 0 && resource.activeAgents < resource.capacity;

function utilization(resource: ResourceSnapshot) {
  return resource.capacity > 0 ? resource.activeAgents / resource.capacity : 1;
}

/** Lowest utilization first, then cpu, then more free memory, then a stable key. */
function compare(a: ResourceSnapshot, b: ResourceSnapshot) {
  // A target whose load is unknown is not idle: rank it after any known one.
  const known = Number(!!a.loadUnknown) - Number(!!b.loadUnknown);
  if (known) return known;
  const utilizationDifference = utilization(a) - utilization(b);
  if (utilizationDifference) return utilizationDifference;
  const cpuDifference = (a.cpuLoad ?? 0) - (b.cpuLoad ?? 0);
  if (cpuDifference) return cpuDifference;
  const memoryDifference = (b.memFree ?? 0) - (a.memFree ?? 0);
  if (memoryDifference) return memoryDifference;
  return targetKey(a.target).localeCompare(targetKey(b.target));
}

export function choosePlacement(input: PlacementInput): PlacementDecision {
  const preference = effectivePreference(input);
  const local: Target = { kind: "local" };
  const available = input.projectAvailability ?? [local];
  const isSetUp = (target: Target) =>
    target.kind === "local" || available.some((candidate) => sameTarget(candidate, target));
  const usable = input.resources.filter(hasRoom);
  const none = (reason: string): PlacementDecision => ({
    target: null,
    reason,
    alternatives: [],
    needsSetup: false,
  });

  const done = (resource: ResourceSnapshot, reason: string): PlacementDecision => ({
    target: resource.target,
    reason,
    alternatives: usable
      .filter((candidate) => candidate !== resource)
      .sort(compare)
      .map((candidate) => candidate.target),
    needsSetup: !isSetUp(resource.target),
  });

  if (preference.mode === "target") {
    const selected = usable.find((resource) => sameTarget(resource.target, preference.target));
    if (selected) return done(selected, "Selected machine is online with free capacity.");
    const known = input.resources.find((resource) => sameTarget(resource.target, preference.target));
    return none(
      known && !known.online
        ? "The selected machine is offline."
        : known
          ? "The selected machine is full."
          : "The selected machine is no longer connected.",
    );
  }

  if (!usable.length) return none("No machine is online with free capacity.");

  if (input.sticky) {
    const sticky = usable.find((resource) => sameTarget(resource.target, input.sticky as Target));
    if (sticky) return done(sticky, "Staying on the machine this thread already uses.");
  }

  // Targets the project already lives on win over ones that need setup, unless
  // nothing set up has room.
  const ready = usable.filter((resource) => isSetUp(resource.target));
  const best = (ready.length ? ready : usable).sort(compare)[0];
  return done(best, "Lowest utilization among online machines.");
}

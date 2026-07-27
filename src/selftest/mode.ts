// Whether this launch is testing itself.
//
// Kept apart from the driver so that asking the question costs nothing: the
// driver is a dynamic import that an ordinary launch never loads, while this
// flag is a boolean anything may read. The one thing the app does differently
// under it is skip the background update check — a toast arriving mid-scenario
// would cover the page the scenario is watching, and the scenario would be
// right to fail.

let scenario: string | null = null;

export function setSelftestMode(name: string) {
  scenario = name;
}

export function isSelftest(): boolean {
  return scenario !== null;
}

export function selftestScenario(): string | null {
  return scenario;
}

export interface CliProbeRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface CliProbeDeps {
  /** Execute argv directly. Implementations must not route it through a shell. */
  runArgv(opts: { argv: string[] }): Promise<CliProbeRunResult>;
}

interface ProbeResult {
  present: boolean;
  version: string | null;
}

/**
 * A deps instance represents one call-site lifetime. Weak keys keep results
 * local to that lifetime and allow the entire cache to disappear with it.
 */
const probesByCallSite = new WeakMap<
  CliProbeDeps,
  Map<string, Promise<ProbeResult>>
>();

function probe(bin: string, deps: CliProbeDeps): Promise<ProbeResult> {
  let probes = probesByCallSite.get(deps);
  if (!probes) {
    probes = new Map();
    probesByCallSite.set(deps, probes);
  }

  const cached = probes.get(bin);
  if (cached) return cached;

  const pending = deps
    .runArgv({ argv: [bin, "--version"] })
    .then((result): ProbeResult => {
      if (result.timedOut || result.exitCode !== 0) {
        return { present: false, version: null };
      }
      return {
        present: true,
        version: result.output.trim() || null,
      };
    })
    .catch((): ProbeResult => ({ present: false, version: null }));

  probes.set(bin, pending);
  return pending;
}

/** Whether a provider CLI can be executed from PATH. */
export async function probeCli(bin: string, deps: CliProbeDeps): Promise<boolean> {
  return (await probe(bin, deps)).present;
}

/** The CLI's version output, or null when it cannot be observed. */
export async function probeCliVersion(
  bin: string,
  deps: CliProbeDeps,
): Promise<string | null> {
  return (await probe(bin, deps)).version;
}

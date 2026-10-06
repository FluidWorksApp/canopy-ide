export interface MemoryPressureLike {
  level: number;
  available_bytes: number;
  total_bytes: number;
}

export interface RecoveryIncidentLike {
  at_ms: number;
  kind: string;
  generation: number;
  detail: number;
  outcome: string;
}

export interface RendererRecoveryNotice {
  key: string;
  title: string;
  body: string;
}

export function memoryPressureMessage(
  pressure: MemoryPressureLike,
  formatBytes: (bytes: number) => string,
): string {
  const severity = pressure.level >= 2 ? "critically low" : "low";
  return (
    `System memory is ${severity} — ${formatBytes(pressure.available_bytes)} of ` +
    `${formatBytes(pressure.total_bytes)} available. Canopy is releasing ` +
    "reconstructable preview and hidden-terminal state; running terminal " +
    "processes remain attached to the native host. Close unused previews or " +
    "finished terminal tabs to create more headroom."
  );
}

/** Find a completed renderer replacement that this page can safely report.
 * Array order, not timestamp comparison, handles multiple native events in the
 * same millisecond. Terminal contents and paths never enter this message. */
export function rendererRecoveryNotice(
  incidents: RecoveryIncidentLike[],
  seenKey: string | null,
): RendererRecoveryNotice | null {
  for (let index = incidents.length - 1; index >= 0; index -= 1) {
    const ready = incidents[index];
    if (ready.kind !== "renderer_registered" || ready.outcome !== "ready") continue;
    let recovery: RecoveryIncidentLike | undefined;
    for (let before = index - 1; before >= 0; before -= 1) {
      const candidate = incidents[before];
      if (
        candidate.kind === "renderer_registered" &&
        candidate.outcome === "ready"
      ) {
        break;
      }
      if (
        candidate.outcome === "reload_started" &&
        candidate.generation < ready.generation
      ) {
        recovery = candidate;
        break;
      }
    }
    if (!recovery) continue;
    const key = `${recovery.at_ms}:${ready.generation}`;
    if (key === seenKey) return null;
    return {
      key,
      title: "Canopy recovered the workspace renderer.",
      body:
        "Running terminals stayed in the native host and were reattached. " +
        "Review any visible output-gap marker before relying on terminal history.",
    };
  }
  return null;
}

export const RECOVERY_NOTICE_SESSION_KEY = "canopy.renderer-recovery-notice";

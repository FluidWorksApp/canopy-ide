export interface PressureLevelLike {
  level: number;
}

type Unlisten = () => void;

/** Install the event stream first, then read the initial snapshot. An event
 * that arrives while the snapshot invoke is in flight wins over that older
 * response, so critical admission cannot be reopened by reordering. */
export function bindMemoryPressure<T extends PressureLevelLike>(
  subscribe: (callback: (pressure: T) => void) => Promise<Unlisten>,
  snapshot: () => Promise<T | null>,
  apply: (pressure: T) => void,
): Unlisten {
  let disposed = false;
  let unlisten: Unlisten | undefined;
  let eventVersion = 0;

  void subscribe((pressure) => {
    if (disposed) return;
    eventVersion += 1;
    apply(pressure);
  })
    .then(async (off) => {
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
      const snapshotVersion = eventVersion;
      const initial = await snapshot();
      if (!disposed && initial && eventVersion === snapshotVersion) apply(initial);
    })
    .catch(async () => {
      // Pressure telemetry failure must not become an unhandled rejection.
      // Retain one best-effort snapshot path so a transient listener install
      // failure does not also disable renderer pressure relief for this boot.
      // Native PTY admission and Linux containment continue independently.
      const snapshotVersion = eventVersion;
      const initial = await snapshot().catch(() => null);
      if (!disposed && initial && eventVersion === snapshotVersion) apply(initial);
    });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

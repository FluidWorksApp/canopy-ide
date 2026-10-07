/** Single-flight acknowledgements: a wedged native dispatcher must not retain
 * a fresh invoke every tick or block the client from mounting. */
export function startRendererHeartbeat(ack: () => Promise<unknown>): () => void {
  let stopped = false;
  let timer: number | undefined;
  const tick = async () => {
    try { await ack(); }
    catch { /* The native watchdog decides when recovery is necessary. */ }
    finally { if (!stopped) timer = window.setTimeout(() => void tick(), 3_000); }
  };
  void tick();
  return () => { stopped = true; window.clearTimeout(timer); };
}

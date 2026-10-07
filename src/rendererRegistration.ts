/** A timeout cannot cancel a native invoke. Retrying it while pending queues
 * more mutations of the renderer generation and invalidates live attachments. */
export async function registerRendererWithRetry<T>(
  register: () => Promise<T>,
  report: (message: string) => void,
): Promise<T> {
  let retryMs = 100;
  let attempt=0;
  while (true) {
    const slow = window.setTimeout(
      () => report("Waiting for Canopy's native core. Existing terminals remain running."),
      2_000,
    );
    try {
      return await register();
    } catch {
      report(`Connection unavailable. Retrying automatically · attempt ${++attempt}.`);
    } finally {
      window.clearTimeout(slow);
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, retryMs));
    retryMs = Math.min(retryMs * 2, 2_000);
  }
}

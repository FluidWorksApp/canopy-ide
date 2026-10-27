// The workspace host's per-terminal memory budgets (terminal-governor.mjs)
// change state on a host timer, and a workspace has no push channel. The
// adapter's poll drains them here and replays each as the desktop's
// "terminal:governor" event, which App answers with a fresh status and, when
// a terminal is awaiting a grant, the "give it more room?" question.
type Native = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Drain the host's governor events after `cursor`; returns the new cursor.
 *  The first call (null) only learns where the present is. An older host that
 *  lacks the command keeps answering null, so polling simply stays quiet. */
export async function pollGovernorEvents(
  native: Native,
  cursor: number | null,
  emit: (event: unknown) => void,
): Promise<number | null> {
  let batch: { cursor: number; events: unknown[] };
  try {
    batch = await native("terminal_governor_events", { cursor });
  } catch (error) {
    if (/does not support terminal_governor_events yet/.test(String(error))) return null;
    throw error;
  }
  for (const event of batch.events ?? []) emit(event);
  return Number.isSafeInteger(batch.cursor) ? batch.cursor : cursor;
}

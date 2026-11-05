// How a terminal stream waits before reconnecting.
//
// The host closes a stream that has more than 1 MiB queued ("slow consumer"), and
// every reconnect starts with a snapshot of up to 512 KiB (about 683 KiB encoded).
// Resetting the backoff the moment a snapshot arrived made a stream that gets one
// and is closed again retry on a fixed one-second cycle, for every terminal at
// once, which starved the rest of the connection and made the workspace flap
// between Connected and Reconnecting. The count now resets only after the stream
// has stayed up for STREAM_STABLE_MS.

/** How long a stream must keep delivering before its failures are forgotten. */
export const STREAM_STABLE_MS = 10_000;
export const STREAM_RETRY_BASE_MS = 1_000;
export const STREAM_RETRY_MAX_MS = 30_000;

/** Wait before reconnect number `failures` (0-based): doubling to the cap, with
 *  +/-25% jitter so a window of terminals does not reconnect in lockstep. */
export function streamRetryDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** Math.min(failures, 5));
  return Math.round(base * (0.75 + random() * 0.5));
}

// The frontend end of Store::Sessions: one notice that the digests moved.
//
// Session digests are written by the hook binary in another process, so no
// frontend mutator could ever announce them — they were the textbook case of
// the hole the change channel exists to close, and yet they were the store
// still being polled: three independent 4-second intervals (the strip, the
// panel, the page) re-reading the same files to discover, almost always, that
// nothing had changed.
//
// This module carries no data on purpose. The digest fetch stays with each
// consumer — they filter by different roots and join to different things —
// and what they share is only the fact that a fetch is worth making now.
//
// Store-only CLIs (omp) write digests with no hook event alongside, so the
// bridge never pulses for them: consumers keep a slow fallback poll at
// `DIGEST_FALLBACK_MS` for exactly that, and it is the ceiling on their
// staleness rather than the cadence of everything.
import { createChannel } from "./channel";
import { registerStore } from "./stores";

export const DIGEST_FALLBACK_MS = 30_000;

const board = createChannel(0);

registerStore("sessions", () => board.set(board.get() + 1));

/** Hear that some digest changed — written, updated or forgotten. The payload
 *  is deliberately not which one: readers refetch what they show. */
export const subscribeSessionDigests = board.subscribe;

/** Test seam. */
export const __resetSessionDigests = () => board.reset();

/** Test seam: what a store:change for "sessions" does, without the wire. */
export const __pulseSessionDigests = () => board.set(board.get() + 1);

// Which session is running in which terminal — answered once.
//
// There were two answers to this. The tab strip keyed off the pty id the hook
// stamped on its events this launch; the Agents panel keyed off the digest's
// recorded `surface` plus the app instance. Neither is wrong, and they are not
// the same map: the first cannot bind to a recycled pty number but goes blank
// when a session's events age out of the event ring, and the second survives
// that but is only as fresh as the last digest write. Two maps meant two
// surfaces could describe different sessions for the same tab.
//
// This prefers the event stamp and falls back to surface+instance, so it is the
// better half of each.
import type { DigestLike } from "./ladder";

export interface BindableDigest extends DigestLike {
  session_id: string;
  /** The pty that owned this session when the digest was last written. */
  surface?: string;
  /** The app launch that spawned that terminal. */
  instance?: string;
}

export interface BindableEvent {
  ts: number;
  data?: { pty?: number | null; sessionId?: string | null } | null;
}

export interface BindSnapshot {
  digests: readonly BindableDigest[];
  events: readonly BindableEvent[];
  /** This app launch (env CANOPY_INSTANCE), when we know it. */
  instance: string | null;
  /** Every pty id currently alive. Required: without it we cannot tell a
   *  terminal that closed from one we simply have no news about, and that
   *  distinction is the whole of the `gone` verdict. */
  livePtys: ReadonlySet<number>;
}

export interface Bound {
  /** Which session each live terminal is running. */
  sessionByPty: Map<number, string>;
  /** Every digest we resolved, by session id. */
  digestBySession: Map<string, BindableDigest>;
  /** Session ids whose terminal we authoritatively own and which is no longer
   *  alive. The ONLY source of `PtyEvidence.kind === "gone"`.
   *
   *  The three-part test is the point. A session running outside Canopy — a
   *  claude started in Terminal.app under the same global hooks — has no
   *  surface of ours and must never land here: we would report it ended while
   *  it was mid-turn. So a row qualifies only when it names a surface, that
   *  surface is stamped with *this* launch, and that pty is absent from the
   *  live set. */
  endedSessions: Set<string>;
}

export function resolveSessions(snap: BindSnapshot): Bound {
  // The event stamp first: latest event per pty wins. A pty id is only unique
  // within one launch, and these events are from this one by construction.
  const latest = new Map<number, { sid: string; ts: number }>();
  for (const e of snap.events) {
    const d = e.data;
    if (!d || d.pty == null || !d.sessionId) continue;
    const prev = latest.get(d.pty);
    if (!prev || e.ts >= prev.ts) latest.set(d.pty, { sid: d.sessionId, ts: e.ts });
  }
  const sessionByPty = new Map<number, string>();
  for (const [pty, v] of latest) sessionByPty.set(pty, v.sid);

  // Then the recorded surface, for sessions whose events have aged out of the
  // ring. Newest digest per surface, and never one from another launch.
  const bySurface = new Map<string, BindableDigest>();
  for (const d of snap.digests) {
    if (!d.surface) continue;
    if (snap.instance && d.instance && d.instance !== snap.instance) continue;
    const prev = bySurface.get(d.surface);
    if (!prev || (d.updated ?? 0) > (prev.updated ?? 0)) bySurface.set(d.surface, d);
  }
  for (const [surface, d] of bySurface) {
    const pty = Number(surface);
    if (!Number.isFinite(pty) || sessionByPty.has(pty)) continue;
    sessionByPty.set(pty, d.session_id);
  }

  const digestBySession = new Map<string, BindableDigest>();
  for (const d of snap.digests) {
    const prev = digestBySession.get(d.session_id);
    if (!prev || (d.updated ?? 0) > (prev.updated ?? 0)) {
      digestBySession.set(d.session_id, d);
    }
  }

  const endedSessions = new Set<string>();
  for (const [surface, d] of bySurface) {
    const pty = Number(surface);
    if (!Number.isFinite(pty)) continue;
    if (snap.instance && d.instance !== snap.instance) continue;
    if (!d.instance) continue; // pre-upgrade: we cannot prove whose pty this was
    if (snap.livePtys.has(pty)) continue;
    endedSessions.add(d.session_id);
  }

  return { sessionByPty, digestBySession, endedSessions };
}

/** Whether a digest belongs to some other launch of the app, so its recorded
 *  surface means nothing here. */
export function isForeign(
  d: { instance?: string },
  instance: string | null,
): boolean {
  return !!instance && !!d.instance && d.instance !== instance;
}

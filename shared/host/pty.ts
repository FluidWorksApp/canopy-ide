import type { PtyHandlers, Transport } from "../transport";
import type { Wire } from "./wire";

/** Input typed while the socket is down (reconnecting, a phone waking up) is
 * kept, per PTY, up to this many characters... */
export const INPUT_BACKLOG_CHARS = 16384;
/** ...and for this long. Keystrokes replayed minutes later could answer a
 * prompt that was not on screen when they were typed, so older input is
 * discarded — and the view is told so. */
export const INPUT_BACKLOG_MS = 30_000;
/** How soon input the socket refused for backpressure is retried. */
const RETRY_MS = 250;

const WAITING = "Reconnecting — your input will be sent when the connection is back.";
const OVERFLOW = "Couldn't send input — reconnecting. Type it again once connected.";
const EXPIRED = "Input typed while disconnected was not sent. Type it again.";
const PARTIAL = "Some input typed while disconnected was not sent. Check the prompt before continuing.";

type Backlog = { chunks: string[]; chars: number; since: number; dropped: boolean };

/** One subscription per host PTY, shared by all views in this client. A socket
 * reconnect reattaches to the existing process and receives a fresh snapshot;
 * it must never spawn a replacement process or take over desktop ownership.
 *
 * Input is never dropped silently: a write the socket refuses is queued
 * (bounded in size and age), retried, and flushed in order after reattaching;
 * whatever cannot be delivered is reported through `onNotice`. */
export function socketTerminals(wire: Wire): Transport & { dispose(): void } {
  const subscribers = new Map<number, Set<PtyHandlers>>();
  const backlogs = new Map<number, Backlog>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const notify = (pty: number, text: string | null) =>
    subscribers.get(pty)?.forEach(handler => handler.onNotice?.(text));

  /** Send what is queued for one PTY, oldest first. False if the socket
   * refused part of it (the rest stays queued). */
  const flush = (pty: number): boolean => {
    const backlog = backlogs.get(pty);
    if (!backlog) return true;
    if (Date.now() - backlog.since > INPUT_BACKLOG_MS) {
      backlogs.delete(pty);
      notify(pty, EXPIRED);
      return true;
    }
    while (backlog.chunks.length) {
      if (!wire.send({ t: "input", pty, data: backlog.chunks[0] })) return false;
      backlog.chars -= backlog.chunks.shift()!.length;
    }
    backlogs.delete(pty);
    notify(pty, backlog.dropped ? PARTIAL : null);
    return true;
  };

  const flushAll = () => {
    let pending = false;
    for (const pty of [...backlogs.keys()]) if (!flush(pty)) pending = true;
    return pending;
  };

  // A refusal while the socket is up is backpressure, and no connection event
  // will come to flush it: poll until it drains. While the socket is down the
  // reconnect flushes instead.
  const scheduleRetry = () => {
    if (retry || disposed || !wire.connected) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (!disposed && flushAll()) scheduleRetry();
    }, RETRY_MS);
  };

  const enqueue = (pty: number, data: string) => {
    let backlog = backlogs.get(pty);
    if (!backlog) backlogs.set(pty, backlog = { chunks: [], chars: 0, since: Date.now(), dropped: false });
    if (backlog.chars + data.length > INPUT_BACKLOG_CHARS) {
      backlog.dropped = true;
      notify(pty, OVERFLOW);
      scheduleRetry();
      return;
    }
    backlog.chunks.push(data);
    backlog.chars += data.length;
    notify(pty, WAITING);
    scheduleRetry();
  };

  const offMessage = wire.on(message => {
    const handlers = subscribers.get(message.pty);
    if (!handlers) return;
    if (message.t === "pty-reset") handlers.forEach(handler => handler.onReset());
    else if (message.t === "pty-size") handlers.forEach(handler => handler.onSize(message.cols, message.rows));
    else if (message.t === "pty-gone") handlers.forEach(handler => handler.onGone());
    else if (message.t === "input-error") {
      const why = typeof message.error === "string" && message.error ? message.error : "the terminal did not accept it";
      handlers.forEach(handler => handler.onNotice?.(`Couldn't send input: ${why}`));
    } else if (message.t === "pty" && typeof message.b64 === "string") {
      try {
        const bytes = Uint8Array.from(atob(message.b64), character => character.charCodeAt(0));
        handlers.forEach(handler => handler.onData(bytes));
      } catch { /* A malformed frame is not terminal input. */ }
    }
  });
  const offConnection = wire.onConnection(up => {
    if (!up) return;
    for (const pty of subscribers.keys()) wire.send({ t: "attach", pty });
    if (flushAll()) scheduleRetry();
  });
  return {
    attachPty(pty, handler) {
      if (disposed) throw new Error("Host connection closed");
      let handlers = subscribers.get(pty);
      if (!handlers) subscribers.set(pty, handlers = new Set());
      const shared = handlers.size > 0;
      handlers.add(handler);
      // A new view needs the bounded catch-up snapshot too. Reset the shared
      // subscription, so every view receives the same authoritative snapshot.
      if (shared) wire.send({ t: "detach", pty });
      wire.send({ t: "attach", pty });
      if (backlogs.has(pty)) handler.onNotice?.(WAITING);
      let attached = true;
      return () => {
        if (!attached || disposed) return;
        attached = false;
        handlers.delete(handler);
        if (!handlers.size) {
          subscribers.delete(pty);
          wire.send({ t: "detach", pty });
        }
      };
    },
    writePty(pty, data) {
      if (disposed || !data) return;
      // Behind a backlog, new input queues too: it must not overtake it.
      if (backlogs.has(pty) || !wire.send({ t: "input", pty, data })) enqueue(pty, data);
    },
    killPty(pty) { if (!disposed) wire.send({ t: "kill", pty }); },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(retry);
      for (const pty of subscribers.keys()) wire.send({ t: "detach", pty });
      subscribers.clear();
      backlogs.clear();
      offMessage();
      offConnection();
    },
  };
}

import type { PtyHandlers, Transport } from "../transport";
import type { Wire } from "./wire";

/** One subscription per host PTY, shared by all views in this client. A socket
 * reconnect reattaches to the existing process and receives a fresh snapshot;
 * it must never spawn a replacement process or take over desktop ownership. */
export function socketTerminals(wire: Wire): Transport & { dispose(): void } {
  const subscribers = new Map<number, Set<PtyHandlers>>();
  let disposed = false;
  const offMessage = wire.on(message => {
    const handlers = subscribers.get(message.pty);
    if (!handlers) return;
    if (message.t === "pty-reset") handlers.forEach(handler => handler.onReset());
    else if (message.t === "pty-size") handlers.forEach(handler => handler.onSize(message.cols, message.rows));
    else if (message.t === "pty-gone") handlers.forEach(handler => handler.onGone());
    else if (message.t === "pty" && typeof message.b64 === "string") {
      try {
        const bytes = Uint8Array.from(atob(message.b64), character => character.charCodeAt(0));
        handlers.forEach(handler => handler.onData(bytes));
      } catch { /* A malformed frame is not terminal input. */ }
    }
  });
  const offConnection = wire.onConnection(up => {
    if (up) for (const pty of subscribers.keys()) wire.send({ t: "attach", pty });
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
    writePty(pty, data) { if (!disposed) wire.send({ t: "input", pty, data }); },
    killPty(pty) { if (!disposed) wire.send({ t: "kill", pty }); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const pty of subscribers.keys()) wire.send({ t: "detach", pty });
      subscribers.clear();
      offMessage();
      offConnection();
    },
  };
}

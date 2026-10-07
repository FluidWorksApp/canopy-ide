import { vi } from "vitest";
import type { Msg, Wire } from "../../shared/host/wire";

export function fakeWire() {
  const messages = new Set<(message: Msg) => void>();
  const statuses = new Set<(up: boolean) => void>();
  const wire = {
    connected: true,
    // Like the real Wire: a send while the socket is down is refused.
    send: vi.fn((_message: Msg) => wire.connected),
    on(handler: (message: Msg) => void) { messages.add(handler); return () => messages.delete(handler); },
    onConnection(handler: (up: boolean) => void) { statuses.add(handler); return () => statuses.delete(handler); },
  };
  return {
    wire: wire as unknown as Wire,
    send: wire.send,
    receive(message: Msg) { messages.forEach(handler => handler(message)); },
    status(up: boolean) { wire.connected = up; statuses.forEach(handler => handler(up)); },
    subscriptions: () => messages.size + statuses.size,
  };
}

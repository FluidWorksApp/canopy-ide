import { makeRpc } from "../../shared/host/rpc";
import { socketTerminals } from "../../shared/host/pty";
import type { Wire, Msg } from "../../shared/host/wire";
import { HOST_PROTOCOL, HostUnavailableError, type Host, type HostChannel, type HostEvent, type HostHandshake, type UnlistenFn } from "./contract";

/** A socket adapter uses exactly the same invoke/listen boundary as native IPC.
 * Capabilities come from the authenticated host; a frontend cannot grant itself
 * access by adding a command name. It never falls back to local native IPC. */
export class SocketHost implements Host {
  readonly kind = "socket" as const;
  readonly terminals: ReturnType<typeof socketTerminals>;
  private wire: Wire;
  private rpc: ReturnType<typeof makeRpc>;
  private listeners = new Map<string, Set<(event: HostEvent<unknown>) => void>>();
  private off: UnlistenFn[] = [];
  private handshake: HostHandshake | null = null;
  private readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private eventId = 0;
  private environmentId: string | null = null;
  private protocolError: Error | null = null;

  constructor(wire: Wire) {
    this.wire = wire;
    this.rpc = makeRpc(wire);
    this.terminals = socketTerminals(wire);
    this.off.push(wire.on(message => this.receive(message)));
    this.off.push(wire.onConnection(up => {
      this.handshake = null;
      if (up) this.negotiate();
      else this.failReady(new HostUnavailableError());
    }));
    if (wire.connected) this.negotiate();
  }

  private negotiate() {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      this.protocolError = new Error("This host did not complete the IDE connection handshake. Update the host and reconnect.");
      this.failReady(this.protocolError);
    }, 10_000);
    if (!this.wire.send({ t: "hello", protocol: HOST_PROTOCOL })) {
      this.failReady(new HostUnavailableError());
    }
  }

  private failReady(error: Error) {
    clearTimeout(this.handshakeTimer);
    this.readyWaiters.forEach(waiter => waiter.reject(error));
    this.readyWaiters.clear();
  }

  private receive(message: Msg) {
    if (this.disposed) return;
    if (message.t === "hello") {
      const value = message.host as HostHandshake | undefined;
      if (value?.protocol !== HOST_PROTOCOL || typeof value.environmentId !== "string" ||
          !value.environmentId || !Array.isArray(value.commands) || !Array.isArray(value.events) ||
          !Array.isArray(value.streams) || ![...value.commands, ...value.events, ...value.streams].every(item => typeof item === "string")) {
        this.protocolError = new Error("The host uses an incompatible IDE connection protocol");
        this.failReady(this.protocolError);
        return;
      }
      if (this.environmentId && this.environmentId !== value.environmentId) {
        this.protocolError = new Error("The connected host changed. Reload before opening its workspace.");
        this.failReady(this.protocolError);
        return;
      }
      if (this.protocolError) return;
      this.environmentId = value.environmentId;
      this.handshake = value;
      clearTimeout(this.handshakeTimer);
      this.readyWaiters.forEach(waiter => waiter.resolve());
      this.readyWaiters.clear();
    } else if (message.t === "event" && this.handshake?.events.includes(message.name)) {
      const event = { event: message.name as string, id: ++this.eventId, payload: message.payload };
      this.listeners.get(event.event)?.forEach(handler => handler(event));
    }
  }

  async ready(): Promise<HostHandshake> {
    if (this.protocolError) throw this.protocolError;
    if (this.disposed || !this.wire.connected) throw new HostUnavailableError();
    if (!this.handshake) await new Promise<void>((resolve, reject) => this.readyWaiters.add({ resolve, reject }));
    if (!this.handshake) throw new HostUnavailableError();
    return this.handshake;
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const host = await this.ready();
    if (!host.commands.includes(command)) throw new Error(`This host does not expose ${command} over the remote connection`);
    return this.rpc.call<T>(command, args);
  }

  async listen<T>(event: string, handler: (event: HostEvent<T>) => void): Promise<UnlistenFn> {
    const host = await this.ready();
    if (!host.events.includes(event)) throw new Error(`This host does not stream ${event}`);
    const handlers = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, handlers);
    handlers.add(handler as (event: HostEvent<unknown>) => void);
    return () => {
      handlers.delete(handler as (event: HostEvent<unknown>) => void);
      if (!handlers.size) this.listeners.delete(event);
    };
  }

  channel<T>(): HostChannel<T> {
    // Tauri channel ids are local renderer credentials. Never serialize them
    // into socket arguments or pretend an unsupported stream has attached.
    throw new Error("This host connection does not support native channel commands");
  }

  onBusy(callback: (busy: boolean) => void) { return this.rpc.onBusy(callback); }

  dispose() {
    this.disposed = true;
    this.handshake = null;
    this.failReady(new HostUnavailableError("Host connection closed"));
    this.off.splice(0).forEach(off => off());
    this.rpc.dispose();
    this.terminals.dispose();
    this.listeners.clear();
  }
}

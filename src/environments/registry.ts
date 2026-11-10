// The set of machines this window is connected to, and which one is primary.
// Today there is exactly one live host; this is the shape that lets there be
// more without every caller changing at once (docs/multi-host-design.md §4.2).
// Nothing here connects anything: a host is registered by whoever built it.
import type { Host } from "../host/contract";
import type { EnvId } from "./scoped";

export type EnvironmentStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "auth-error"
  | "stopped"
  | "hibernated";

export interface Environment {
  id: EnvId;
  name: string;
  host: Host;
  status: EnvironmentStatus;
  /** From the host's token scope: a view-only connection cannot write. */
  readOnly: boolean;
}

type Listener = () => void;

export class EnvironmentRegistry {
  private readonly byId = new Map<EnvId, Environment>();
  private primaryId: EnvId | null = null;
  private readonly listeners = new Set<Listener>();

  /** Add or replace an environment. The first one registered is the primary,
   *  unless `secondary` says this one is only an addition to the window's own
   *  machine, which the registry may not know about (the window's host is not
   *  registered here yet). */
  register(env: Environment, options: { secondary?: boolean } = {}): void {
    this.byId.set(env.id, env);
    if (this.primaryId === null && !options.secondary) this.primaryId = env.id;
    this.notify();
  }

  /** Remove an environment. Removing the primary promotes the next one, or
   *  leaves none; the removed host's owner is responsible for disposing it. */
  unregister(id: EnvId): void {
    if (!this.byId.delete(id)) return;
    if (this.primaryId === id) this.primaryId = this.byId.keys().next().value ?? null;
    this.notify();
  }

  get(id: EnvId): Environment | undefined {
    return this.byId.get(id);
  }

  list(): Environment[] {
    return [...this.byId.values()];
  }

  /** The environment a record without one belongs to. */
  get primary(): Environment | undefined {
    return this.primaryId === null ? undefined : this.byId.get(this.primaryId);
  }

  setPrimary(id: EnvId): void {
    if (!this.byId.has(id) || this.primaryId === id) return;
    this.primaryId = id;
    this.notify();
  }

  /** Record a status change (from connection state or workspace lifecycle). */
  setStatus(id: EnvId, status: EnvironmentStatus): void {
    const env = this.byId.get(id);
    if (!env || env.status === status) return;
    this.byId.set(id, { ...env, status });
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* One subscriber's failure must not stop the others hearing of a change. */
      }
    }
  }
}

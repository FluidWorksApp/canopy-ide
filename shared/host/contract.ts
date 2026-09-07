/** The IDE's connection to its execution host. UI code never selects a wire. */
export type UnlistenFn = () => void;

export interface HostEvent<T> {
  event: string;
  id: number;
  payload: T;
}

export interface HostChannel<T> {
  onmessage: (message: T) => void;
}

export interface Host {
  readonly kind: "native" | "socket";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (event: HostEvent<T>) => void): Promise<UnlistenFn>;
  channel<T>(): HostChannel<T>;
}

export interface HostHandshake {
  protocol: number;
  environmentId: string;
  commands: string[];
  events: string[];
  streams: string[];
}

export const HOST_PROTOCOL = 1;

export class HostUnavailableError extends Error {
  constructor(message = "The connection to the host is unavailable") {
    super(message);
    this.name = "HostUnavailableError";
  }
}

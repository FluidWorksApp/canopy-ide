import type { Host, HostChannel, HostEvent, UnlistenFn } from "./contract";
import { nativeHost } from "./native";

let host: Host = nativeHost;

/** Install before importing/mounting the IDE. Switching a live IDE's host is
 * unsafe: its models, paths and process ids belong to the original host. */
export function installHost(connection: Host): () => void {
  const previous = host;
  host = connection;
  return () => {
    if (host === connection) host = previous;
  };
}

export const isReadOnlyHost = () => host.readOnly===true;
export const isRemoteHost = () => host.kind === "socket";
/** Execution runs on a workspace VM while this window's computer stays the
 *  desktop (NativeWorkspaceHost) — unlike the portal, whose host IS the desktop. */
export const isWorkspaceHost = () => typeof host.invokeDesktop === "function";
export const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  args === undefined ? host.invoke<T>(command) : host.invoke<T>(command, args);
/** For desktop-level features that must ask the computer showing the IDE even
 * while execution is remote. Every other host already is that computer. */
export const invokeDesktop = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  host.invokeDesktop ? host.invokeDesktop<T>(command, args) : invoke<T>(command, args);
export const listen = <T>(event: string, handler: (event: HostEvent<T>) => void): Promise<UnlistenFn> =>
  host.listen(event, handler);
export const createChannel = <T>(): HostChannel<T> => host.channel<T>();
export type { UnlistenFn } from "./contract";

// The desktop commands for saved T3 Code machines (src-tauri/src/t3_client.rs,
// t3_socket.rs). Neither the access token nor the socket's ticket or URL comes
// to this side: Rust opens the RPC socket and passes its text messages over a
// channel, so plain-ws machines on a LAN or tailnet work under Canopy's CSP.
import { Channel, invoke } from "@tauri-apps/api/core";
import { T3RpcClient, TransportInbox, type RpcTransport } from "./rpc";

export interface T3Machine {
  readonly id: string;
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  /** Space-separated scopes the machine granted (packages/shared/src/oauthScope.ts). */
  readonly scope: string;
  readonly expiresAt: string;
}

export interface T3Preview {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly serverVersion: string;
  readonly platform?: { readonly os?: string; readonly arch?: string } | null;
}

/** t3_socket.rs SocketEvent: data and control never share a shape. */
export type T3SocketEvent =
  | { readonly kind: "message"; readonly data: string }
  | { readonly kind: "closed"; readonly code: number; readonly reason: string };

/** Sends waiting on the desktop, beyond which the transport gives up. The
 *  desktop's own queue (t3_socket.rs SEND_QUEUE) refuses a send when full. */
const MAX_PENDING_SENDS = 1024;

export const listT3Machines = () => invoke<T3Machine[]>("t3_list");
export const describeT3Link = (link: string) => invoke<T3Preview>("t3_describe", { link });
export const pairT3Machine = (link: string, expectedEnvironmentId: string) =>
  invoke<T3Machine>("t3_pair", { link, expectedEnvironmentId });
export const removeT3Machine = (id: string) => invoke<void>("t3_remove", { id });

export const grants = (machine: Pick<T3Machine, "scope">, scope: string) =>
  machine.scope.split(" ").includes(scope);

/** The RPC socket to a saved machine, opened by the desktop (which mints the
 *  ticket and re-checks the machine's environment id). Resolves once open.
 *  Sends go one at a time, in order; a refused send ends the transport, since
 *  a lost frame (an Ack, an Interrupt) would leave the RPC session wrong. */
export async function tauriTransport(id: string): Promise<RpcTransport> {
  const inbox = new TransportInbox();
  const channel = new Channel<T3SocketEvent>();
  // Events can arrive before t3_socket_open returns; the inbox holds them.
  channel.onmessage = event => {
    if (event.kind === "message") inbox.message(event.data);
    else if (event.kind === "closed") inbox.closed(event.reason || `Socket closed (${event.code})`);
  };
  const socketId = await invoke<number>("t3_socket_open", { id, onFrame: channel });
  let closed = false;
  let pending = 0;
  let sending: Promise<unknown> = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    // After the send in flight; the ones queued behind it are skipped.
    void sending.then(() => invoke("t3_socket_close", { socketId })).catch(() => {});
  };
  return {
    send: text => {
      if (closed) return;
      if (pending >= MAX_PENDING_SENDS) {
        close();
        inbox.closed("The T3 connection is not keeping up.");
        return;
      }
      pending++;
      sending = sending.then(() => closed ? undefined : invoke("t3_socket_send", { socketId, text })).then(
        () => { pending--; },
        (error: unknown) => {
          pending--;
          if (closed) return;
          close();
          inbox.closed(error instanceof Error ? error.message : String(error));
        },
      );
    },
    close,
    onMessage: listener => inbox.onMessage(listener),
    onClose: listener => inbox.onClose(listener),
  };
}

/** Opens the RPC socket to a saved machine through the desktop. */
export async function connectT3Machine(id: string): Promise<T3RpcClient> {
  const client = new T3RpcClient(tauriTransport(id));
  await client.ready();
  return client;
}

// Internet sharing through Canopy's own link: the remote server plus a tunnel to
// Canopy's edge. Desktop sharing over the internet rides on it, so one call here
// brings it up (idempotent) and hands back the public https origin.
import * as ipc from "./ipc";

/** tunnel.rs's provider id for the link through Canopy's edge. */
export const CANOPY_LINK = "canopy";

/** The public https origin of this machine's Canopy link, starting the remote
 *  server and the tunnel when they are not already up. Throws with the reason
 *  when the link can't be opened (offline, signed out, edge unavailable). */
export async function ensureInternetLink(): Promise<string> {
  let status = await ipc.remoteStatus();
  if (!status.enabled) status = await ipc.remoteEnable();
  let tunnel = await ipc.tunnelStatus().catch(() => null);
  const up = tunnel && tunnel.running && tunnel.provider === CANOPY_LINK && tunnel.url && !tunnel.message;
  if (!up) tunnel = await ipc.tunnelStart(CANOPY_LINK, status.port);
  if (!tunnel?.url) throw new Error(tunnel?.message || "Couldn't open an internet link. Check your connection and that you're signed in.");
  return new URL(tunnel.url).origin;
}

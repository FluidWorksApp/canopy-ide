// Internet sharing through Canopy's own link: the remote server plus a tunnel to
// Canopy's edge. Desktop sharing over the internet rides on it, so one call here
// brings it up (idempotent) and hands back the public https origin.
import * as ipc from "./ipc";

/** tunnel.rs's provider id for the link through Canopy's edge. */
export const CANOPY_LINK = "canopy";

/** The public https origin of this machine's Canopy link, starting the remote
 *  server and the tunnel when they are not already up. Throws with the reason
 *  when the link can't be opened (offline, signed out, edge unavailable). */
export async function ensureInternetLink(opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<string> {
  let status = await ipc.remoteStatus();
  if (!status.enabled) status = await ipc.remoteEnable();
  let tunnel = await ipc.tunnelStatus().catch(() => null);
  const isUp = (t: typeof tunnel) => !!t && t.running && t.provider === CANOPY_LINK && !!t.url && !t.message;
  if (!isUp(tunnel)) tunnel = await ipc.tunnelStart(CANOPY_LINK, status.port);
  // The tunnel starts in the background: tunnelStart answers "Starting…" with no
  // address yet. Wait for it to come up (or say why it won't) instead of failing on that.
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (!isUp(tunnel) && tunnel?.running && tunnel.message === STARTING && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
    tunnel = await ipc.tunnelStatus().catch(() => tunnel);
  }
  if (!tunnel?.url) {
    const m = tunnel?.message;
    throw new Error(m && m !== STARTING ? m : "The internet link didn't come up. Check your connection and that you're signed in.");
  }
  return new URL(tunnel.url).origin;
}

const STARTING = "Starting…";

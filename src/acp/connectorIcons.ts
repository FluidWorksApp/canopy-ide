// Brand marks for ACP connectors. The ACP registry publishes an SVG per agent;
// Canopy's CSP blocks remote images but allows https `fetch`, so the SVG is
// fetched once and shown from a data: URL (an <img> never runs an SVG's
// scripts). Only the registry's own CDN is trusted for this, so a registry
// entry cannot point an icon at an arbitrary host.

const TRUSTED_HOST = "cdn.agentclientprotocol.com";
const MAX_SVG_BYTES = 64 * 1024;
const STORE_KEY = "canopy.connectorIcons.v1";

/** The registry's icon URL, or undefined when it is not one Canopy will load. */
export function trustedIconUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== TRUSTED_HOST) return undefined;
    if (!url.pathname.toLowerCase().endsWith(".svg")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

const dataUrls = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** The icon as a data: URL, or null when it cannot be loaded. A success is
 *  cached for the session; a failure is retried on the next ask. */
export function loadConnectorIcon(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const safe = trustedIconUrl(url);
  if (!safe) return Promise.resolve(null);
  if (dataUrls.has(safe)) return Promise.resolve(dataUrls.get(safe) ?? null);
  const pending = inflight.get(safe);
  if (pending) return pending;
  const run = (async () => {
    try {
      const response = await fetchImpl(safe, { credentials: "omit", redirect: "error" });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > MAX_SVG_BYTES || !/<svg[\s>]/i.test(text)) return null;
      return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
    } catch {
      return null;
    }
  })().then((result) => {
    // Only a success is remembered: an icon missed while offline should load
    // the next time the list opens, not stay missing until restart.
    if (result) dataUrls.set(safe, result);
    inflight.delete(safe);
    return result;
  });
  inflight.set(safe, run);
  return run;
}

function readStore(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [id, url] of Object.entries(raw)) {
      const safe = trustedIconUrl(url);
      if (safe) out[id] = safe;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember which icon belongs to a connector Canopy added, by its CLI id, so
 *  the launcher and the agent list can draw it later without the registry. */
export function registerConnectorIcon(cliId: string, url: string | undefined): void {
  const safe = trustedIconUrl(url);
  if (!safe || !cliId) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), [cliId]: safe }));
  } catch {
    /* Icons are decoration; losing the memory of one is harmless. */
  }
}

export function connectorIconFor(cliId: string): string | undefined {
  return readStore()[cliId];
}

/** Test seam. */
export function resetConnectorIconCache(): void {
  dataUrls.clear();
  inflight.clear();
}

import { remoteEndpoint } from "./client";

/** What a person runs on their machine to get a link. */
export const CANOPY_HOST_COMMAND = "npx canopy-host up";

const NOT_A_LINK = "This isn't a canopy-host link. It starts with http:// and ends with #token=…";

/** The link `canopy-host up` prints: http://<host>:<port>/connect#token=<token>.
 *  The token sits in the fragment, so it is never sent anywhere as part of a URL. */
export function parseConnectLink(value: string): { endpoint: string; token: string } {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(NOT_A_LINK); }
  const token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
  if (!/^https?:$/.test(url.protocol) || token.length < 16) throw new Error(NOT_A_LINK);
  try { return { endpoint: remoteEndpoint(url.origin), token }; }
  catch { throw new Error("This address isn't private. Connect over Tailscale or an SSH tunnel, or use https."); }
}

/** The link as the field shows it: the address in full, anything after #token= hidden, valid or not. */
export const maskedLink = (link: string) => link.replace(/(#token=).+$/s, (_, prefix: string) => prefix + "•".repeat(12));

const hostOf = (endpoint: string) => new URL(endpoint).hostname;
const isTunnel = (endpoint: string) => ["127.0.0.1", "localhost", "[::1]"].includes(hostOf(endpoint));

/** How the app reaches the machine: "over Tailscale", "through your SSH tunnel" or "over https". */
export function routeName(endpoint: string): string {
  if (isTunnel(endpoint)) return "through your SSH tunnel";
  return /\.ts\.net$/i.test(hostOf(endpoint)) ? "over Tailscale" : "over https";
}

/** The line under the link field once it is read. */
export const routeLabel = (endpoint: string) => `${hostOf(endpoint)} · ${routeName(endpoint)}`;

/** One plain sentence for a failed connect. */
export function connectError(error: unknown, endpoint: string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/unauthori[sz]ed|forbidden|\b40[13]\b|invalid token|access token/i.test(text))
    return "The machine didn't accept this link. Run `canopy-host link` there and paste the new one.";
  if (/fetch|network|load failed|refused|timed? ?out|unreachable|ECONN|ENOTFOUND|abort/i.test(text)) {
    const host = hostOf(endpoint);
    return isTunnel(endpoint)
      ? `Can't reach ${host}. Check canopy-host is running there, and that your SSH tunnel is open.`
      : `Can't reach ${host}. Check canopy-host is running there, and that this Mac is on the same tailnet.`;
  }
  return text;
}

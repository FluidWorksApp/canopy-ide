// Account requests that reach a canopyide.dev older than this app.
//
// A newer Canopy can ship before the website it talks to is updated. A route
// the server doesn't have yet answers with the host's own 404 page, which the
// Rust side reports as NOT_ON_SERVER_YET (client_mode.rs); an existing route
// that doesn't take the new verb answers 405. Either way the honest message is
// "your server doesn't offer this yet", never a raw status or "invalid
// response" that reads like something broke.

/** Mirrors `NOT_ON_SERVER_YET` in src-tauri/src/client_mode.rs. */
export const NOT_ON_SERVER_YET = "not-on-server-yet";

const text = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, "");

/** True when the request failed only because the server predates the feature. */
export function notOnServerYet(error: unknown): boolean {
  if ((error as { notOnServerYet?: boolean } | null)?.notOnServerYet === true) return true;
  const message = text(error);
  return message === NOT_ON_SERVER_YET || /^method not allowed$/i.test(message.trim());
}

/** The error to show for `feature` (a short noun phrase, e.g. "Readable
 *  links") when the server doesn't offer it yet; otherwise the original. */
export function serverFeatureError(error: unknown, feature: string): Error {
  if (notOnServerYet(error)) {
    // Still recognisable after wrapping, so a surface can say it quietly
    // instead of as a failure.
    return Object.assign(
      Error(`${feature}: not available on Canopy's server yet. It starts working once the server is updated; nothing on your side needs to change.`),
      { notOnServerYet: true },
    );
  }
  return error instanceof Error ? error : Error(text(error));
}

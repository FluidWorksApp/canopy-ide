import { acpEnabledFor } from "./projects";

/** Which kind of transport minted a CLI session id. A vendor runner takes the
 *  id Canopy generated; an ACP agent mints its own at session/new. The two are
 *  not interchangeable: feeding a Canopy-made id to session/resume (or an ACP
 *  id to `--resume`) fails or silently starts something else. */
export type SessionOrigin = "acp" | "vendor";

/** The origin a launch of this agent would produce right now. */
export function sessionOriginOf(cliId: string): SessionOrigin {
  return acpEnabledFor(cliId) ? "acp" : "vendor";
}

/** Whether a stored id can be resumed by the transport this agent will use
 *  now. No recorded origin means no id worth resuming. */
export function canResumeSession(origin: SessionOrigin | null, cliId: string): boolean {
  return origin !== null && origin === sessionOriginOf(cliId);
}

// The companion, projected for the portal.
//
// The transcript lives in this frontend (companionSession.ts) and nowhere
// else — Rust holds only the child process — so the desktop must push what the
// portal shows, exactly the way it pushes the theme. The projection is capped:
// a snapshot rides the portal's four-second refresh to a phone, so it carries
// the conversation's tail, not its history.

import { companionState } from "./companionSession";
import type { RemoteCompanion } from "../shared/model";

/** Messages kept in the push. The tail identifies the conversation; anything
 *  older belongs on the desktop. */
export const REMOTE_COMPANION_MESSAGES = 40;
/** Per-message text cap, so one pasted log cannot bloat every snapshot. */
export const REMOTE_COMPANION_TEXT = 4000;

export function remoteCompanionSnapshot(): RemoteCompanion {
  const s = companionState();
  return {
    status: s.status,
    cliName: s.cliName,
    generation: s.generation,
    error: s.error,
    messages: s.messages.slice(-REMOTE_COMPANION_MESSAGES).map((m) => ({
      who: m.who,
      text: m.text.length > REMOTE_COMPANION_TEXT ? `${m.text.slice(0, REMOTE_COMPANION_TEXT)}…` : m.text,
      ...(m.failed ? { failed: true } : {}),
      ...(m.tools?.length ? { tools: m.tools.map((t) => t.name) } : {}),
    })),
  };
}

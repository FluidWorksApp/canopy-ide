// Opening a session document from anywhere: the agent tab, the past-sessions
// list, a handoff card in team chat. One host (SessionDocHost, mounted by App)
// listens, the same way the share dialog does, so no entry point needs a new
// tab type or a prop threaded through ProjectView.

import type { SessionDigest } from "../ipc";
import type { RepoRef } from "../teamMessaging/cardSchema";

export type SessionDocRequest =
  | {
      kind: "session";
      sessionId: string;
      /** Agent registry id the session ran on. */
      agent: string;
      cwd: string;
      /** The git checkout the agent's cwd resolved to, when known. */
      repo?: string | null;
      digest?: SessionDigest;
      /** A terminal is running it right now. */
      live?: boolean;
      /** Bring the original conversation back with the CLI's own resume —
       *  only where the caller can (the past-sessions list). */
      onResume?: () => void;
      /** The command that resume runs, shown in the packet. */
      resumeCommand?: string | null;
    }
  | {
      kind: "received";
      title: string;
      agent: string;
      session: string;
      /** Packet markdown, untrusted: shown as plain text. */
      packet: string;
      from?: string;
      dir?: string;
      repo?: RepoRef;
    };

export const OPEN_SESSION_DOC_EVENT = "canopy:open-session-doc";

export function openSessionDoc(request: SessionDocRequest): void {
  window.dispatchEvent(new CustomEvent<SessionDocRequest>(OPEN_SESSION_DOC_EVENT, { detail: request }));
}

// The one door for "the user named this session".
//
// There are three surfaces a user can rename from — the inline tab rename, a
// split pane's header, and the editor on the Agents page — and they used to
// reach `ipc.ptySetName` independently. Two of them then recorded the choice on
// the tab and the third did not, because the third has no tab: it addresses a
// session by pty id. That asymmetry is what made a rename from the Agents page
// invisible to everything that had to know a name was the user's, so the next
// prompt relabelled the tab.
//
// So the rename is a function rather than a call site. It performs the native
// mutation and announces the outcome, and whoever owns tab state records it —
// once, in one slot, no matter which surface asked.
//
// tabNameGuard.test.ts holds the line: nothing outside this module may call
// ptySetName.

import * as ipc from "./ipc";

/** `requested` is what the user typed; `accepted` is what native settled on.
 *  They differ when the user clears the field — native answers with the
 *  generated label, and a listener must record that as "no name of mine"
 *  rather than adopting the fallback as a choice. */
export type SessionRenameListener = (rename: {
  ptyId: number;
  accepted: string;
  requested: string;
  /** True when the user emptied the field: undo the rename, don't store one. */
  cleared: boolean;
}) => void;

const listeners = new Set<SessionRenameListener>();

/** Subscribe to user renames. Returns the unsubscribe. */
export function onSessionRenamed(fn: SessionRenameListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Rename a live session on the user's behalf.
 *
 * Native is the authority on whether the name is allowed (length, control
 * characters, collision with another live session) and on its accepted
 * spelling; it rejects by throwing, which callers surface as they see fit.
 */
export async function renameSession(ptyId: number, requested: string): Promise<string> {
  const accepted = await ipc.ptySetName(ptyId, requested);
  const rename = {
    ptyId,
    accepted,
    requested,
    cleared: requested.trim().length === 0,
  };
  for (const fn of [...listeners]) fn(rename);
  return accepted;
}

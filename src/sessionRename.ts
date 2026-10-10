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
  /** Restore/native acknowledgements may update routing, never user intent. */
  source: "intent" | "confirmed" | "restore";
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
const pending = new Map<number, Promise<unknown>>();
const choices = new Map<number, { requested: string; revision: number }>();
function announce(rename: Parameters<SessionRenameListener>[0]) {
  for (const fn of [...listeners]) fn(rename);
}

/** User intent is applied before IPC. Serialize native writes, and fence old
 * acknowledgements so restoring an older label cannot undo a newer rename. */
export function renameSession(
  ptyId: number,
  requested: string,
): Promise<string> {
  const revision = (choices.get(ptyId)?.revision ?? 0) + 1;
  choices.set(ptyId, { requested, revision });
  announce({
    ptyId,
    accepted: requested.trim(),
    requested,
    cleared: !requested.trim(),
    source: "intent",
  });
  return synchronize(ptyId, requested, revision, false);
}

/** Reassert a saved user name on a replacement PTY without manufacturing a
 * new user edit. In particular, its late reply may never change a tab label. */
export function reassertSessionName(
  ptyId: number,
  requested: string,
): Promise<string> {
  return synchronize(ptyId, requested, choices.get(ptyId)?.revision ?? 0, true);
}

function synchronize(
  ptyId: number,
  requested: string,
  revision: number,
  restore: boolean,
): Promise<string> {
  const operation = (pending.get(ptyId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const current = choices.get(ptyId);
      if (current && current.revision !== revision)
        return current.requested.trim();
      try {
        const accepted = await ipc.ptySetName(
          ptyId,
          current?.requested ?? requested,
        );
        const latest = choices.get(ptyId);
        if (latest && latest.revision !== revision)
          return latest.requested.trim();
        announce({
          ptyId,
          accepted,
          requested: latest?.requested ?? requested,
          cleared: !(latest?.requested ?? requested).trim(),
          source: restore ? "restore" : "confirmed",
        });
        // Native's routing label is not the authority over the user's tab text.
        return (latest?.requested ?? requested).trim() || accepted;
      } catch (error) {
        const latest = choices.get(ptyId);
        if (latest && latest.revision !== revision)
          return latest.requested.trim();
        throw error;
      }
    });
  pending.set(ptyId, operation);
  void operation
    .finally(() => {
      if (pending.get(ptyId) === operation) pending.delete(ptyId);
    })
    .catch(() => {});
  return operation;
}

// The app's half of a note reminder.
//
// launchd is the alarm that matters — it fires with Canopy closed, which is
// the case anyone sets a reminder for (src-tauri/src/remind.rs). This hook is
// the other two jobs, both of which only the running app can do:
//
//   1. Put the reminder in the attention channel, so it is in the notification
//      list and on the rail rather than being a banner that vanished. The item
//      carries `osHandled` when launchd already posted the banner, which is
//      what stops one reminder arriving twice.
//
//   2. Be the alarm at all on a platform where nothing scheduled it — Windows,
//      Linux, or a Mac where launchctl refused the job. `system: false` on the
//      reminder is the store's record of that, and this is the only path that
//      reaches the OS for those.
//
// Polling, not a timer per reminder. A timer would have to be re-armed on every
// note write, cancelled on delete, and survive the note being edited in another
// window — three ways to leak an alarm, in exchange for a precision nobody
// asked for. A minute's granularity is what a reminder means; the store is a
// few hundred small files and the query is one pass over them.

import { useEffect } from "react";
import * as ipc from "./ipc";
import { postAttention } from "./attention";
import { NOTES_EVENT } from "./notes";
import { announcement, nowSecs, shouldAnnounce } from "./reminders";

/** How often the store is asked. A reminder set for 09:00 arrives between
 *  09:00 and 09:01, which is what "at nine" means to a person. */
const EVERY_MS = 30_000;

/** Reminders that came due while the app was closed are announced on the next
 *  launch — but only for a while. Something a week overdue is not news, and a
 *  stack of them at startup is a wall of banners for things you already know
 *  about. Past this they are silent: the note is still visibly overdue in the
 *  panel, which is the honest place for it. */
const STALE_SECS = 12 * 60 * 60;

/**
 * @param projectName Names the project on the banner — a reminder read from
 *   another Space has nothing else to say which codebase it is about.
 */
export function useNoteReminders(
  projectName: (projectId: string) => string | undefined,
): void {
  useEffect(() => {
    let stopped = false;

    const sweep = async () => {
      const now = nowSecs();
      // The store marks them fired as it returns them, so a reminder cannot be
      // announced twice even if two windows sweep in the same second.
      const due = await ipc.notesDue(now).catch(() => []);
      if (stopped) return;
      for (const item of due) {
        const { title, body } = announcement(item);
        postAttention({
          kind: "fyi",
          // `warn`, not `info`: a reminder is not a success message, and the
          // tone is what the rail and the mascot read to decide it is worth
          // looking at. It stays an FYI rather than a question — nothing is
          // blocked on answering it.
          tone: "warn",
          title,
          body,
          source: "reminder",
          projectId: item.project_id,
          projectName: projectName(item.project_id),
          where: { kind: "note", noteId: item.id, projectId: item.project_id },
          // Both halves of the rule in one line: the system already showed it,
          // or it is too old to be worth a banner now.
          osHandled: !shouldAnnounce(item) || now - item.at > STALE_SECS,
          // The note, not the posting. A reminder re-set on the same note
          // replaces its item rather than stacking a second one.
          dedupeKey: `reminder:${item.project_id}:${item.id}`,
        });
      }
      if (due.length) window.dispatchEvent(new CustomEvent(NOTES_EVENT));
    };

    void sweep();
    const timer = window.setInterval(() => void sweep(), EVERY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [projectName]);
}

// A live shared buffer someone else owns. The model behind it is detached —
// a `canopy-collab:` URI, no path, no way to save — which is the whole reason
// a hostile peer can't use live editing to touch your disk. See
// docs/collab-editing.md §5.
import { useEffect, useReducer, useRef } from "react";
import type { GuestSession } from "../collab";
import type { Notify } from "../types";
import { MonacoEditor } from "./MonacoEditor";

interface CollabViewProps {
  session: GuestSession;
  ownerName: string;
  onNotice: Notify;
}

/** Presence is fire-and-forget, so a caret dragged across a file must not put
 *  a frame on the wire per pixel. Dropped, never queued — the next one is 50ms
 *  away and nobody misses a cursor position that was never true. */
const CURSOR_EVERY_MS = 50;

export function CollabView({ session, ownerName, onNotice }: CollabViewProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const lastCursor = useRef(0);

  useEffect(() => {
    session.onNotice = (text) => onNotice(text, "warn");
    session.onOrphaned = () => bump();
    return () => {
      session.onNotice = null;
      session.onOrphaned = null;
    };
  }, [session, onNotice]);

  return (
    <div className="fill collab-view">
      <div className={`collab-banner ${session.orphaned ? "collab-banner-orphaned" : ""}`}>
        {session.orphaned
          ? `${ownerName} left — this copy is yours alone now and isn't saved anywhere. Copy it out if you want to keep it.`
          : `Live — ${ownerName}'s file. Edits go to them; only they can save it.`}
      </div>
      <div className="collab-editor">
        <MonacoEditor
          model={session.model}
          // There is deliberately nowhere for this to write. A guest's copy is
          // not a file, and Cmd-S says so rather than silently doing nothing.
          onSave={() =>
            onNotice(
              `${ownerName} owns this file — ask them to save, or copy the text out.`,
              "warn",
            )
          }
          onDirty={() => {}}
          onCursor={(anchor, head) => {
            const now = Date.now();
            if (now - lastCursor.current < CURSOR_EVERY_MS) return;
            lastCursor.current = now;
            session.sendCursor(anchor, head);
          }}
        />
      </div>
    </div>
  );
}

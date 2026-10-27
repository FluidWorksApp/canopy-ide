// The owner's controls for a live session: who is watching (and Remove), what
// they asked to tell the agent (Send, Edit, Decline), whether they may talk to
// the agent directly, and ending it. Shown in the session document and, while
// anyone is watching or waiting, in the corner of the window (LiveRoomsHost).
import { useState } from "react";
import { Button } from "../components/ui";
import { endLiveRoom, liveRooms, useLiveRooms } from "./live";
import type { LiveRequest, LiveRooms, Room } from "./rooms";
import "./liveSession.css";

/** "Ana wants to tell the agent: …  [Send] [Edit] [Decline]" */
export function LiveRequestCard({ room, request, rooms = liveRooms }: { room: Room; request: LiveRequest; rooms?: LiveRooms }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(request.text);
  const [busy, setBusy] = useState(false);
  const send = async (edited?: string) => {
    setBusy(true);
    await rooms.approve(room.id, request.id, edited);
    setBusy(false);
  };
  return (
    <div className="live-request" role="group" aria-label={`${request.name}'s message for the agent`}>
      <div className="live-request-head">
        <strong>{request.name}</strong> wants to tell the agent:
      </div>
      {editing ? (
        <textarea
          className="live-textarea"
          aria-label="Message for the agent"
          value={text}
          rows={3}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <blockquote className="live-quote">{request.text}</blockquote>
      )}
      <div className="live-actions">
        {editing ? (
          <>
            <Button size="sm" variant="accent" disabled={busy || !text.trim()} onClick={() => void send(text)}>
              Send edited
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="accent" disabled={busy} onClick={() => void send()}>
              {busy ? "Sending…" : "Send"}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => rooms.decline(room.id, request.id)}>
              Decline
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function LiveRoomControls({
  room,
  rooms = liveRooms,
  onInvite,
  onEnd,
}: {
  room: Room;
  rooms?: LiveRooms;
  onInvite?: () => void;
  /** Ends the room; the caller also stops sharing a terminal it showed. */
  onEnd?: () => void;
}) {
  return (
    <div className="live-controls">
      <div className="live-watchers" aria-label="Watching">
        {room.viewers.length === 0 ? (
          <span className="live-muted">
            {room.audiences.length || room.terminal ? "Nobody is watching yet." : "Not shared with anyone yet — invite teammates to join."}
          </span>
        ) : (
          room.viewers.map((v) => (
            <span key={`${v.team}:${v.id}`} className="live-person">
              <span className="live-dot" aria-hidden="true" />
              {v.name}
              <button
                type="button"
                className="live-kick"
                aria-label={`Remove ${v.name}`}
                title={`Remove ${v.name} from this session`}
                onClick={() => rooms.kick(room.id, v.team, v.id)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <label className="live-toggle">
        <input type="checkbox" checked={room.direct} onChange={(e) => rooms.setDirect(room.id, e.target.checked)} />
        Teammates can talk to the agent directly
        <small className="live-muted">{room.direct ? " Their messages go straight in." : " You approve each message first."}</small>
      </label>
      {room.requests.map((q) => (
        <LiveRequestCard key={q.id} room={room} request={q} rooms={rooms} />
      ))}
      {room.notice && (
        <p className="live-notice" role="status">
          {room.notice}
        </p>
      )}
      <div className="live-actions">
        {onInvite && (
          <Button size="sm" onClick={onInvite}>
            Invite to join…
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => (onEnd ? onEnd() : rooms === liveRooms ? void endLiveRoom(room.id) : rooms.close(room.id))}>
          End live session
        </Button>
      </div>
    </div>
  );
}

/** The live sessions this window holds open, in the corner of the window
 *  while anyone watches or waits on an answer. Mounted once by App. */
export function LiveRoomsHost({ rooms = liveRooms }: { rooms?: LiveRooms }) {
  const list = useLiveRooms(rooms).filter((r) => r.viewers.length || r.requests.length);
  const [open, setOpen] = useState<string | null>(null);
  if (!list.length) return null;
  return (
    <aside className="live-host" aria-label="Live sessions">
      {list.map((r) => (
        <section key={r.id} className="live-host-room">
          <button type="button" className="live-host-head" aria-expanded={open === r.id} onClick={() => setOpen((o) => (o === r.id ? null : r.id))}>
            <span className="live-dot" aria-hidden="true" />
            <span className="live-host-title">{r.title}</span>
            <span className="live-muted">
              {r.viewers.length} watching{r.requests.length ? ` · ${r.requests.length} waiting` : ""}
            </span>
          </button>
          {open === r.id ? (
            <LiveRoomControls room={r} rooms={rooms} />
          ) : (
            r.requests.map((q) => <LiveRequestCard key={q.id} room={r} request={q} rooms={rooms} />)
          )}
        </section>
      ))}
    </aside>
  );
}

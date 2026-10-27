// "Let teammates join…" in a running session's document: open the session to
// teammates (a live-session card in team chat), then manage who watches and
// what they ask the agent. In a cloud workspace the owner can also show the
// agent's terminal to the people who join.
import { useState } from "react";
import { Button } from "../components/ui";
import { activeWorkspace } from "../remoteExecution/workspace";
import type { LiveTurn } from "../teamMessaging/liveEvents";
import { endLiveRoom, inviteToRoom, liveRooms, shareTerminal, stopSharingTerminal, useLiveRooms, workspaceProject } from "./live";
import { LiveRoomControls } from "./LiveRoomControls";
import type { Deliver, Room } from "./rooms";
import "./liveSession.css";

export function LiveRoomPanel({
  sessionId,
  title,
  agent,
  cwd,
  repo,
  ptyId,
  turns,
  deliver,
}: {
  sessionId: string;
  title: string;
  agent: string;
  cwd: string;
  repo?: string | null;
  ptyId?: number;
  turns: () => LiveTurn[];
  deliver?: Deliver;
}) {
  const room = useLiveRooms().find((r) => r.sessionId === sessionId);
  const cloud = !!activeWorkspace();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = () => {
    if (!deliver) return;
    const r = liveRooms.open({ sessionId, title, agent, turns: turns(), deliver });
    inviteToRoom(r, cwd, repo);
  };
  const show = async (r: Room) => {
    if (ptyId == null) return;
    setBusy(true);
    setError("");
    try {
      const shared = await shareTerminal({ room: r.id, ptyId, cwd, title: r.title });
      liveRooms.setTerminal(r.id, { workspace: shared.workspace, publication: shared.publication }, shared.team);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const hide = async (r: Room) => {
    const publication = r.terminal?.publication;
    liveRooms.setTerminal(r.id, undefined);
    if (publication) await stopSharingTerminal(publication).catch(() => {});
  };
  return (
    <section className="live-panel" aria-label="Live with teammates">
      <h3>
        {room && <span className="live-dot is-live" aria-hidden="true" />} Live with teammates
      </h3>
      {!room ? (
        <>
          <p className="sdoc-note">
            Let teammates join while it runs: they see each turn as it happens, who else is watching, and can ask you
            to pass a message to the agent. They see this session's recent prompts and the agent's replies.
          </p>
          <div className="sdoc-actions">
            <Button size="sm" disabled={!deliver} onClick={open} title={deliver ? undefined : "Open this from the agent's tab to let teammates join"}>
              Let teammates join…
            </Button>
          </div>
        </>
      ) : (
        <>
          <LiveRoomControls room={room} onInvite={() => inviteToRoom(room, cwd, repo)} onEnd={() => void endLiveRoom(room.id)} />
          {cloud && ptyId != null && workspaceProject(cwd) && (
            <div className="live-actions">
              {room.terminal ? (
                <Button size="sm" variant="ghost" onClick={() => void hide(room)}>
                  Stop showing the terminal
                </Button>
              ) : (
                <>
                  <label className="live-toggle">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    Nothing private on screen
                  </label>
                  <Button size="sm" disabled={!ack || busy} onClick={() => void show(room)}>
                    {busy ? "Sharing…" : "Show the agent's terminal to people who join"}
                  </Button>
                  <small className="live-muted">
                    View only, through this workspace's Shared sessions: members with access to this project can see it
                    there, including earlier output, until you stop or it expires after an hour.
                  </small>
                </>
              )}
            </div>
          )}
          {error && (
            <p className="sdoc-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

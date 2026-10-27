// Watching a teammate's running agent session: who else is here, the turns
// as they happen, the agent's terminal where a cloud workspace shares it, and
// a box to ask the owner to pass something to the agent.
//
// Everything shown came from another device and is plain text. The owner's
// Canopy decides who may watch; this view only leaves when told to.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui";
import { useEscape } from "../useEscape";
import { RemoteTerminal } from "../remoteExecution/RemoteTerminal";
import { sharedSessionClient } from "../remoteExecution/sharedSessionClient";
import type { RemoteExecutionClient } from "../remoteExecution/client";
import { liveTeamSessions } from "../teamMessaging/session";
import type { LiveJoin } from "../sessionDoc/events";
import type { LiveTerminal } from "../teamMessaging/liveEvents";
import type { GuestRequest, GuestStatus, LiveGuest } from "./guest";
import { joinLive } from "./live";
import "./liveSession.css";

const clock = (ms: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

function statusLine(status: GuestStatus, owner: string): string | null {
  switch (status) {
    case "connecting":
      return `Joining ${owner}'s session…`;
    case "live":
      return null;
    case "quiet":
      return `${owner}'s Canopy stopped answering — it may be closed or offline. This picks up again when it answers.`;
    case "unreachable":
      return `Couldn't reach ${owner}'s Canopy. They need Canopy 0.5 or later open to let you watch.`;
    case "ended":
      return "This live session has ended.";
    case "removed":
      return `${owner} removed you from this session.`;
    case "not-allowed":
      return "This session isn't shared with you.";
  }
}

function requestLine(r: GuestRequest, owner: string, direct: boolean): string {
  switch (r.state) {
    case "waiting":
      return direct ? "Sending…" : `Waiting for ${owner}`;
    case "sent":
      return r.sentAs ? `${owner} edited it and gave it to the agent` : "Given to the agent";
    case "declined":
      return `${owner} didn't pass this on`;
    case "failed":
      return "Couldn't be delivered";
  }
}

/** The agent's terminal, read-only, through the workspace's Shared sessions
 *  (it checks this account's access on every connection). */
function SharedTerminal({ terminal }: { terminal: LiveTerminal }) {
  const [client, setClient] = useState<RemoteExecutionClient | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setClient(null);
    setError("");
    sharedSessionClient(terminal.workspace, () => live)
      .then((c) => live && setClient(c))
      .catch(() => live && setError("You can't see this workspace's shared terminals — ask the owner for access to its project."));
    return () => {
      live = false;
    };
  }, [terminal.workspace, terminal.publication]);
  if (error) return <p className="live-muted">{error}</p>;
  if (!client) return <p className="live-muted">Connecting to the terminal…</p>;
  return (
    <div className="live-terminal">
      <RemoteTerminal client={client} workspaceId={terminal.workspace} sessionId={0} sharedSessionId={terminal.publication} writable={false} />
    </div>
  );
}

export function LiveSessionView({
  join,
  onClose,
  start = joinLive,
  names,
}: {
  join: LiveJoin;
  onClose: () => void;
  /** Test seam: the joiner client. */
  start?: (join: LiveJoin) => LiveGuest;
  /** Test seam: account id → name. */
  names?: (id: string) => string | undefined;
}) {
  useEscape(onClose);
  const guest = useMemo(() => start(join), [join, start]);
  useEffect(() => {
    guest.start();
    return () => guest.stop();
  }, [guest]);
  const snap = useSyncExternalStore(guest.subscribe, guest.getSnapshot);
  const owner = join.ownerName || "The owner";
  const me = liveTeamSessions().find((s) => s.team === join.team)?.user;
  const nameOf = (id: string) =>
    id === me ? "You" : (names?.(id) ?? liveTeamSessions().find((s) => s.team === join.team)?.members()[id] ?? "A teammate");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const closed = snap.status === "ended" || snap.status === "removed" || snap.status === "not-allowed";
  const line = statusLine(snap.status, owner);
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => end.current?.scrollIntoView?.({ block: "nearest" }), [snap.turns.length]);

  const send = async () => {
    setSending(true);
    setError("");
    try {
      await guest.say(draft);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sdoc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <article className="sdoc live-view" role="dialog" aria-modal="true" aria-label="Live session">
        <header className="sdoc-head">
          <div className="sdoc-head-main">
            <h2>
              {!closed && snap.status === "live" && <span className="live-dot is-live" aria-hidden="true" />} {snap.title}
            </h2>
            <div className="sdoc-meta">
              <span>{owner}'s {snap.agent} session</span>
              <span>{closed ? "closed" : snap.status === "live" ? "live" : "joining"}</span>
            </div>
          </div>
          <div className="sdoc-head-actions">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Leave
            </Button>
          </div>
        </header>
        <div className="sdoc-body">
          {line && (
            <p className={closed ? "sdoc-error" : "sdoc-state"} role="status">
              {line}
            </p>
          )}
          <section aria-label="Watching">
            <h3>Watching</h3>
            <div className="live-watchers">
              <span className="live-person">
                <span className="live-dot is-live" aria-hidden="true" />
                {owner} <small className="live-muted">(owner)</small>
              </span>
              {snap.viewers.map((id) => (
                <span key={id} className="live-person">
                  <span className="live-dot" aria-hidden="true" />
                  {nameOf(id)}
                </span>
              ))}
            </div>
          </section>
          {snap.terminal && !closed && (
            <section aria-label="Terminal">
              <h3>The agent's terminal</h3>
              <SharedTerminal terminal={snap.terminal} />
            </section>
          )}
          <section aria-label="Transcript">
            <h3>
              Turns <span className="badge">{snap.turns.length}</span>
            </h3>
            {snap.turns.length === 0 ? (
              <p className="sdoc-empty">{snap.status === "live" ? "Nothing yet — turns appear here as the agent works." : "…"}</p>
            ) : (
              <ol className="sdoc-turns" aria-live="polite">
                {snap.turns.map((t) => (
                  <li key={t.id} className={`sdoc-turn live-turn is-${t.kind}`}>
                    <div className="sdoc-turn-head">
                      <span className="sdoc-turn-n">{t.kind === "prompt" ? `${t.by ?? owner} asked` : `${snap.agent} answered`}</span>
                      <span className="sdoc-turn-when">{clock(t.at)}</span>
                    </div>
                    <p className="live-turn-text">{t.text}</p>
                    {t.files?.length ? (
                      <div className="sdoc-chips" aria-label="Files changed">
                        {t.files.map((f) => (
                          <span key={f} className="sdoc-chip" title={f}>
                            {f}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
                <li ref={end} aria-hidden="true" className="live-end" />
              </ol>
            )}
          </section>
          <section aria-label="Message the agent">
            <h3>Message the agent</h3>
            <p className="sdoc-note">
              {snap.direct
                ? `${owner} lets teammates talk to the agent directly: your message goes straight in, under your name.`
                : `${owner} sees your message first and chooses to send, edit or decline it.`}
            </p>
            <textarea
              className="live-textarea"
              aria-label="Message for the agent"
              rows={3}
              maxLength={4000}
              value={draft}
              disabled={closed}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !sending) void send();
              }}
              placeholder={snap.direct ? "Tell the agent…" : `Ask ${owner} to tell the agent…`}
            />
            <div className="live-actions">
              <Button size="sm" variant="accent" disabled={closed || sending || !draft.trim()} onClick={() => void send()}>
                {snap.direct ? "Send to the agent" : `Ask ${owner}`}
              </Button>
            </div>
            {error && (
              <p className="sdoc-error" role="alert">
                {error}
              </p>
            )}
            {snap.requests.length > 0 && (
              <ul className="live-requests">
                {snap.requests.map((r) => (
                  <li key={r.id}>
                    <span className="live-request-text">{r.sentAs ?? r.text}</span>
                    <small className={`live-muted is-${r.state}`}>{requestLine(r, owner, snap.direct)}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </article>
    </div>
  );
}

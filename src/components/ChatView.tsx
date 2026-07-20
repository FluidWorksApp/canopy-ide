// A relay conversation opened as a tab: the team channel (peer null) or a
// direct message with one member. The transcript lives in App (the relay is
// app-wide); this view filters it down to the one conversation and sends
// through the same handle, so every open project shows the same chat.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Notify, RelayHandle } from "../types";
import { TeamIcon } from "./icons";
import { offerFileTo } from "./TeamPanel";

interface ChatViewProps {
  /** Member id for a DM; null for the everyone channel. */
  peer: string | null;
  title: string;
  relay: RelayHandle;
  onNotice: Notify;
}

const timeOf = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function ChatView({ peer, title, relay, onNotice }: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const selfId = relay.status.self_id;

  const messages = useMemo(
    () =>
      relay.chat.filter((m) =>
        peer === null
          ? m.to === null
          : (m.from === peer && m.to === selfId) || (m.from === selfId && m.to === peer),
      ),
    [relay.chat, peer, selfId],
  );

  // Keep the newest message in view — a chat that doesn't follow itself is
  // a scrollback viewer, not a conversation.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const offline = relay.status.role === "off";
  const peerGone =
    peer !== null && !relay.status.members.some((m) => m.id === peer);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await relay.sendChat(peer, text);
      setDraft("");
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-head">
        <TeamIcon size={14} />
        <span className="chat-title">{title}</span>
        {peer === null && <span className="chat-scope">everyone on the relay</span>}
        {peerGone && !offline && <span className="chat-gone">left the relay</span>}
        {offline && <span className="chat-gone">relay is off</span>}
      </div>
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-empty">
            {peer === null
              ? "Nothing yet — say something to the whole team."
              : "No messages yet — say hi."}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.from === selfId ? "chat-msg-own" : ""}`}>
            <div className="chat-msg-meta">
              <span className="chat-msg-from">{m.from === selfId ? "you" : m.from_name}</span>
              <span className="chat-msg-time">{timeOf(m.ts)}</span>
            </div>
            <div className="chat-msg-text">{m.text}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="chat-compose">
        {peer !== null && (
          <button
            className="btn"
            title={`Send ${title} a file — direct, peer-to-peer`}
            disabled={offline || peerGone}
            onClick={() => void offerFileTo(peer, title, onNotice)}
          >
            ⌁ File
          </button>
        )}
        <input
          className="chat-input"
          placeholder={
            offline
              ? "Relay is off"
              : peerGone
                ? "They left — messages can't be delivered"
                : `Message ${peer === null ? "everyone" : title}…`
          }
          disabled={offline || peerGone || busy}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="btn btn-accent"
          disabled={offline || peerGone || busy || !draft.trim()}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

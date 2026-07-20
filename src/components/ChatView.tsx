// A relay conversation opened as a tab: the team channel (peer null) or a
// direct message with one member. The transcript lives in App (the relay is
// app-wide); this view filters it down to the one conversation and sends
// through the same handle, so every open project shows the same chat.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
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
  const [dropActive, setDropActive] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selfId = relay.status.self_id;
  const offline = relay.status.role === "off";
  const peerGone =
    peer !== null && !relay.status.members.some((m) => m.id === peer);
  const canDrop = peer !== null && !offline && !peerGone;

  // Drag-and-drop a file onto a DM to send it. Tauri's drag-drop is a
  // window-level event, so we gate on whether the drop landed inside THIS
  // chat's rectangle — a hidden tab has an empty rect and so never reacts,
  // which is exactly the filter we want across several open chats.
  const canDropRef = useRef(canDrop);
  canDropRef.current = canDrop;
  const peerRef = useRef(peer);
  peerRef.current = peer;
  useEffect(() => {
    if (peer === null) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const inside = (x: number, y: number) => {
      const r = rootRef.current?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cx = x / dpr;
      const cy = y / dpr;
      return !!r && r.width > 0 && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "over") {
            setDropActive(canDropRef.current && inside(p.position.x, p.position.y));
          } else if (p.type === "leave") {
            setDropActive(false);
          } else if (p.type === "drop") {
            setDropActive(false);
            if (!canDropRef.current || !peerRef.current) return;
            if (!inside(p.position.x, p.position.y)) return;
            const path = p.paths[0];
            if (!path) return;
            void ipc
              .relayOfferFile(peerRef.current, path)
              .then(() =>
                onNotice(`Offered ${path.split("/").pop()} to ${title} — sends when they accept.`, "success"),
              )
              .catch((err) => onNotice(String(err), "error"));
          }
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [peer, title, onNotice]);

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
    <div className="chat-view" ref={rootRef}>
      {dropActive && (
        <div className="chat-drop-overlay">Drop to send {title} this file</div>
      )}
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
            className="chat-attach"
            title={`Attach a file for ${title} — sent direct, peer-to-peer`}
            aria-label="Attach a file"
            disabled={offline || peerGone}
            onClick={() => void offerFileTo(peer, title, onNotice)}
          >
            📎
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

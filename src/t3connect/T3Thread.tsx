// One agent thread on a T3 Code machine: what was said, what it is doing now,
// a box to say more, and Stop. It reads the whole projection again whenever the
// thread's stream says something happened, rather than interpreting T3's domain
// events, so a new event kind can never leave the view wrong, only a moment late.
// Questions the agent asks (approvals, input requests) are answered in T3 Code;
// the status says when one is waiting.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { T3_METHODS, type ThreadProjection } from "./contracts";
import { t3, threadStatus } from "./methods";
import type { T3RpcClient } from "./rpc";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATUS_TEXT = {
  working: "Working…",
  waiting: "Waiting for you: answer it in T3 Code",
  idle: "Done",
  failed: "The last run failed",
} as const;

export function T3Thread({ rpc, threadId, canOperate, onTitle }: {
  rpc: T3RpcClient;
  threadId: string;
  /** The machine granted orchestration:operate. */
  canOperate: boolean;
  onTitle?: (title: string) => void;
}) {
  const [projection, setProjection] = useState<ThreadProjection | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let again = false;
    const refresh = () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      t3.getThreadProjection(rpc, threadId).then(next => {
        if (cancelled) return;
        setProjection(next);
        setError("");
        titleRef.current?.(next.thread.title);
      }, reason => { if (!cancelled) setError(message(reason)); }).finally(() => {
        inFlight = false;
        if (again && !cancelled) { again = false; refresh(); }
      });
    };
    refresh();
    // Output streams in quickly; one read per beat is plenty to follow it.
    const handle = rpc.stream<unknown>(T3_METHODS.subscribeThread, { threadId }, () => {
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; refresh(); }, 250);
    });
    handle.done.catch(reason => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; if (timer) clearTimeout(timer); handle.cancel(); };
  }, [rpc, threadId]);

  const count = projection?.messages.length ?? 0;
  const last = projection?.messages[count - 1]?.text.length ?? 0;
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [count, last]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setError("");
    try {
      await t3.dispatchCommand(rpc, {
        type: "message.dispatch", commandId: crypto.randomUUID(), threadId, messageId: crypto.randomUUID(),
        text, attachments: [], createdBy: "user", creationSource: "mobile", dispatchMode: { type: "queue_after_active" },
      });
      setDraft("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSending(false);
    }
  }, [rpc, threadId, draft, sending]);

  const stop = () => {
    t3.dispatchCommand(rpc, { type: "thread.stop", commandId: crypto.randomUUID(), threadId }).catch(reason => setError(message(reason)));
  };

  const status = projection ? threadStatus(projection) : null;
  return <div className="t3-thread">
    <div className="t3-thread-head">
      <span role="status">{status ? STATUS_TEXT[status] : "Loading…"}</span>
      {projection && <span className="t3-thread-meta">{projection.thread.branch ? `${projection.thread.branch} · ` : ""}{projection.thread.runtimeMode}</span>}
      <span className="t3-spacer" />
      {canOperate && status === "working" && <Button size="sm" variant="ghost" onClick={stop}>Stop</Button>}
    </div>
    <div className="t3-thread-log" ref={logRef} role="log" aria-label="Thread messages">
      {projection?.messages.filter(m => m.role !== "system" && m.text.trim()).map(m =>
        <div key={m.id} className={`t3-msg is-${m.role}`}><span className="t3-msg-who">{m.role === "user" ? "You" : "Agent"}</span><pre>{m.text}{m.streaming ? " ▍" : ""}</pre></div>)}
      {projection && projection.messages.length === 0 && <p className="t3-tree-note">Nothing said yet.</p>}
    </div>
    {error && <div className="workspace-feedback error" role="alert">{error}</div>}
    {canOperate
      ? <form className="t3-thread-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea value={draft} rows={2} placeholder={status === "working" ? "Add a message: it is queued after this run" : "Message the agent"} aria-label="Message the agent"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <Button size="sm" type="submit" disabled={!draft.trim() || sending}>{sending ? "Sending…" : "Send"}</Button>
      </form>
      : <p className="t3-tree-note">This machine did not grant orchestration:operate, so threads are read-only here. Pair it again to talk to agents.</p>}
  </div>;
}

// The companion's chat, anchored to the companion.
//
// Anchored rather than docked in a corner because the mascot is what the user
// just clicked, and a surface that opens somewhere else reads as a different
// feature. Placement (which side, how far down) is decided by `panelPlacement`
// in companion.ts and handed in — this draws, it does not measure.
//
// Deliberately not a terminal. The session behind it is an agent CLI, and the
// obvious thing would have been to show its TUI; what the user wants from a
// companion is an answer, so tool calls are a single status line and prose is
// prose.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  CompanionAttachment,
  CompanionProposal,
  CompanionState,
  CompanionTool,
} from "../companionSession";
import * as ipc from "../ipc";
import {
  companionSpotlight,
  spotlightHint,
  subscribeSpotlight,
} from "../companionContext";
import { toolDetail, toolLabel } from "../companion";
import { composerRows, insertNewlineAtCaret, isNewlineChord } from "../composer";
import { Markdown } from "./Markdown";

interface Props {
  state: CompanionState;
  /** An action the companion is waiting on an answer for. Rendered inline
   *  rather than as a dialog: it is part of the conversation, and a modal over
   *  the whole window for "shall I start the dev server" is too much ceremony
   *  for something asked several times an hour. */
  proposal: CompanionProposal | null;
  onAnswer: (accepted: boolean) => void;
  /** Take the user to where an agent CLI can be installed. */
  onInstall: () => void;
  /** Start the session again after it died. */
  onRetry: () => void;
  name: string;
  at: { left: number; top: number; side: "left" | "right" };
  width: number;
  height: number;
  /** Whether the panel is at its larger size. Owned by the host, which is what
   *  places the panel — this only draws the control that asks for it. */
  expanded: boolean;
  onToggleExpand: () => void;
  onSend: (text: string, attachments: CompanionAttachment[]) => void;
  onClose: () => void;
}

export function CompanionChat({
  state,
  name,
  at,
  width,
  height,
  proposal,
  onAnswer,
  onInstall,
  onRetry,
  expanded,
  onToggleExpand,
  onSend,
  onClose,
}: Props) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<CompanionAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachingRef = useRef(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // What the next message will be grounded in — the same spotlight the
  // envelope reads, shown so "which project does it think I'm on" is never a
  // mystery the user has to ask the companion itself.
  const spot = useSyncExternalStore(subscribeSpotlight, companionSpotlight, () => null);

  // Opening the panel puts the caret in it: this is summoned to be typed into,
  // and a click-then-click-again is the one thing a summon must not cost.
  useEffect(() => {
    input.current?.focus();
  }, []);

  // Follow the stream.
  //
  // `stick` is the user's *intent*, recorded once when they scroll, rather than
  // re-derived from the scroll position on every token. Re-deriving is the
  // obvious version and it is broken: a single streamed chunk can grow the log
  // by more than any threshold, so the check decides the user has scrolled away
  // when they have not, and the log freezes exactly where it was for the rest
  // of the answer. Programmatic scrolling keeps `stick` true because it lands
  // at the bottom; only a real scroll upward clears it.
  const stick = useRef(true);
  const onScroll = () => {
    const el = log.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  });

  const busy = state.status === "working";
  const dead = state.status === "failed" || state.status === "unavailable";
  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !busy && !dead && !attaching;

  const attach = async (files: File[]) => {
    if (files.length === 0 || attachingRef.current) return;
    attachingRef.current = true;
    setAttaching(true);
    setAttachmentError(null);
    const failed: string[] = [];
    try {
      for (const file of files) {
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.readAsDataURL(file);
          });
          if (!base64) throw new Error("the file was empty");
          const path = await ipc.companionSaveAttachment(file.name, base64);
          setAttachments((prev) => [...prev, { name: file.name, path, type: file.type }]);
        } catch (err) {
          failed.push(`${file.name}: ${String(err)}`);
          void ipc.jsLog("warn", `companion: could not attach ${file.name}: ${String(err)}`);
        }
      }
    } finally {
      attachingRef.current = false;
      setAttaching(false);
      setAttachmentError(failed.length ? failed.join("; ") : null);
      input.current?.focus();
    }
  };

  const submit = () => {
    if (!canSend) return;
    // Sending is an explicit "I want to see what comes back", so it re-arms
    // following even if they had scrolled up to re-read something.
    stick.current = true;
    onSend(draft, attachments);
    setDraft("");
    setAttachments([]);
  };

  return (
    <div
      className={`companion-panel companion-panel-${at.side}`}
      style={{ left: at.left, top: at.top, width, height }}
      role="dialog"
      aria-label={`Chat with ${name}`}
    >
      <div className="companion-head">
        <span className={`companion-dot companion-dot-${state.status}`} aria-hidden />
        <span className="companion-title">
          {name}
          {state.cliName && <span className="companion-cli"> · {state.cliName}</span>}
        </span>
        {/* Bigger, not fullscreen: the panel is still a thing hanging off the
            mascot, and a conversation you are reading properly needs room for
            the answer rather than the whole window. */}
        <button
          className="companion-grow"
          onClick={onToggleExpand}
          type="button"
          aria-label={expanded ? "Shrink the panel" : "Expand the panel"}
          aria-pressed={expanded}
          title={expanded ? "Shrink" : "Expand"}
        >
          {expanded ? "⤡" : "⤢"}
        </button>
        <button className="companion-esc" onClick={onClose} type="button" aria-label="Close">
          esc
        </button>
      </div>

      <div className="companion-log" ref={log} onScroll={onScroll}>
        {/* No agent CLI on this machine. Said here, with the fix attached,
            rather than by the companion quietly not existing. */}
        {state.status === "unavailable" && (
          <div className="companion-needs">
            <p>
              I need an agent CLI to think with — Claude Code, Codex, or any other
              Canopy knows about. None is installed yet.
            </p>
            <button className="companion-needs-cta" onClick={onInstall} type="button">
              Install one
            </button>
          </div>
        )}
        {state.status === "failed" && !state.error && (
          <div className="companion-needs">
            <p>The session stopped.</p>
            <button className="companion-needs-cta" onClick={onRetry} type="button">
              Retry
            </button>
          </div>
        )}
        {state.status !== "unavailable" && state.messages.length === 0 && (
          <p className="companion-empty">
            Ask about anything across your projects — what changed, what’s running,
            what a piece of code does.
          </p>
        )}
        {state.messages.map((m, i) => (
          <div key={m.id} className={`companion-msg companion-msg-${m.who}`}>
            <span className="companion-who">{m.who === "you" ? "you" : name.toLowerCase()}</span>
            <div className="companion-body">
              {(m.tools ?? []).length > 0 && (
                <ToolTrail
                  tools={m.tools ?? []}
                  live={busy && i === state.messages.length - 1}
                />
              )}
              {m.who === "ash" ? (
                m.text ? (
                  // The same renderer every other markdown surface uses — a
                  // second one would drift, and answers here are full of code
                  // spans and paths. `external` on purpose: this is an agent's
                  // output, not the user's own writing, so it gets no
                  // wikilinks and writes nothing.
                  <Markdown text={m.text} origin="external" />
                ) : (
                  busy && <span className="companion-caret" aria-label="Thinking" />
                )
              ) : (
                <>
                  <span className="companion-said">{m.text}</span>
                  {(m.attachments ?? []).length > 0 && (
                    <span className="companion-sent-files">
                      {(m.attachments ?? []).map((a) => (
                        <span key={a.path}>{a.name}</span>
                      ))}
                    </span>
                  )}
                </>
              )}
              {m.failed && <span className="companion-failed">{m.text}</span>}
            </div>
          </div>
        ))}
      </div>

      {proposal && (
        <div className="companion-ask" role="group" aria-label="Confirm an action">
          <div className="companion-ask-what">{proposal.action}</div>
          {/* The project is named every time. The companion acts across the
              whole workspace, so "start the dev server" without saying where
              is not a question the user can actually answer. */}
          {proposal.project && (
            <div className="companion-ask-where">
              in <strong>{proposal.project}</strong>
            </div>
          )}
          {proposal.detail && <div className="companion-ask-detail">{proposal.detail}</div>}
          <div className="companion-ask-buttons">
            <button
              className="companion-ask-yes"
              onClick={() => onAnswer(true)}
              type="button"
              autoFocus
            >
              Do it
            </button>
            <button
              className="companion-ask-no"
              onClick={() => onAnswer(false)}
              type="button"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {state.error && (
        <div className="companion-error">
          <span className="companion-error-text">{state.error}</span>
          {/* An agent that stopped is the one failure the user can actually do
              something about, and having to find the Settings toggle to turn
              the companion off and on again is not that something. */}
          <button className="companion-retry" onClick={onRetry} type="button">
            Retry
          </button>
        </div>
      )}

      {spot && !dead && (
        <div
          className="companion-sees"
          title={`${name} is told what you're looking at with each message`}
        >
          <span className="companion-sees-eye" aria-hidden>
            ◉
          </span>
          {spotlightHint(spot)}
        </div>
      )}

      <div className="companion-compose">
        <input
          id="companion-file-input"
          className="companion-file-input"
          type="file"
          multiple
          disabled={dead || busy || attaching}
          onChange={(e) => {
            void attach(Array.from(e.target.files ?? []));
            e.currentTarget.value = "";
          }}
        />
        <label
          className="companion-attach"
          htmlFor="companion-file-input"
          aria-label="Attach files"
          title="Attach images or files"
        >
          {attaching ? "…" : "+"}
        </label>
        <div className="companion-compose-body">
          {attachmentError && (
            <div className="companion-attachment-error" role="alert">
              {attachmentError}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="companion-files">
              {attachments.map((a) => (
                <span className="companion-file" key={a.path} title={a.path}>
                  {a.name}
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        <textarea
          ref={input}
          className="companion-input"
          rows={composerRows(draft, 40)}
          value={draft}
          placeholder={
            state.status === "unavailable"
              ? "No agent CLI installed"
              : state.status === "failed"
                ? "Not connected"
                : `Message ${name}…`
          }
          aria-label={`Message ${name}`}
          disabled={dead}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files ?? []);
            if (files.length === 0) return;
            e.preventDefault();
            void attach(files);
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter and Option+Enter are a newline — the
            // convention every chat the user already types in follows.
            if (isNewlineChord(e)) {
              e.preventDefault();
              setDraft(insertNewlineAtCaret(e.currentTarget));
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        </div>
        <button
          className="companion-send"
          onClick={submit}
          disabled={!canSend}
          type="button"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

/** Every tool a reply ran, on one line.
 *
 *  It used to be one chip per call, wrapped. A single ordinary question runs a
 *  dozen tools, so the answer the user actually asked for arrived under ten
 *  lines of `mcp__canopy__canopy_…` — the panel is 380px tall, and the machinery
 *  was pushing the result off the bottom of it. None of those lines was ever
 *  read; what the user wants while it works is "it is still going, and it is
 *  doing this one now", and afterwards, "it looked at some things first".
 *
 *  So: the newest call, live, with a count of what came before it. The whole
 *  list is still one click away, because "which files did it read" is a fair
 *  question — it simply is not worth the standing cost of showing it. */
function ToolTrail({ tools, live }: { tools: CompanionTool[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const head = tools[tools.length - 1];
  const before = tools.length - 1;
  const detail = toolDetail(head.detail);
  return (
    <div className={`companion-trail${open ? " companion-trail-open" : ""}`}>
      <button
        className="companion-trail-row"
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
        title={open ? "Hide the tool calls" : "Show every tool call"}
      >
        <span
          className={`companion-trail-mark${live ? " companion-trail-mark-live" : ""}`}
          aria-hidden
        >
          {live ? "◍" : "✓"}
        </span>
        <span className="companion-trail-name">{toolLabel(head.name)}</span>
        {detail && <span className="companion-trail-detail">{detail}</span>}
        {before > 0 && (
          <span
            className="companion-trail-count"
            title={`${before} more before this one`}
          >
            +{before}
          </span>
        )}
      </button>
      {open && (
        <div className="companion-trail-all">
          {tools.map((t, i) => (
            <span key={`${t.name}-${i}`} className="companion-tool" title={t.detail}>
              {toolLabel(t.name)}
              {t.detail && <span className="companion-tool-detail">{toolDetail(t.detail)}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

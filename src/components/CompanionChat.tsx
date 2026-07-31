// The companion's chat, anchored to the companion.
//
// Anchored rather than docked in a corner because the mascot is what the user
// just clicked, and a surface that opens somewhere else reads as a different
// feature. Placement (which side, how far down) is decided by `panelPlacement`
// in companion.ts and handed in — this draws, it does not measure.
//
// Deliberately not a terminal. The session behind it is an agent CLI, and the
// obvious thing would have been to show its TUI; what the user wants from a
// companion is an answer, so tool calls are chips and prose is prose.

import { useEffect, useRef, useState } from "react";
import type { CompanionProposal, CompanionState } from "../companionSession";
import { Markdown } from "./Markdown";

interface Props {
  state: CompanionState;
  /** An action the companion is waiting on an answer for. Rendered inline
   *  rather than as a dialog: it is part of the conversation, and a modal over
   *  the whole window for "shall I start the dev server" is too much ceremony
   *  for something asked several times an hour. */
  proposal: CompanionProposal | null;
  onAnswer: (accepted: boolean) => void;
  name: string;
  at: { left: number; top: number; side: "left" | "right" };
  width: number;
  height: number;
  onSend: (text: string) => void;
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
  onSend,
  onClose,
}: Props) {
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Opening the panel puts the caret in it: this is summoned to be typed into,
  // and a click-then-click-again is the one thing a summon must not cost.
  useEffect(() => {
    input.current?.focus();
  }, []);

  // Follow the stream. Only when already near the bottom, so scrolling back to
  // read something is not undone by the next token.
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [state.messages, proposal]);

  const busy = state.status === "working";
  const canSend = draft.trim().length > 0 && !busy && state.status !== "failed";

  const submit = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft("");
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
        <button className="companion-esc" onClick={onClose} type="button" aria-label="Close">
          esc
        </button>
      </div>

      <div className="companion-log" ref={log}>
        {state.messages.length === 0 && (
          <p className="companion-empty">
            Ask about anything across your projects — what changed, what’s running,
            what a piece of code does.
          </p>
        )}
        {state.messages.map((m) => (
          <div key={m.id} className={`companion-msg companion-msg-${m.who}`}>
            <span className="companion-who">{m.who === "you" ? "you" : name.toLowerCase()}</span>
            <div className="companion-body">
              {(m.tools ?? []).length > 0 && (
                <div className="companion-tools">
                  {(m.tools ?? []).map((t, i) => (
                    <span key={`${t.name}-${i}`} className="companion-tool" title={t.detail}>
                      {t.name}
                      {t.detail && <span className="companion-tool-detail">{t.detail}</span>}
                    </span>
                  ))}
                </div>
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
                <span className="companion-said">{m.text}</span>
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

      {state.error && <div className="companion-error">{state.error}</div>}

      <div className="companion-compose">
        <textarea
          ref={input}
          className="companion-input"
          rows={1}
          value={draft}
          placeholder={
            state.status === "failed" ? "Not connected" : `Message ${name}…`
          }
          aria-label={`Message ${name}`}
          disabled={state.status === "failed"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline — the convention every
            // chat the user already types in follows.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
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

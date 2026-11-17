// "Waiting on you": the questions an agent has asked that nobody has answered
// yet, on its card beside the task list (waitingOnYou.ts keeps them).
//
// Each question is drawn by the kind of answer it takes: yes or no, one of
// several, any of several, or the person's own words, with a line for their
// own words beside a choice when the question allows it. Everything filled in
// goes to the agent as ONE message, typed into its terminal as the person
// would; a question left blank simply stays on the list.
import { useState, useSyncExternalStore } from "react";
import {
  answerText,
  composeAnswers,
  dismissAsk,
  markAsksAnswered,
  openAsksFor,
  subscribeAsks,
  togglePick,
  EMPTY_DRAFT,
  type Ask,
  type Draft,
} from "../waitingOnYou";
import { AskIcon } from "./icons";

interface WaitingOnYouProps {
  sessionId: string;
  /** Whether typing to the agent is safe right now (it is working or idle). */
  canAct: boolean;
  /** Why not, when it is not. */
  actHint?: string;
  onSend: (text: string) => Promise<{ delivered: boolean; note: string }> | void;
  onNotice?: (message: string) => void;
}

const HINT: Record<Ask["type"], string> = {
  yes_no: "Yes or no",
  single: "Pick one",
  multiple: "Pick any",
  text: "In your words",
};

export function WaitingOnYou({ sessionId, canAct, actHint, onSend, onNotice }: WaitingOnYouProps) {
  const asks = useSyncExternalStore(subscribeAsks, () => openAsksFor(sessionId));
  const [open, setOpen] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sending, setSending] = useState(false);
  if (!asks.length) return null;

  const draftOf = (ask: Ask) => drafts[ask.id] ?? EMPTY_DRAFT;
  const edit = (ask: Ask, next: Draft) => setDrafts((all) => ({ ...all, [ask.id]: next }));
  const ready = asks.filter((ask) => answerText(ask, drafts[ask.id]));

  const send = async () => {
    if (!ready.length || !canAct || sending) return;
    const text = composeAnswers(ready.map((ask) => ({ ask, draft: drafts[ask.id] })));
    setSending(true);
    try {
      const result = await Promise.resolve(onSend(text));
      if (result && !result.delivered) {
        onNotice?.(result.note || "The agent did not receive that.");
        return;
      }
      markAsksAnswered(
        sessionId,
        ready.map((ask) => ask.id),
      );
      setDrafts((all) => {
        const next = { ...all };
        for (const ask of ready) delete next[ask.id];
        return next;
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="agent-card-section agent-card-asks-section">
      <button type="button" className="agent-card-row agent-card-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <AskIcon size={14} />
        <span>Waiting on you</span>
        <span className="agent-card-grow" />
        <span className="agent-card-asks-count" aria-label={`${asks.length} unanswered`}>
          {asks.length}
        </span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <>
          <ul className="agent-card-asks">
            {asks.map((ask) => {
              const draft = draftOf(ask);
              const many = ask.type === "multiple";
              return (
                <li key={ask.id} className="agent-card-ask">
                  <button
                    type="button"
                    className="agent-card-task-x"
                    title="Remove from list"
                    aria-label={`Remove ${ask.question}`}
                    onClick={() => dismissAsk(sessionId, ask.id)}
                  >
                    ×
                  </button>
                  <div className="agent-card-ask-q" id={`${ask.id}:q`}>
                    {ask.question}
                  </div>
                  <div className="agent-card-ask-kind">
                    {HINT[ask.type]}
                    {ask.freeText && ask.type !== "text" ? ", or say more" : ""}
                  </div>
                  {ask.options.length > 0 && (
                    <div className="agent-card-ask-options" role={many ? "group" : "radiogroup"} aria-labelledby={`${ask.id}:q`}>
                      {ask.options.map((option) => {
                        const on = draft.picked.includes(option);
                        return (
                          <button
                            key={option}
                            type="button"
                            role={many ? "checkbox" : "radio"}
                            aria-checked={on}
                            className={`agent-card-ask-option${on ? " is-on" : ""}`}
                            onClick={() => edit(ask, togglePick(ask, draft, option))}
                          >
                            {many && (
                              <span className="agent-card-ask-box" aria-hidden="true">
                                {on ? "✓" : ""}
                              </span>
                            )}
                            {option}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {ask.freeText && (
                    <input
                      type="text"
                      className="agent-card-ask-text"
                      value={draft.text}
                      placeholder={ask.type === "text" ? "Your answer" : ask.type === "yes_no" ? "Add a note (optional)" : "Something else, or a note"}
                      aria-label={ask.type === "text" ? `Answer: ${ask.question}` : `Note for: ${ask.question}`}
                      onChange={(e) => edit(ask, { ...draft, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <div className="agent-card-asks-foot">
            <span className="agent-card-dim">
              {ready.length ? `${ready.length} of ${asks.length} answered` : "Answer here, or reply in the terminal"}
            </span>
            <button
              type="button"
              className="agent-card-asks-send"
              disabled={!ready.length || !canAct || sending}
              title={!canAct ? actHint : ready.length ? "Type these answers to the agent" : "Fill in an answer first"}
              onClick={() => void send()}
            >
              {sending ? "Sending…" : ready.length > 1 ? `Send ${ready.length} answers` : "Send answer"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

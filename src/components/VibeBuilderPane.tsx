import { useEffect, useRef, useState } from "react";
import {
  INITIAL_PERSONA,
  reducePersona,
  type PersonaInput,
  type PersonaState,
} from "../personaBridge";
import type { StructuredRunnerEvent } from "../structuredEvents";
import { mascotDef } from "../mascots";
import { Markdown } from "./Markdown";
import { Mascot } from "./Mascot";

export interface BuilderQuestionAction {
  label: string;
  response: string;
}

export interface BuilderQuestion {
  id: string;
  kind: "question" | "confirm";
  prompt: string;
  detail?: string;
  actions?: readonly BuilderQuestionAction[];
}

export interface BuilderSessionState {
  persona: PersonaInput;
  question?: BuilderQuestion | null;
}

export interface BuilderSession {
  events$: {
    subscribe(listener: (event: StructuredRunnerEvent) => void): () => void;
  };
  send(text: string): void | Promise<void>;
  /** Replace this snapshot when presentation state changes. */
  readonly state: BuilderSessionState;
}

type BuilderItem =
  | { id: string; kind: "you"; text: string }
  | { id: string; kind: "ash"; text: string }
  | { id: string; kind: "activity"; name: string; detail?: string; open: boolean }
  | { id: string; kind: "error"; text: string };

interface BuilderView {
  items: BuilderItem[];
  persona: PersonaState;
  question: BuilderQuestion | null;
  questionId: string | null;
  openReplyId: string | null;
  announcement: { sourceId: string; text: string } | null;
}

function initialView(state: BuilderSessionState): BuilderView {
  const synced = applySessionState(
    {
      items: [],
      persona: INITIAL_PERSONA,
      question: null,
      questionId: null,
      openReplyId: null,
      announcement: null,
    },
    state,
  );
  return {
    items: [],
    ...synced,
    openReplyId: null,
    announcement: null,
  };
}

function applySessionState(
  current: BuilderView,
  state: BuilderSessionState,
): Pick<BuilderView, "persona" | "question" | "questionId"> {
  const questionId = state.question?.id ?? null;
  let base = current.persona;
  if (questionId && !base.questionPending) {
    base = reducePersona(base, { kind: "question-asked" });
  } else if (!questionId && base.questionPending) {
    base = reducePersona(base, { kind: "question-answered" });
  }
  let persona = reducePersona(base, state.persona);
  // The visible card is authoritative even if a stale state input says the
  // question was answered. Blocked still wins because it keeps pending true.
  if (questionId && !persona.questionPending) {
    persona = reducePersona(persona, { kind: "question-asked" });
  }
  return { persona, question: state.question ?? null, questionId };
}

/** Presentation-only builder chat. The session owns execution; this owns pixels. */
export function VibeBuilderPane({ session }: { session: BuilderSession }) {
  const sequence = useRef(0);
  const nextId = () => `builder-${++sequence.current}`;
  const [view, setView] = useState(() => initialView(session.state));
  const [draft, setDraft] = useState("");
  const [answeringQuestion, setAnsweringQuestion] = useState<string | null>(null);
  const questionCard = useRef<HTMLDivElement>(null);
  const sessionVersion = useRef(0);
  const snapshot = session.state;

  useEffect(() => {
    sessionVersion.current += 1;
    setDraft("");
    setAnsweringQuestion(null);
    setView(initialView(session.state));
    return session.events$.subscribe((event) => {
      if (event.kind === "error") setAnsweringQuestion(null);
      setView((current) => {
        const state = applySessionState(current, session.state);
        const items = current.items.slice();
        let openReplyId = current.openReplyId;

        switch (event.kind) {
          case "delta": {
            const replyIndex = openReplyId
              ? items.findIndex((item) => item.id === openReplyId && item.kind === "ash")
              : -1;
            const reply = items[replyIndex];
            if (reply?.kind === "ash") {
              items[replyIndex] = { ...reply, text: reply.text + event.text };
            } else {
              openReplyId = nextId();
              items.push({ id: openReplyId, kind: "ash", text: event.text });
            }
            break;
          }
          case "reply":
            items.push({ id: nextId(), kind: "ash", text: event.text });
            openReplyId = null;
            break;
          case "tool":
            items.push({
              id: nextId(),
              kind: "activity",
              name: event.name,
              detail: event.detail,
              open: false,
            });
            openReplyId = null;
            break;
          case "error":
            items.push({ id: nextId(), kind: "error", text: event.message });
            openReplyId = null;
            break;
          case "turnEnd": {
            const turnItems = items.slice(
              items.reduce(
                (last, item, index) => (item.kind === "you" ? index + 1 : last),
                0,
              ),
            );
            const replies = turnItems.filter(
              (item): item is Extract<BuilderItem, { kind: "ash" }> =>
                item.kind === "ash",
            );
            const lastReply = replies[replies.length - 1];
            const announcement =
              lastReply && lastReply.id !== current.announcement?.sourceId
                ? {
                    sourceId: lastReply.id,
                    text: replies.map((item) => item.text).join("\n"),
                  }
                : current.announcement;
            openReplyId = null;
            return { ...current, ...state, items, openReplyId, announcement };
          }
          case "exit":
            openReplyId = null;
            break;
          case "ready":
            break;
        }

        return { ...current, ...state, items, openReplyId };
      });
    });
  }, [session]);

  // A stable session object may receive a replaced state snapshot from its
  // parent without a runner event (for example, a verification result).
  useEffect(() => {
    setView((current) => ({
      ...current,
      ...applySessionState(current, snapshot),
    }));
  }, [session, snapshot]);

  useEffect(() => {
    setAnsweringQuestion(null);
    if (view.questionId) questionCard.current?.focus();
  }, [view.questionId]);

  const reportSendError = (error: unknown, version: number) => {
    if (version !== sessionVersion.current) return;
    setAnsweringQuestion(null);
    setView((current) => ({
      ...current,
      items: [
        ...current.items,
        { id: nextId(), kind: "error", text: `Could not send: ${String(error)}` },
      ],
      openReplyId: null,
    }));
  };

  const send = (text: string) => {
    const message = text.trim();
    if (!message) return;
    setView((current) => ({
      ...current,
      items: [...current.items, { id: nextId(), kind: "you", text: message }],
      persona: reducePersona(current.persona, { kind: "turn-started" }),
      openReplyId: null,
    }));
    setDraft("");
    const version = sessionVersion.current;
    try {
      void Promise.resolve(session.send(message)).catch((error) =>
        reportSendError(error, version),
      );
    } catch (error) {
      reportSendError(error, version);
    }
  };

  const toggleActivity = (id: string) => {
    setView((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === id && item.kind === "activity"
          ? { ...item, open: !item.open }
          : item,
      ),
    }));
  };

  const name = mascotDef().label;
  const question = view.question;

  return (
    <section
      className="vibe-builder-pane"
      aria-label={`${name} builder`}
      style={{ display: "flex", minHeight: 0, flexDirection: "column" }}
    >
      <header className="vibe-builder-head companion-head">
        <Mascot
          state={view.persona.state}
          tone={view.persona.tone}
          size={54}
          title={`${name} is ${view.persona.state}`}
          className="vibe-builder-mascot"
        />
        <div className="vibe-builder-identity">
          <strong>{name}</strong>
          <span className="companion-cli"> · your builder</span>
          {view.persona.utterance && (
            <div className="vibe-builder-aside" aria-live="polite">
              {view.persona.utterance}
            </div>
          )}
        </div>
      </header>

      <div
        className="vibe-builder-log companion-log"
        role="region"
        aria-label="Builder conversation"
      >
        {view.items.length === 0 && (
          <p className="companion-empty">Tell {name} what you want to build.</p>
        )}
        {view.items.map((item) => {
          if (item.kind === "activity") {
            return (
              <div className="vibe-builder-activity companion-trail" key={item.id}>
                <button
                  className="companion-trail-row"
                  type="button"
                  aria-expanded={item.open}
                  onClick={() => toggleActivity(item.id)}
                >
                  <span className="companion-trail-mark" aria-hidden>
                    {item.open ? "-" : "+"}
                  </span>
                  <span className="companion-trail-name">{item.name}</span>
                </button>
                {item.open && (
                  <div className="vibe-builder-activity-detail companion-tool">
                    {item.detail || "No additional detail."}
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === "error") {
            return (
              <div className="companion-error" role="alert" key={item.id}>
                {item.text}
              </div>
            );
          }
          return (
            <div
              className={`companion-msg companion-msg-${item.kind}`}
              key={item.id}
            >
              <span className="companion-who">
                {item.kind === "you" ? "you" : name.toLowerCase()}
              </span>
              <div className="companion-body">
                {item.kind === "ash" ? (
                  <Markdown text={item.text} origin="external" />
                ) : (
                  <span className="companion-said">{item.text}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="vibe-builder-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {view.announcement && (
          <span key={view.announcement.sourceId}>
            {name} replied: {view.announcement.text}
          </span>
        )}
      </div>

      {question && (
        <div
          ref={questionCard}
          className={`vibe-builder-question vibe-builder-question-${question.kind} companion-ask`}
          role="group"
          tabIndex={-1}
          aria-live="assertive"
          aria-atomic="true"
          aria-label={`${question.kind === "confirm" ? "Confirm" : "Question"}: ${question.prompt}`}
        >
          <div className="companion-ask-what">{question.prompt}</div>
          {question.detail && (
            <div className="companion-ask-detail">{question.detail}</div>
          )}
          {(question.actions ?? []).length > 0 ? (
            <div className="companion-ask-buttons">
              {(question.actions ?? []).map((action) => (
                <button
                  className="companion-needs-cta"
                  type="button"
                  key={action.response}
                  disabled={answeringQuestion === question.id}
                  onClick={() => {
                    setAnsweringQuestion(question.id);
                    send(action.response);
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="companion-ask-detail">Reply below.</span>
          )}
        </div>
      )}

      <form
        className="vibe-builder-compose companion-compose"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <textarea
          className="vibe-builder-input companion-input"
          rows={1}
          value={draft}
          aria-label={`Message ${name}`}
          placeholder={`Tell ${name} what to change`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
        />
        <button
          className="vibe-builder-send companion-send"
          type="submit"
          disabled={!draft.trim()}
        >
          Send
        </button>
      </form>
    </section>
  );
}

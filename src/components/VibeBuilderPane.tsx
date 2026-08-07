import { useEffect, useRef, useState } from "react";
import {
  INITIAL_PERSONA,
  reducePersona,
  type PersonaState,
} from "../personaBridge";
import type {
  BuilderQuestion,
  BuilderSession,
  BuilderSessionState,
} from "../vibeBuilderSessionTypes";
import { mascotDef } from "../mascots";
import { Markdown } from "./Markdown";
import { Mascot } from "./Mascot";

type BuilderItem =
  | { id: string; kind: "you"; text: string }
  | { id: string; kind: "ash"; text: string }
  | {
      id: string;
      kind: "activity";
      tools: { name: string; detail?: string }[];
      open: boolean;
    }
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
  const composer = useRef<HTMLTextAreaElement>(null);
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
            if (items[items.length - 1]?.kind === "activity") {
              const held = items[items.length - 1];
              if (held.kind === "activity") {
                items[items.length - 1] = {
                  ...held,
                  tools: [...held.tools, { name: event.name, detail: event.detail }],
                  open: false,
                };
              }
            } else {
              items.push({
                id: nextId(),
                kind: "activity",
                tools: [{ name: event.name, detail: event.detail }],
                open: false,
              });
            }
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
  const starterIdeas = [
    "Create a polished landing page",
    "Make this experience feel premium",
    "Fix what isn't working",
  ];

  const chooseStarter = (idea: string) => {
    setDraft(idea);
    requestAnimationFrame(() => composer.current?.focus());
  };

  return (
    <section
      className="vibe-builder-pane"
      aria-label={`${name} builder`}
      style={{ display: "flex", minHeight: 0, flexDirection: "column" }}
    >
      <header className="vibe-builder-head companion-head">
        <div className={`vibe-builder-mascot-stage is-${view.persona.state}`}>
          <Mascot
            state={view.persona.state}
            tone={view.persona.tone}
            size={46}
            title={`${name} is ${view.persona.state}`}
            className="vibe-builder-mascot"
          />
        </div>
        <div className="vibe-builder-identity">
          <div className="vibe-builder-name-row">
            <strong>{name}</strong>
            <span className="vibe-builder-mode">
              <span aria-hidden /> Build mode
            </span>
          </div>
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
          <div className="vibe-builder-welcome">
            <span className="vibe-builder-welcome-kicker">Your idea, in motion</span>
            <strong>What should we make?</strong>
            <p>
              Describe the result you want. {name} will understand the project
              and handle the technical setup.
            </p>
            <div className="vibe-builder-starters" aria-label="Starting ideas">
              {starterIdeas.map((idea) => (
                <button type="button" key={idea} onClick={() => chooseStarter(idea)}>
                  <span aria-hidden>+</span>
                  {idea}
                </button>
              ))}
            </div>
          </div>
        )}
        {view.items.map((item) => {
          if (item.kind === "activity") {
            const latest = item.tools[item.tools.length - 1]!;
            const before = item.tools.length - 1;
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
                  <span className="companion-trail-name">{latest.name}</span>
                  {latest.detail && (
                    <span className="companion-trail-detail">{latest.detail}</span>
                  )}
                  {before > 0 && (
                    <span className="companion-trail-count">+{before}</span>
                  )}
                </button>
                {item.open && (
                  <div className="vibe-builder-activity-detail companion-trail-all">
                    {item.tools.map((tool, index) => (
                      <span
                        className="companion-tool"
                        key={`${tool.name}-${index}`}
                      >
                        {tool.name}
                        {tool.detail && (
                          <span className="companion-tool-detail">{tool.detail}</span>
                        )}
                      </span>
                    ))}
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
          {question.diff && (
            <pre className="vibe-builder-question-diff">{question.diff}</pre>
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
        <div className="vibe-builder-input-shell">
          <textarea
            ref={composer}
            className="vibe-builder-input companion-input"
            rows={1}
            value={draft}
            aria-label={`Message ${name}`}
            placeholder={`Tell ${name} what you want`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(draft);
              }
            }}
          />
          <span className="vibe-builder-input-note">No technical steps needed</span>
        </div>
        <button
          className="vibe-builder-send companion-send"
          type="submit"
          disabled={!draft.trim()}
        >
          <span>Send</span>
          <span className="vibe-builder-send-arrow" aria-hidden>↗</span>
        </button>
      </form>
    </section>
  );
}

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
import type { Project } from "../projects";
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

export type VibeBuilderProject = Pick<Project, "id" | "components" | "vibe">;

/** Conversations are project-owned, while runner sessions are replaceable
 * implementation details. Setup, waiting and the live builder can hand off in
 * one conversation; switching away and back must not erase what the person
 * already said or make the first-visit card return. App-lifetime only: no chat
 * content is added to workspace persistence. */
const projectConversations = new Map<
  string,
  { items: BuilderItem[]; hasSpoken: boolean }
>();
let builderItemSequence = 0;

export function vibeStarterIdeas(project: VibeBuilderProject | undefined): string[] {
  if (
    !project?.vibe?.setupRevision ||
    project.components.length === 0 ||
    project.components.some((component) => !component.role)
  ) {
    return [];
  }

  const roles = new Set(project.components.map((component) => component.role));
  const preview = project.components.find(
    (component) => component.id === project.vibe?.componentId,
  );
  const ideas: string[] = [];
  const add = (idea: string) => {
    if (!ideas.includes(idea)) ideas.push(idea);
  };

  if (preview?.role === "web") add("Polish what people see first");
  else if (preview?.role === "mobile") add("Polish the first screen");
  else if (roles.has("api")) add("Make the service easier to rely on");
  else if (roles.has("worker")) add("Make background work more reliable");
  else if (roles.has("database")) add("Make data changes safer");
  else if (roles.has("library")) add("Make this easier for people to use");
  else if (roles.has("tooling")) add("Simplify the everyday workflow");

  const requiredService = project.vibe.externalServices?.find(
    (service) => service.requiredForPreview,
  );
  if (requiredService) add(`Connect ${requiredService.label}`);

  if (preview?.role === "web") add("Make it feel great on every screen");
  else if (preview?.role === "mobile") add("Make the app easier to use");
  else if (roles.has("api")) add("Add a new capability");
  else if (roles.has("worker")) add("Help failed work recover smoothly");

  if (
    ideas.length < 3 &&
    project.components.some((component) =>
      component.commands?.some((command) => command.purpose === "check"),
    )
  ) {
    add("Check that everything is working");
  }

  return ideas.slice(0, 3);
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
export function VibeBuilderPane({
  session,
  project,
}: {
  session: BuilderSession;
  project?: VibeBuilderProject;
}) {
  const nextId = () => `builder-${++builderItemSequence}`;
  const [view, setView] = useState(() => {
    const initial = initialView(session.state);
    const held = project ? projectConversations.get(project.id) : undefined;
    return held ? { ...initial, items: held.items } : initial;
  });
  const [hasSpoken, setHasSpoken] = useState(
    () => (project ? projectConversations.get(project.id)?.hasSpoken : false) ?? false,
  );
  const [draft, setDraft] = useState("");
  const [answeringQuestion, setAnsweringQuestion] = useState<string | null>(null);
  const questionCard = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const projectId = project?.id ?? null;
  const projectIdRef = useRef(projectId);
  const sessionVersion = useRef(0);
  const snapshot = session.state;

  useEffect(() => {
    sessionVersion.current += 1;
    setDraft("");
    setAnsweringQuestion(null);
    const switchedProject = projectIdRef.current !== projectId;
    projectIdRef.current = projectId;
    const held = projectId ? projectConversations.get(projectId) : undefined;
    setHasSpoken(held?.hasSpoken ?? false);
    setView((current) => {
      const items = switchedProject ? held?.items ?? [] : current.items;
      const next = { ...current, items };
      return {
        ...next,
        ...applySessionState(next, session.state),
        openReplyId: null,
        announcement: null,
      };
    });
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
  }, [projectId, session]);

  useEffect(() => {
    if (!projectId) return;
    const held = projectConversations.get(projectId);
    projectConversations.set(projectId, {
      items: view.items,
      hasSpoken: held?.hasSpoken ?? hasSpoken,
    });
  }, [hasSpoken, projectId, view.items]);

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
    setHasSpoken(true);
    if (projectId) {
      const held = projectConversations.get(projectId);
      projectConversations.set(projectId, {
        items: held?.items ?? view.items,
        hasSpoken: true,
      });
    }
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
  const starterIdeas = vibeStarterIdeas(project);

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
        {!hasSpoken && view.items.length === 0 && (
          <div className="vibe-builder-welcome">
            <span className="vibe-builder-welcome-kicker">Your idea, in motion</span>
            <strong>What should we make?</strong>
            <p>
              {starterIdeas.length > 0
                ? "Choose a starting point, or describe the result you want."
                : `${name} will learn the project before suggesting a direction. Tell it the result you want.`}
            </p>
            {starterIdeas.length > 0 && (
              <div className="vibe-builder-starters" aria-label="Starting ideas">
                {starterIdeas.map((idea) => (
                  <button type="button" key={idea} onClick={() => chooseStarter(idea)}>
                    <span aria-hidden>+</span>
                    {idea}
                  </button>
                ))}
              </div>
            )}
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

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
import { vibeRequestMode, type VibeRequestMode } from "../vibeRequestMode";
import { mascotDef } from "../mascots";
import { Markdown } from "./Markdown";
import { Mascot } from "./Mascot";

type BuilderItem =
  | {
      id: string;
      kind: "you";
      text: string;
      delivery: "active" | "queued" | "done" | "failed";
      requestMode: VibeRequestMode;
    }
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
export type VibeBuilderPhase = "build" | "discovering" | "waiting";
export type VibeSignalState =
  | "idle"
  | "discovering"
  | "creating"
  | "checking"
  | "waiting"
  | "blocked"
  | "complete"
  | "published";

export function vibeBuilderStatus(
  persona: PersonaState,
  phase: VibeBuilderPhase,
  requestMode: VibeRequestMode = "change",
): { label: string; signal: VibeSignalState; busy: boolean; blocking: boolean } {
  // Setup and handoff sessions intentionally cannot accept instructions. Keep
  // that capability explicit instead of inferring it from a busy animation:
  // an ordinary Build turn is busy but remains available for another request.
  const blocking = phase !== "build";
  if (persona.state === "thinking") {
    return phase === "discovering"
      ? {
          label: "Understanding your project…",
          signal: "discovering",
          busy: true,
          blocking,
        }
      : requestMode === "question"
        ? { label: "Looking into your question…", signal: "creating", busy: true, blocking }
        : { label: "Making your change…", signal: "creating", busy: true, blocking };
  }
  if (persona.state === "explaining") {
    return requestMode === "question"
      ? { label: "Putting the answer together…", signal: "checking", busy: true, blocking }
      : { label: "Checking the result…", signal: "checking", busy: true, blocking };
  }
  if (persona.state === "needs") {
    return { label: "Waiting for you", signal: "waiting", busy: false, blocking };
  }
  if (persona.state === "blocked") {
    return { label: "Needs your attention", signal: "blocked", busy: false, blocking };
  }
  if (persona.state === "done") {
    return { label: "Ready", signal: "complete", busy: false, blocking };
  }
  if (persona.state === "celebrating") {
    return { label: "It’s live", signal: "published", busy: false, blocking };
  }
  if (persona.state === "sleeping") {
    return { label: "Paused", signal: "idle", busy: false, blocking };
  }
  if (phase === "discovering") {
    return {
      label: "Understanding your project…",
      signal: "discovering",
      busy: true,
      blocking,
    };
  }
  return phase === "waiting"
    ? { label: "Getting ready…", signal: "idle", busy: false, blocking }
    : { label: "Ready", signal: "idle", busy: false, blocking };
}

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
  const asksForAnswer = Boolean(state.question && state.question.kind !== "notice");
  let base = current.persona;
  if (asksForAnswer && !base.questionPending) {
    base = reducePersona(base, { kind: "question-asked" });
  } else if (!asksForAnswer && base.questionPending) {
    base = reducePersona(base, { kind: "question-answered" });
  }
  let persona = reducePersona(base, state.persona);
  if (state.question?.kind === "notice") {
    // An incident input historically implied "needs" because every incident
    // used to ask a question. A notice explicitly means Ash is already acting,
    // so carrying that old implication forward produces the contradictory
    // "Waiting for you" state beside copy that says "I'm handling it."
    persona = {
      ...persona,
      state: persona.state === "needs" ? "thinking" : persona.state,
      utterance: persona.state === "needs" ? null : persona.utterance,
      questionPending: false,
    };
  }
  // The visible card is authoritative even if a stale state input says the
  // question was answered. Blocked still wins because it keeps pending true.
  if (asksForAnswer && !persona.questionPending) {
    persona = reducePersona(persona, { kind: "question-asked" });
  }
  return { persona, question: state.question ?? null, questionId };
}

/** Presentation-only builder chat. The session owns execution; this owns pixels. */
export function VibeBuilderPane({
  session,
  project,
  phase = "build",
}: {
  session: BuilderSession;
  project?: VibeBuilderProject;
  phase?: VibeBuilderPhase;
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
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [cushionDismissed, setCushionDismissed] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const questionCard = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const projectId = project?.id ?? null;
  const projectIdRef = useRef(projectId);
  const sessionVersion = useRef(0);
  const snapshot = session.state;

  useEffect(() => {
    sessionVersion.current += 1;
    setDraft("");
    setAnsweringQuestion(null);
    setComposerFocused(false);
    setStopping(false);
    const switchedProject = projectIdRef.current !== projectId;
    projectIdRef.current = projectId;
    if (switchedProject) {
      setTranscriptOpen(false);
      setCushionDismissed(false);
    }
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
    if (view.questionId) {
      // A genuinely new ask gets one entrance. After that the person may tuck
      // it away without answering; its id and session state stay untouched.
      setCushionDismissed(false);
    }
  }, [view.questionId]);

  useEffect(() => {
    if (!transcriptOpen) return;
    const log = transcript.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [transcriptOpen, view.items]);

  const reportSendError = (error: unknown, version: number, itemId?: string) => {
    if (version !== sessionVersion.current) return;
    setAnsweringQuestion(null);
    setView((current) => ({
      ...current,
      items: [
        ...current.items.map((item) =>
          item.id === itemId && item.kind === "you"
            ? { ...item, delivery: "failed" as const }
            : item,
        ),
        { id: nextId(), kind: "error", text: `Could not send: ${String(error)}` },
      ],
      openReplyId: null,
    }));
  };

  const send = (text: string) => {
    const message = text.trim();
    if (!message) return;
    const itemId = nextId();
    const requestMode = vibeRequestMode(message);
    setHasSpoken(true);
    if (projectId) {
      const held = projectConversations.get(projectId);
      projectConversations.set(projectId, {
        items: held?.items ?? view.items,
        hasSpoken: true,
      });
    }
    setView((current) => {
      const working =
        current.persona.state === "thinking" ||
        current.persona.state === "explaining";
      const delivery = working ? "queued" : "active";
      return {
        ...current,
        items: [
          ...current.items.map((item) =>
            delivery === "active" && item.kind === "you" && item.delivery === "active"
              ? { ...item, delivery: "done" as const }
              : item,
          ),
          { id: itemId, kind: "you", text: message, delivery, requestMode },
        ],
        persona: reducePersona(current.persona, { kind: "turn-started" }),
        openReplyId: null,
      };
    });
    setDraft("");
    setComposerFocused(false);
    composer.current?.blur();
    const version = sessionVersion.current;
    const markAccepted = () => {
      if (version !== sessionVersion.current) return;
      setView((current) => ({
        ...current,
        items: current.items.map((item) => {
          if (item.kind !== "you") return item;
          if (item.id === itemId && item.delivery === "queued") {
            return { ...item, delivery: "active" };
          }
          if (item.id !== itemId && item.delivery === "active") {
            return { ...item, delivery: "done" };
          }
          return item;
        }),
      }));
    };
    try {
      void Promise.resolve(session.send(message))
        .then(markAccepted)
        .catch((error) => reportSendError(error, version, itemId));
    } catch (error) {
      reportSendError(error, version, itemId);
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

  const currentRequestMode = [...view.items]
    .reverse()
    .find(
      (item): item is Extract<BuilderItem, { kind: "you" }> =>
        item.kind === "you" && item.delivery === "active",
    )?.requestMode;
  const status = vibeBuilderStatus(view.persona, phase, currentRequestMode);
  const latestUserRequest = [...view.items]
    .reverse()
    .find(
      (item): item is Extract<BuilderItem, { kind: "you" }> => item.kind === "you",
    );
  const activeUserRequest =
    [...view.items]
      .reverse()
      .find(
        (item): item is Extract<BuilderItem, { kind: "you" }> =>
          item.kind === "you" && item.delivery === "active",
      ) ?? latestUserRequest;
  const queuedUserRequests = view.items.filter(
    (item): item is Extract<BuilderItem, { kind: "you" }> =>
      item.kind === "you" && item.delivery === "queued",
  );
  const showWelcome = !hasSpoken && view.items.length === 0;
  const contextualCushion =
    Boolean(question) || (showWelcome && starterIdeas.length > 0);
  const cushionOpen =
    transcriptOpen || (contextualCushion && !cushionDismissed);
  const composerOpen =
    !status.blocking && (composerFocused || Boolean(draft.trim()) || cushionOpen);
  // Closing the transcript must not make the active turn anonymous. The
  // request is the anchor for every status that follows it; without this row,
  // "Making your change" gives no clue which change is in flight and a
  // question looks detached from the words that caused it.
  const showTurnReceipt =
    Boolean(activeUserRequest) &&
    !transcriptOpen &&
    (status.busy || Boolean(question) || status.signal === "blocked");
  useEffect(() => {
    if (view.questionId && cushionOpen) questionCard.current?.focus();
  }, [cushionOpen, view.questionId]);
  const stopCurrentTurn = async () => {
    if (!session.cancelCurrentTurn || stopping) return;
    setStopping(true);
    try {
      await session.cancelCurrentTurn();
    } finally {
      setStopping(false);
      setComposerFocused(false);
      composer.current?.blur();
    }
  };
  const toggleContextualCushion = () => {
    if (cushionOpen) {
      setTranscriptOpen(false);
      setCushionDismissed(true);
      return;
    }
    setCushionDismissed(false);
  };

  const conversation = view.items.map((item) => {
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
              {item.open ? "−" : "+"}
            </span>
            <span className="companion-trail-name">{latest.name}</span>
            {latest.detail && (
              <span className="companion-trail-detail">{latest.detail}</span>
            )}
            {before > 0 && <span className="companion-trail-count">+{before}</span>}
          </button>
          {item.open && (
            <div className="vibe-builder-activity-detail companion-trail-all">
              {item.tools.map((tool, index) => (
                <span className="companion-tool" key={`${tool.name}-${index}`}>
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
      <div className={`companion-msg companion-msg-${item.kind}`} key={item.id}>
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
  });

  const welcome = showWelcome && !question && (
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
  );

  // The empty preview already explains that the project is preparing. A
  // second floating control that says "Ready" (or looks like an input while
  // rejecting input) is a false affordance. Keep the mounted session so an
  // incident/question can still surface, but do not render the composer until
  // the runtime has reached the first point at which it can accept a request.
  if (
    phase === "waiting" &&
    !question
  ) {
    return null;
  }

  return (
    <section
      className={`vibe-builder-pane ${
        cushionOpen
          ? "is-cushion"
          : composerOpen
            ? "is-composer-open"
            : "is-pill is-collapsed"
      } ${status.blocking ? "is-blocking" : "is-available"}`}
      data-signal={status.signal}
      data-tone={view.persona.tone}
      data-blocking={status.blocking}
      aria-label={`${name} builder`}
    >
      <div className="vibe-builder-signal" aria-hidden>
        <span />
        <span />
      </div>

      <div className="vibe-builder-cushion">
        {showTurnReceipt && activeUserRequest && (
          <div
            className="vibe-builder-turn-receipt"
            aria-label="Your latest request"
            title={activeUserRequest.text}
          >
            <span>You asked</span>
            <p>{activeUserRequest.text}</p>
          </div>
        )}
        {!transcriptOpen && queuedUserRequests.length > 0 && (
          <div
            className="vibe-builder-queue"
            aria-label={`${queuedUserRequests.length} queued ${queuedUserRequests.length === 1 ? "request" : "requests"}`}
          >
            <span>Up next · {queuedUserRequests.length}</span>
            <ol>
              {queuedUserRequests.slice(0, 3).map((item) => (
                <li key={item.id} title={item.text}>{item.text}</li>
              ))}
            </ol>
          </div>
        )}
        {cushionOpen && (
          <div className="vibe-builder-cushion-body" key="context">
            {contextualCushion && (
              <div className="vibe-builder-cushion-controls">
                <button
                  className="vibe-builder-collapse vibe-builder-collapse-panel"
                  type="button"
                  aria-expanded="true"
                  aria-label={
                    question ? "Collapse question" : "Collapse suggestions"
                  }
                  title="Show more of the product"
                  onMouseDown={(event) => {
                    if (document.activeElement === composer.current) {
                      event.preventDefault();
                    }
                  }}
                  onClick={toggleContextualCushion}
                >
                  <svg aria-hidden viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              </div>
            )}
            {transcriptOpen ? (
              <div
                ref={transcript}
                className="vibe-builder-log companion-log"
                role="region"
                aria-label="Builder conversation"
              >
                {welcome}
                {conversation}
              </div>
            ) : (
              welcome
            )}

            {question && (
              <div
                ref={questionCard}
                className={`vibe-builder-question vibe-builder-question-${question.kind} companion-ask`}
                role="group"
                tabIndex={-1}
                aria-live="assertive"
                aria-atomic="true"
                aria-label={`${question.kind === "confirm" ? "Confirm" : question.kind === "notice" ? "Update" : "Question"}: ${question.prompt}`}
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
                ) : question.kind === "notice" ? null : (
                  // A notice is Canopy reporting, not asking. "Reply below."
                  // under "I'm reading its output to find out why" told the
                  // person to act on the one thing Canopy had just taken over.
                  <span className="companion-ask-detail">Reply below.</span>
                )}
              </div>
            )}
          </div>
        )}

        <form
          className="vibe-builder-compose companion-compose"
          key="composer"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <div className={`vibe-builder-mascot-stage is-${view.persona.state}`}>
            <Mascot
              state={view.persona.state}
              tone={view.persona.tone}
              size={42}
              title={`${name} is ${view.persona.state}`}
              className="vibe-builder-mascot"
            />
          </div>

          <div className="vibe-builder-input-shell">
            <div className="vibe-builder-status" aria-live="polite">
              <span aria-hidden />
              {view.persona.utterance ?? status.label}
            </div>
            {!status.blocking && (
              <textarea
                ref={composer}
                className="vibe-builder-input companion-input"
                rows={1}
                value={draft}
                aria-label={`Message ${name}`}
                aria-expanded={composerOpen}
                placeholder={`Tell ${name} what you want`}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send(draft);
                  }
                }}
              />
            )}
          </div>

          {contextualCushion && !cushionOpen && (
            <button
              className="vibe-builder-collapse vibe-builder-collapse-restore"
              type="button"
              aria-expanded="false"
              aria-label={
                question ? "Show pending question" : "Show suggestions"
              }
              title="Show this again"
              onClick={toggleContextualCushion}
            >
              <svg aria-hidden viewBox="0 0 24 24">
                <path d="M6 15l6-6 6 6" />
              </svg>
            </button>
          )}
          <button
            className="vibe-builder-transcript"
            type="button"
            aria-expanded={transcriptOpen}
            aria-label={transcriptOpen ? "Close Transcript" : "Open Transcript"}
            title={transcriptOpen ? "Close transcript" : "Open transcript"}
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            <svg aria-hidden viewBox="0 0 24 24">
              <path d="M6 7h12M6 12h9M6 17h7" />
            </svg>
          </button>
          {status.busy && session.cancelCurrentTurn && (
            <button
              className="vibe-builder-stop"
              type="button"
              disabled={stopping}
              onClick={() => void stopCurrentTurn()}
              aria-label="Stop current change"
              title="Stop current change"
            >
              <span aria-hidden />
            </button>
          )}
          {!status.blocking && (
            <button
              className="vibe-builder-send companion-send"
              type="submit"
              disabled={!draft.trim() || stopping}
              aria-label="Send"
              title="Send"
            >
              <span className="vibe-builder-send-arrow" aria-hidden />
            </button>
          )}
        </form>
      </div>

      <div
        className="vibe-builder-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {view.announcement && (
          <span key={view.announcement.sourceId}>
            {name} replied: {view.announcement.text}
          </span>
        )}
      </div>
    </section>
  );
}

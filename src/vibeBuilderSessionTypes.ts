import type { PersonaInput } from "./personaBridge";
import type { StructuredRunnerEvent } from "./structuredEvents";

export interface BuilderQuestionAction {
  label: string;
  response: string;
}

export interface BuilderQuestion {
  id: string;
  /** `notice` is Canopy saying something while it handles it — there is
   *  nothing to answer, and the pane must not invite a reply. Without it every
   *  presented item was a question, so "The app server keeps stopping. I'm
   *  reading its output to find out why." arrived under "Reply below.",
   *  asking the person to act on the one thing Canopy had just taken on. */
  kind: "question" | "confirm" | "notice";
  prompt: string;
  detail?: string;
  diff?: string;
  actions?: readonly BuilderQuestionAction[];
}

export interface BuilderSessionState {
  persona: PersonaInput;
  question?: BuilderQuestion | null;
}

/** The presentation boundary. Execution and persistence stay behind it. */
export interface BuilderSession {
  events$: {
    subscribe(listener: (event: StructuredRunnerEvent) => void): () => void;
  };
  send(text: string): void | Promise<void>;
  /** Cancel only the work currently in flight. The session, preview and
   * conversation remain available for the person's next request. */
  cancelCurrentTurn?: () => void | Promise<void>;
  /** Replace this snapshot when presentation state changes. */
  readonly state: BuilderSessionState;
}

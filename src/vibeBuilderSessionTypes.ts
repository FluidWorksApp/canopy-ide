import type { PersonaInput } from "./personaBridge";
import type { StructuredRunnerEvent } from "./structuredEvents";

export interface BuilderQuestionAction {
  label: string;
  response: string;
}

export interface BuilderQuestion {
  id: string;
  kind: "question" | "confirm";
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
  /** Replace this snapshot when presentation state changes. */
  readonly state: BuilderSessionState;
}

import type { PersonaInput } from "./personaBridge";
import type { StructuredRunnerEvent } from "./structuredEvents";

export interface BuilderQuestionAction {
  label: string;
  response: string;
}

/** A button in Build carries an opaque answer, never execution details. The
 * owner of the card decides whether that answer goes to the builder session,
 * a managed PTY, or a deep-linked question. */
export interface BuilderCardAction extends BuilderQuestionAction {
  tone?: "primary" | "neutral" | "danger";
}

export type BuilderDecisionReason =
  | "credentials"
  | "account-link"
  | "destructive"
  | "payment"
  | "choice";

export type BuilderProgressStage =
  | "discovering"
  | "installing"
  | "compiling"
  | "starting"
  | "repairing";

interface BuilderCardBase {
  id: string;
  title: string;
  detail?: string;
}

/** The only structured interruption surface in Build. It deliberately has no
 * command, log, diff, environment or stack-trace fields: those stay available
 * in Engineer while Build speaks in outcomes and decisions. */
export type BuilderCard =
  | (BuilderCardBase & {
      kind: "progress";
      stage: BuilderProgressStage;
      /** A real supervisor deadline, not an invented percentage. */
      deadlineAt?: number | null;
    })
  | (BuilderCardBase & {
      kind: "decision";
      reason: BuilderDecisionReason;
      actions?: readonly BuilderCardAction[];
    })
  | (BuilderCardBase & {
      kind: "outcome";
      tone: "success" | "warning" | "neutral";
      actions?: readonly BuilderCardAction[];
    });

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
  /** Preferred presentation contract. `question` remains as a compatibility
   * seam while existing sessions move onto cards. */
  card?: BuilderCard | null;
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

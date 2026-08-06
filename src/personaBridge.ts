import type { AshTone } from "./ash";
import type { MascotState } from "./mascots";

export type PersonaInput =
  | { kind: "turn-started" }
  | { kind: "turn-progress" }
  | { kind: "verify-running" }
  | { kind: "verify-passed" }
  | { kind: "verify-failed" }
  | { kind: "question-asked" }
  | { kind: "question-answered" }
  | { kind: "permission-stall" }
  | { kind: "incident" }
  | { kind: "incident-recovered" }
  | { kind: "checkpoint-saved" }
  | { kind: "route-switched"; route: string }
  | { kind: "rate-limited-waiting" }
  | { kind: "publish-succeeded" }
  | { kind: "task-ended" }
  | { kind: "idle" };

export interface PersonaOutput {
  state: MascotState;
  tone: AshTone;
  utterance: string | null;
}

export interface PersonaState extends PersonaOutput {
  questionPending: boolean;
}

export const INITIAL_PERSONA: PersonaState = {
  state: "idle",
  tone: "dim",
  utterance: null,
  questionPending: false,
};

export function routeSwitchUtterance(route: string): string {
  return `switching brains to ${route} — still me`;
}

export function recoveryUtterance(): string {
  return "got stuck for a bit — picked it back up";
}

/** Maps one domain event to the single face and aside it presents. */
export function personaBridge(input: PersonaInput): PersonaOutput {
  switch (input.kind) {
    case "turn-started":
    case "turn-progress":
      return { state: "thinking", tone: "ok", utterance: null };
    case "verify-running":
      return { state: "explaining", tone: "accent", utterance: null };
    case "verify-passed":
      return { state: "done", tone: "ok", utterance: null };
    case "verify-failed":
      return {
        state: "thinking",
        tone: "warn",
        utterance: "one of my checks failed — taking another look",
      };
    case "question-asked":
      return { state: "needs", tone: "warn", utterance: null };
    case "question-answered":
      return { state: "thinking", tone: "ok", utterance: null };
    case "permission-stall":
      return {
        state: "blocked",
        tone: "danger",
        utterance: "I need permission before I can keep going",
      };
    case "incident":
      return {
        state: "needs",
        tone: "warn",
        utterance: "something broke after the last change — want me to fix it?",
      };
    case "incident-recovered":
      return {
        state: "thinking",
        tone: "ok",
        utterance: recoveryUtterance(),
      };
    case "checkpoint-saved":
      return { state: "done", tone: "ok", utterance: "saved this version" };
    case "route-switched":
      return {
        state: "thinking",
        tone: "ok",
        utterance: routeSwitchUtterance(input.route),
      };
    case "rate-limited-waiting":
      return { state: "sleeping", tone: "dim", utterance: null };
    case "publish-succeeded":
      return { state: "celebrating", tone: "ok", utterance: "it's live" };
    case "task-ended":
      return { state: "sleeping", tone: "dim", utterance: null };
    case "idle":
      return { state: "idle", tone: "dim", utterance: null };
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

/** Applies blocked > outstanding question > routine event precedence. */
export function reducePersona(
  current: PersonaState,
  input: PersonaInput,
): PersonaState {
  const next = personaBridge(input);
  const questionPending =
    input.kind === "question-answered"
      ? false
      : current.questionPending ||
        input.kind === "question-asked" ||
        input.kind === "incident";

  if (next.state === "blocked") return { ...next, questionPending };
  if (questionPending) {
    return { ...next, state: "needs", tone: "warn", questionPending };
  }
  return { ...next, questionPending };
}

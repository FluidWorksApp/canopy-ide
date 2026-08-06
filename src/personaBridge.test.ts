import { describe, expect, it } from "vitest";
import { ASH_STATES, ASH_TONE_VARS, ashMayInterrupt } from "./ash";
import {
  INITIAL_PERSONA,
  personaBridge,
  recoveryUtterance,
  reducePersona,
  routeSwitchUtterance,
  type PersonaInput,
} from "./personaBridge";

type InputByKind = {
  [K in PersonaInput["kind"]]: Extract<PersonaInput, { kind: K }>;
};

const INPUTS = {
  "turn-started": { kind: "turn-started" },
  "turn-progress": { kind: "turn-progress" },
  "verify-running": { kind: "verify-running" },
  "verify-passed": { kind: "verify-passed" },
  "verify-failed": { kind: "verify-failed" },
  "question-asked": { kind: "question-asked" },
  "question-answered": { kind: "question-answered" },
  "permission-stall": { kind: "permission-stall" },
  incident: { kind: "incident" },
  "incident-recovered": { kind: "incident-recovered" },
  "checkpoint-saved": { kind: "checkpoint-saved" },
  "route-switched": { kind: "route-switched", route: "Codex" },
  "rate-limited-waiting": { kind: "rate-limited-waiting" },
  "publish-succeeded": { kind: "publish-succeeded" },
  "task-ended": { kind: "task-ended" },
  idle: { kind: "idle" },
} satisfies InputByKind;

const EVERY_INPUT = Object.values(INPUTS) as PersonaInput[];

describe("personaBridge", () => {
  it("maps every PersonaInput kind", () => {
    expect(EVERY_INPUT).toHaveLength(16);
    for (const input of EVERY_INPUT) {
      const output = personaBridge(input);
      expect(ASH_STATES, input.kind).toContain(output.state);
      expect(Object.keys(ASH_TONE_VARS), input.kind).toContain(output.tone);
      expect(output.utterance === null || typeof output.utterance === "string").toBe(
        true,
      );
    }
  });

  it("maps each input to exactly one face", () => {
    for (const input of EVERY_INPUT) {
      const output = personaBridge(input);
      expect(
        ASH_STATES.filter((state) => state === output.state),
        input.kind,
      ).toHaveLength(1);
    }
  });

  it("only lets needs and blocked outputs interrupt", () => {
    const interrupting = EVERY_INPUT.filter((input) =>
      ashMayInterrupt(personaBridge(input).state),
    ).map((input) => input.kind);

    expect(interrupting).toEqual([
      "question-asked",
      "permission-stall",
      "incident",
    ]);
    for (const input of EVERY_INPUT) {
      const state = personaBridge(input).state;
      if (ashMayInterrupt(state)) expect(["needs", "blocked"]).toContain(state);
    }
  });

  it("uses the established state vocabulary for lifecycle milestones", () => {
    expect(personaBridge(INPUTS["turn-started"]).state).toBe("thinking");
    expect(personaBridge(INPUTS["verify-running"]).state).toBe("explaining");
    expect(personaBridge(INPUTS["verify-passed"]).state).toBe("done");
    expect(personaBridge(INPUTS["verify-failed"])).toMatchObject({
      state: "thinking",
      tone: "warn",
    });
    expect(personaBridge(INPUTS["rate-limited-waiting"]).state).toBe("sleeping");
    expect(personaBridge(INPUTS["publish-succeeded"]).state).toBe("celebrating");
  });

  it("keeps in-character asides consistent", () => {
    expect(routeSwitchUtterance("Codex")).toBe(
      "switching brains to Codex — still me",
    );
    expect(personaBridge(INPUTS["route-switched"]).utterance).toBe(
      routeSwitchUtterance("Codex"),
    );
    expect(recoveryUtterance()).toBe("got stuck for a bit — picked it back up");
    expect(personaBridge(INPUTS["incident-recovered"]).utterance).toBe(
      recoveryUtterance(),
    );
  });
});

describe("reducePersona", () => {
  it("keeps a question in needs until it is answered", () => {
    let current = reducePersona(INITIAL_PERSONA, INPUTS["question-asked"]);
    expect(current.state).toBe("needs");
    expect(current.questionPending).toBe(true);

    for (const input of [
      INPUTS["turn-progress"],
      INPUTS["verify-running"],
      INPUTS["route-switched"],
    ]) {
      current = reducePersona(current, input);
      expect(current.state, input.kind).toBe("needs");
      expect(ashMayInterrupt(current.state), input.kind).toBe(true);
    }

    current = reducePersona(current, INPUTS["question-answered"]);
    expect(current).toMatchObject(personaBridge(INPUTS["question-answered"]));
    expect(current.state).toBe("thinking");
    expect(current.questionPending).toBe(false);
  });

  it("gives blocked precedence, then re-surfaces the pinned question", () => {
    let current = reducePersona(INITIAL_PERSONA, INPUTS["question-asked"]);

    current = reducePersona(current, INPUTS["permission-stall"]);
    expect(current).toMatchObject({
      state: "blocked",
      tone: "danger",
      questionPending: true,
    });

    current = reducePersona(current, INPUTS["turn-progress"]);
    expect(current).toMatchObject({
      state: "needs",
      tone: "warn",
      questionPending: true,
    });
  });

  it("does not invent state when no question is outstanding", () => {
    let current = INITIAL_PERSONA;
    for (const input of EVERY_INPUT.filter(
      (candidate) => candidate.kind !== "question-asked",
    )) {
      current = reducePersona(current, input);
      expect(current, input.kind).toMatchObject(personaBridge(input));
      expect(current.questionPending, input.kind).toBe(input.kind === "incident");
      if (input.kind === "incident") {
        current = reducePersona(current, INPUTS["question-answered"]);
      }
    }
  });
});

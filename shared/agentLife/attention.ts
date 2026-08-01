// What the human has not dealt with — the other axis.
//
// Lifecycle answers what the agent is doing. Attention answers what is
// outstanding for you. They are separate because they are cleared by different
// things: an agent's claim that it needs you is retracted by the agent moving
// on, and an unread ring is retracted by you looking. Folding them into one
// value is what let a six-second CPU dip file a working agent under "Needs
// you", and kept it there after the agent resumed, because the only thing that
// cleared the flag was focus.
//
// Note what this reducer cannot see: it takes `focus` as an input, and the
// lifecycle ladder's evidence type has no field for it at all. That asymmetry
// is deliberate and type-enforced — attention may know about focus, lifecycle
// may not.
import { fidelityFor } from "./fidelity";
import type { Attention, Life } from "./vocabulary";

/** What a hook event meant, once the producer has classified it. The strings
 *  match the `--signal` values `canopy-hook` accepts, so an installer that
 *  fires a signal and the reducer that reads it name the same thing. */
export type HookSignal =
  | "turn-start"
  | "turn-progress"
  | "turn-end"
  | "session-end"
  | "needs-human"
  | "needs-human-permission"
  | "needs-human-ambiguous";

export type AttentionInput =
  | { t: "hook"; at: number; signal: HookSignal }
  | { t: "osc"; at: number; body: string }
  /** The went-quiet edge from the process monitor. */
  | { t: "quiet"; at: number }
  | { t: "focus"; at: number; visible: boolean }
  | { t: "life"; at: number; next: Life };

/**
 * Fold one input into the attention state.
 *
 * `cli` is the agent id: a CPU dip is only news for a CLI that has no way to
 * tell us it is blocked. For claude, codex, opencode and omp — which do — the
 * heuristic is off, because guessing alongside a source that can answer
 * properly only ever produces disagreement.
 */
export function reduceAttention(
  prev: Attention,
  input: AttentionInput,
  cli: string | null,
): Attention {
  switch (input.t) {
    case "hook":
      switch (input.signal) {
        case "needs-human":
          return { kind: "blocked", since: input.at, why: "question" };
        case "needs-human-permission":
          return { kind: "blocked", since: input.at, why: "permission" };
        case "needs-human-ambiguous":
          return { kind: "blocked", since: input.at, why: "ambiguous-notice" };
        // The agent moved. Both flags are stale: the block is answered, and a
        // ring that says "something happened here" is describing something the
        // agent has since gone past.
        case "turn-start":
        case "turn-progress":
          return { kind: "none" };
        case "turn-end":
          return { kind: "unseen", since: input.at, why: "finished" };
        case "session-end":
          return { kind: "none" };
      }
      return prev;

    case "osc":
      // A notice from a terminal you are not looking at. Unlike `blocked` this
      // makes no claim about the agent's state — the CLI rang a bell, which is
      // a fact about the bell.
      return prev.kind === "blocked"
        ? prev
        : { kind: "unseen", since: input.at, why: "osc-notice" };

    case "quiet": {
      // Only for a CLI that cannot say it is blocked. This is the six-second
      // heuristic, kept for the CLIs it was written for (the Antigravity
      // permission prompt that was invisible because only some CLIs emit hook
      // events) and switched off for the ones it was firing against.
      const f = fidelityFor(cli);
      // Blind means it cannot say so by *any* route. codex raises no
      // notification at all and is still not blind: it has a dedicated
      // PermissionRequest event, which is a better answer than a CPU dip.
      const blind =
        f.structuredBlock.length === 0 &&
        f.notification !== "block" &&
        f.notification !== "mixed";
      if (!blind || prev.kind === "blocked") return prev;
      return { kind: "unseen", since: input.at, why: "went-quiet" };
    }

    case "focus":
      // Looking clears what you have not seen. It can never clear a block:
      // glancing at a tab does not answer the question on it.
      if (!input.visible) return prev;
      return prev.kind === "unseen" ? { kind: "none" } : prev;

    case "life":
      // A session that has ended has nothing outstanding. `unknown` keeps both
      // flags: losing track of an agent is not evidence that its question went
      // away.
      if (input.next.state === "ended") return { kind: "none" };
      // Live evidence that the agent is working retracts an unread ring the
      // agent itself has disproved — the "went quiet" notice that the agent
      // answered by carrying on. It does not touch a block.
      if (
        input.next.state === "working" &&
        prev.kind === "unseen" &&
        prev.why === "went-quiet"
      ) {
        return { kind: "none" };
      }
      return prev;
  }
}

/** What to put in the tooltip when something is outstanding. */
export function attentionNote(a: Attention, agent: string | null): string | null {
  const who = agent || "This agent";
  switch (a.kind) {
    case "blocked":
      return a.why === "permission"
        ? `${who} is asking permission`
        : a.why === "question"
          ? `${who} asked you a question`
          : `${who} wants your keyboard`;
    case "unseen":
      return a.why === "went-quiet"
        ? `${who} went quiet — it may be waiting on a prompt`
        : a.why === "finished"
          ? `${who} finished while you were elsewhere`
          : "Unseen activity";
    case "none":
      return null;
  }
}

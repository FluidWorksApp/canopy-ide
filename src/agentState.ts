// Moved to shared/agentLife, which both shells import: the desktop from here,
// the portal as `@shared/agentLife`. Kept as a re-export so every existing
// `from "./agentState"` still resolves and the move stays a move.
//
// What used to live here was `effectiveState`, which opened
// `if (state !== "working") return state`. That shape is why routing more
// callers through it would never have helped: it could only ever rewrite an
// over-confident "working", so a `waiting` written by a session that died on
// Tuesday passed straight through it, forever — and auto-hibernation, which
// keyed on `idle`, got a byte-identical victim set whether it consulted this
// file or not. The guard that was missing was corroboration in the *false-idle*
// direction, which is now `confidence` on the verdict.
export * from "../shared/agentLife";

// Who to send a change request about a PR to.
//
// One resolver, called by every surface that asks the question — the PR tab's
// "Raised by" row and the companion's `canopy_message_agent({pr})`. Two
// surfaces answering it differently is the bug this exists to prevent: the tab
// would offer Resume while the companion started a fresh session, and the user
// would have two agents on one PR.
//
// The rungs are the answer to "and if not?", in order. Each one is a different
// thing the caller can actually do, which is why there are four and not three:
// a session running in another Canopy window is neither reachable (no terminal
// this window can type into) nor resumable (it is *running*; a second process
// on one conversation id is how you corrupt it).

import { restoreCommand } from "./projects";
import type { ProvenanceEdge } from "./ipc";

export type PrAgentKind =
  /** Running here, with a terminal to type into. */
  | "live"
  /** Running, but in another Canopy window — readable, not reachable. */
  | "elsewhere"
  /** Not running, but the conversation and its directory both survive. */
  | "resumable"
  /** Nothing to go back to. Start something new and tell it the history. */
  | "cold";

export interface PrAgent {
  kind: PrAgentKind;
  /** The edge this came from — absent only when nothing was ever recorded. */
  edge?: ProvenanceEdge;
  sessionId?: string;
  /** Terminal to message. Only ever set for `live`. */
  ptyId?: number;
  agent?: string | null;
  /** The CLI profile the conversation belongs to. A resume that ignores it
   *  looks in the wrong config dir and fails as if the session were gone. */
  profile?: string | null;
  cwd?: string;
  /** For `resumable`: the command that reopens the conversation. */
  resumeCommand?: string;
  /** One line for the user, saying why this rung and not a better one. */
  why: string;
}

export interface ResolveContext {
  /** Every session running right now: id → its terminal, or null when it
   *  belongs to another Canopy window. */
  live: Map<string, number | null>;
  /** Whether a directory is still on disk. Resolved by the caller, because it
   *  is IO and this has to stay pure enough to test. */
  dirExists: (cwd: string) => boolean;
  /** Test seam over `restoreCommand`. */
  resumeWith?: (agent: string | null | undefined, sessionId: string) => string | null;
}

const canResume = (
  ctx: ResolveContext,
  agent: string | null | undefined,
  sessionId: string,
): string | null =>
  ctx.resumeWith
    ? ctx.resumeWith(agent, sessionId)
    : agent
      ? restoreCommand(agent, sessionId)
      : null;

const of = (edge: ProvenanceEdge, rest: Partial<PrAgent> & { kind: PrAgentKind; why: string }): PrAgent => ({
  edge,
  sessionId: edge.session_id,
  agent: edge.agent,
  profile: edge.profile,
  cwd: edge.cwd,
  ...rest,
});

/**
 * The best rung available for this PR.
 *
 * `edges` is newest first. The order of the scan matters: liveness beats
 * recency, because a session that is up and working on this PR is a better
 * place to send a change than a newer one that has exited. Only when no edge is
 * live at all does recency decide, and then the newest wins — the last session
 * to touch a PR is the one holding its current state.
 */
export function resolveAgentForPr(
  edges: ProvenanceEdge[],
  ctx: ResolveContext,
): PrAgent {
  for (const e of edges) {
    const pty = ctx.live.get(e.session_id);
    if (pty != null) {
      return of(e, { kind: "live", ptyId: pty, why: "still running here" });
    }
  }
  for (const e of edges) {
    if (ctx.live.has(e.session_id)) {
      return of(e, {
        kind: "elsewhere",
        why: "running in another Canopy window, which this one cannot type into",
      });
    }
  }
  for (const e of edges) {
    if (!e.cwd || !ctx.dirExists(e.cwd)) continue;
    const command = canResume(ctx, e.agent, e.session_id);
    if (!command) continue;
    return of(e, {
      kind: "resumable",
      resumeCommand: command,
      why: "finished, but the conversation can be reopened where it ran",
    });
  }
  // Cold, and the reason is worth being specific about: "the worktree is gone"
  // and "this CLI cannot reopen a conversation" send the user to different
  // conclusions, and "nothing was ever recorded" to a third.
  const newest = edges[0];
  if (!newest) {
    return { kind: "cold", why: "no session was ever recorded against this PR" };
  }
  const gone = !newest.cwd || !ctx.dirExists(newest.cwd);
  return of(newest, {
    kind: "cold",
    why: gone
      ? "the directory it worked in is gone, so its conversation cannot be reopened"
      : `${newest.agent ?? "that agent"} cannot reopen a conversation by id`,
  });
}

/** Can the caller put a message in front of this agent without starting
 *  anything? Only the live rung — every other one spawns a process, which is a
 *  different decision and, for the companion, one that goes through the gate. */
export const isReachable = (a: PrAgent): a is PrAgent & { ptyId: number } =>
  a.kind === "live" && a.ptyId != null;

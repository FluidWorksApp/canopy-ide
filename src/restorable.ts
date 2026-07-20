// Which past agent sessions can be reopened, and how.
//
// Extracted so the Agents panel and the project's empty state agree: a session
// listed as restorable in one place and missing in the other is worse than
// either behaviour on its own.
import * as ipc from "./ipc";
import { restoreCommand } from "./projects";

export interface Restorable {
  digest: ipc.SessionDigest;
  agentId: string;
  /** Directory the resume command must run in — see resume_cwd in agents.rs. */
  cwd: string;
  /** The command that reopens it, or null when the CLI can't reopen by id. */
  command: string | null;
  /** Recognisable label: the last thing the human actually typed. */
  prompt: string;
}

/** The last human-authored prompt — tool output and injected context both
 *  start with '<', and a session is recognised by what you asked it. */
const lastHumanPrompt = (prompts?: string[]) =>
  [...(prompts ?? [])].reverse().find((p) => p.trim() && !p.trimStart().startsWith("<"));

/**
 * Sessions worth offering to restore, newest first.
 *
 * Dead is not the same as quiet: `liveSessionIds` only knows which sessions
 * spoke during this app run, so one that has since exited would stay "live"
 * forever on that signal alone. `surface` is the pty id the hook recorded from
 * our spawn env, so a surface absent from `stats` is genuinely gone.
 */
export function restorableFrom(
  digests: ipc.SessionDigest[],
  stats: ipc.SessionStats[],
  liveSessionIds: string[],
): Restorable[] {
  const alivePtys = new Set(stats.map((s) => String(s.id)));
  const dead = (d: ipc.SessionDigest) => !!d.surface && !alivePtys.has(d.surface);
  return digests
    .filter(
      (d) =>
        d.session_id &&
        !/-pty\d*$/.test(d.session_id) &&
        (dead(d) || !liveSessionIds.includes(d.session_id)) &&
        // Claude writes no transcript until the first prompt, so a promptless
        // claude session can only fail to resume. Other agents capture
        // prompts best-effort, so an empty list there must not hide a real
        // conversation.
        ((d.prompts?.length ?? 0) > 0 || (d.agent ?? "claude") !== "claude"),
    )
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .map((digest) => {
      const agentId = digest.agent ?? "agent";
      return {
        digest,
        agentId,
        cwd: digest.resume_cwd || digest.cwd || "",
        command:
          digest.resumable === false ? null : restoreCommand(agentId, digest.session_id),
        prompt: lastHumanPrompt(digest.prompts) ?? "",
      };
    });
}

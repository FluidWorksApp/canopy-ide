// Which past agent sessions can be reopened, and how.
//
// Extracted so the Agents panel and the project's empty state agree: a session
// listed as restorable in one place and missing in the other is worse than
// either behaviour on its own.
import * as ipc from "./ipc";
import { restoreCommand } from "./projects";
import { identifyAgent } from "./agentIdentity";

export interface Restorable {
  digest: ipc.SessionDigest;
  agentId: string;
  /** Directory the resume command must run in — see resume_cwd in agents.rs. */
  cwd: string;
  /** The command that reopens it. Never null: a session with no way back is
   *  filtered out rather than listed as an offer you can't take. */
  command: string;
  /** Recognisable label: the last thing the human actually typed. */
  prompt: string;
  /** The account it ran under, so the restore uses the same config dir. */
  profile: string;
  /** Older sessions in this same directory, which this row stands in for. Not
   *  offered — but "forget" has to tombstone them too, or dismissing the row
   *  just promotes the next one and you dismiss the same directory 64 times. */
  superseded: ipc.SessionDigest[];
}

/**
 * Where a resume of this session has to run.
 *
 * Never `cwd` on its own. That is where the agent was when it last reported,
 * and it moves: an agent that cds, a session Canopy relocates into a worktree,
 * or — the one that bites — a resume that already went to the wrong place and
 * whose hooks then wrote *that* directory back onto the digest. Agents that
 * namespace a conversation by directory (claude, gemini, cursor) only find it
 * again from the directory it was filed under, so resuming from a drifted cwd
 * answers "No conversation found".
 *
 * `resume_cwd` is the backend's verified answer (agents.rs): the directory
 * whose encoding is the bucket actually holding the transcript. `launch_cwd` is
 * the next best thing when a digest predates it, and `cwd` the last resort.
 *
 * One function because every surface that spawns a resume has to agree — the
 * restorable list already did, and the palette and the message-an-agent path
 * did not, which is how the same session opened in two different directories.
 */
export const resumeCwd = (
  digest: ipc.SessionDigest | undefined,
  fallback = "",
): string =>
  digest?.resume_cwd || digest?.launch_cwd || digest?.cwd || fallback;

/** The last human-authored prompt — tool output and injected context both
 *  start with '<', and a session is recognised by what you asked it. */
const lastHumanPrompt = (prompts?: string[]) =>
  [...(prompts ?? [])].reverse().find((p) => p.trim() && !p.trimStart().startsWith("<"));

/** When Restore was clicked, per session. This is a bridge, not a tombstone:
 *  it hides the row for the moment between the click and the agent actually
 *  appearing in the process list. Once the agent IS visible the mark is
 *  dropped, so closing that terminal brings the row straight back — a
 *  restorable session belongs wherever the work currently is, not wherever it
 *  was when the app started. */
const restoredAt = new Map<string, number>();

/** Long enough to cover a CLI booting; short enough that a restore which
 *  never produced a process doesn't hide the row for the rest of the run. */
const RESTORE_GRACE_MS = 90_000;

export function markRestored(sessionId: string) {
  restoredAt.set(sessionId, Date.now());
}

/** Sessions the user has explicitly forgotten, keyed to the transcript mtime at
 *  the moment they forgot it. Persisted, unlike `restoredAt` — a forget must
 *  survive the poll that re-reads digests from disk, or the row just comes
 *  straight back (which it did). Keyed by timestamp, not a bare tombstone, so
 *  "forget" means "I'm done with this stale one": if the same session is later
 *  written to again (real new activity, a higher mtime) it returns. */
const FORGOTTEN_KEY = "canopy.forgotten-sessions";

function readForgotten(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FORGOTTEN_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function writeForgotten(store: Record<string, number>) {
  try {
    localStorage.setItem(FORGOTTEN_KEY, JSON.stringify(store));
  } catch {
    // A lost convenience record is not worth interrupting anyone over.
  }
}

/** Forget one or more restorable sessions so they stop resurfacing. Pass the
 *  digests as seen now; their `updated` mtime is the reappear threshold. */
export function forgetSessions(digests: ipc.SessionDigest[]) {
  const store = readForgotten();
  for (const d of digests) {
    if (d.session_id) store[d.session_id] = d.updated ?? Number.MAX_SAFE_INTEGER;
  }
  writeForgotten(store);
}

interface LiveAgent {
  agentId: string;
  cwd: string;
}

/** Agent CLIs running right now, by registry id and working directory.
 *  Reads the same identity the panel does (agentIdentity.ts), so the two
 *  surfaces can never disagree about what is already running. */
function liveAgentsFrom(stats: ipc.SessionStats[]): LiveAgent[] {
  return stats.flatMap((s) => {
    const id = identifyAgent(s.agent_hint)?.id;
    return id ? [{ agentId: id, cwd: s.cwd }] : [];
  });
}

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
  const forgotten = readForgotten();
  const dead = (d: ipc.SessionDigest) => !!d.surface && !alivePtys.has(d.surface);
  const liveAgents = liveAgentsFrom(stats);
  // Same CLI, same directory, running right now — that work is open, whatever
  // its session id. This is the only signal for agents whose sessions are read
  // from disk rather than reported through hooks (omp), and it is what makes
  // the row come back the moment the terminal closes.
  const runningHere = (d: ipc.SessionDigest) => {
    const dir = resumeCwd(d);
    if (!dir) return false;
    return liveAgents.some((a) => a.cwd === dir && a.agentId === (d.agent ?? "claude"));
  };
  const rows = digests
    .filter((d) => {
      const id = d.session_id;
      if (!id || /-pty\d*$/.test(id)) return false;

      // A one-shot task, finished the moment it ended — restoring it would run
      // it again. The app also deletes these digests when the task's terminal
      // closes, but that is a timer racing the CLI's last write and neither
      // survives a force quit; the marker is on the session itself.
      if (d.micro) return false;

      // Forgotten by the user, and the transcript hasn't been written since —
      // stay gone. A newer mtime (real new activity) crosses the threshold and
      // brings it back.
      const forgottenAt = forgotten[id];
      if (forgottenAt != null && (d.updated ?? 0) <= forgottenAt) return false;

      // Open right now — it belongs in the running list, not this one.
      if (runningHere(d) || (!dead(d) && liveSessionIds.includes(id))) {
        // The process is visible, so the click-time mark has done its job.
        // Dropping it here is what lets the row return when this terminal is
        // closed, instead of staying hidden for the rest of the run.
        restoredAt.delete(id);
        return false;
      }

      // Just restored and the process hasn't shown up yet.
      const clicked = restoredAt.get(id);
      if (clicked != null) {
        if (Date.now() - clicked < RESTORE_GRACE_MS) return false;
        // It never materialised — stop hiding it.
        restoredAt.delete(id);
      }

      // Claude writes no transcript until the first prompt, so a promptless
      // claude session can only fail to resume. Other agents capture prompts
      // best-effort, so an empty list there must not hide a real conversation.
      return (d.prompts?.length ?? 0) > 0 || (d.agent ?? "claude") !== "claude";
    })
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .map((digest) => {
      const agentId = digest.agent ?? "agent";
      return {
        digest,
        agentId,
        cwd: resumeCwd(digest),
        command:
          digest.resumable === false ? null : restoreCommand(agentId, digest.session_id),
        prompt: lastHumanPrompt(digest.prompts) ?? "",
        profile: digest.profile || "default",
      };
    })
    // No command, no offer. Both surfaces that read this are lists of things
    // you can pick back up — a row whose only working control is "forget" is
    // asking to be dismissed, not resumed. The session isn't lost: it stays in
    // the digests, and comes back here the moment it's resumable again (a
    // transcript written under a directory we can reach, a CLI that learns to
    // reopen by id).
    .filter((r): r is Omit<Restorable, "superseded"> => r.command !== null);
  return newestPerDirectory(rows);
}

/**
 * One row per (agent, account, directory) — the newest, since the list arrives
 * sorted. The rest of that directory's sessions ride along as `superseded`.
 *
 * A long-lived checkout accrues one digest per conversation and they all share
 * a cwd: this repo had 64 claude sessions under a single directory. Offering
 * every one made a list nobody reads and a "Restore all" that would start 64
 * agents at once. The one you want in a directory is the last one you were in;
 * the others stay on disk, this only stops offering them.
 *
 * The account is part of the key because two logins are meant to sit side by
 * side: collapsing a work session and a personal one in the same checkout into
 * a single row would offer one of them and quietly bury the other, and each
 * only resumes under the config dir it was written in.
 */
function newestPerDirectory(rows: Omit<Restorable, "superseded">[]): Restorable[] {
  const byDir = new Map<string, Restorable>();
  for (const r of rows) {
    // \0 as the separator: it cannot appear in a path, so no directory name
    // can be built that collides with another agent's key.
    const key = `${r.agentId}\0${r.profile}\0${r.cwd}`;
    const held = byDir.get(key);
    if (held) held.superseded.push(r.digest);
    else byDir.set(key, { ...r, superseded: [] });
  }
  return [...byDir.values()];
}

// A restore the agent CLI itself refused, and the terminal it leaves behind.
//
// Restore runs the CLI's own `--resume <id>`. When that id no longer names a
// conversation the CLI prints one line — "No conversation found with session
// ID: …" — exits, and leaves a shell sitting in a tab nobody asked for, on a
// row that will offer the same doomed button again tomorrow. Neither end of
// that is worth a click: the CLI has already given its verdict, in writing.
//
// What this must never do is reap something alive, so all three of these have
// to hold. Each one alone has a way of being wrong:
//
//  1. The CLI's own refusal, naming the id we asked it to reopen. Not "the
//     terminal looks empty", not "it went quiet" — quiet is what a model
//     thinking looks like (shared/agentLife). A refusal is proven dead; a
//     silence is unknown, and unknown is never dead.
//  2. Nothing agent-shaped in the pty's foreground. The phrase is just text:
//     an agent reading this very file prints it. If a CLI is running in there,
//     whatever said it, it wasn't a failed resume.
//  3. The human has never typed into this terminal. `since_input_ms` is null
//     until the first keystroke, so this is a fact, not a threshold — one
//     keystroke means someone adopted the shell, and a tab someone is using is
//     not litter.
//
// The reap itself is deliberately the reversible half of "Forget": the row is
// tombstoned at the transcript's current mtime, so a session that is genuinely
// written to again comes back. Nothing on disk is deleted — the user's own
// Forget button does that, and an automatic action should not.

/** What the CLI said, and what its terminal is doing now. */
export interface RestoreOutcome {
  /** Everything the pty has emitted, escape sequences and all. */
  output: string;
  /** The session id the restore command asked the CLI to reopen. */
  sessionId: string;
  /** An agent CLI is in this pty's foreground right now. */
  agentRunning: boolean;
  /** ms since the human last typed into this terminal; null = never has. */
  sinceInputMs: number | null;
}

/** How often the watcher asks the pty what it has said. Slow on purpose: this
 *  is a courtesy sweep, not a progress bar, and the answer it waits for is a
 *  CLI that has already exited. */
export const RESTORE_PROBE_MS = 2500;

/** How long a restore stays under watch. A resume that hasn't failed by now
 *  succeeded — the agent is up and the tab belongs to the user. */
export const RESTORE_WATCH_MS = 30_000;

/** Escape sequences, so a refusal printed in red still matches as text. */
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[\]()#;?]*[0-9;?]*[ -/]*[@-~]/g;

/** The refusals we have actually seen a CLI print. Only claude's is verified,
 *  and a wrong string here means either a tab that never reaps (harmless) or
 *  one reaped for the wrong reason (not) — so nothing goes in this list on a
 *  guess about another CLI's wording. */
const REFUSALS = [/no conversation found/i];

/** Did the CLI refuse to reopen *this* session?
 *
 *  Both halves are required: the phrase alone could come from anything on a
 *  terminal, and the id alone is in the echoed command of every restore. */
export function refusedResume(output: string, sessionId: string): boolean {
  const id = sessionId.trim();
  if (!id) return false;
  const text = output.replace(ANSI, "");
  return text.includes(id) && REFUSALS.some((r) => r.test(text));
}

/** Does this restore take itself away? */
export function reapsFailedRestore(o: RestoreOutcome): boolean {
  // Something is running in there — the refusal, if any, isn't this pty's own
  // ending.
  if (o.agentRunning) return false;
  // Someone typed into it. Whatever it was opened for, it is theirs now.
  if (o.sinceInputMs != null) return false;
  return refusedResume(o.output, o.sessionId);
}

export interface RestoreWatch {
  /** The session id the restore command carries. */
  sessionId: string;
  /** The pty the restore is running in; null before it spawns, and once it is
   *  gone. */
  ptyId: () => number | null;
  /** That pty's output so far. Null when it can no longer be read. */
  read: (ptyId: number) => Promise<string | null>;
  /** What the pty is doing now; undefined until it appears in the stats. */
  look: (
    ptyId: number,
  ) => Pick<RestoreOutcome, "agentRunning" | "sinceInputMs"> | undefined;
  /** Take the row and the tab away. Called at most once. */
  reap: () => void;
}

/**
 * Watch one restore until it either fails or stops being interesting, and
 * return the cancel that stops watching.
 *
 * Polls rather than reading the byte stream: the terminal's hot path fans out
 * to xterm under backpressure, and a string search per chunk on every terminal
 * in the app is a real cost paid forever to catch a line that appears at most
 * once, seconds after a click.
 */
export function watchFailedRestore(w: RestoreWatch): () => void {
  const deadline = Date.now() + RESTORE_WATCH_MS;
  let inflight = false;
  let timer: number | undefined;
  const stop = () => {
    if (timer != null) clearInterval(timer);
    timer = undefined;
  };
  const tick = async () => {
    if (Date.now() > deadline) return stop();
    // Overlapping probes would read the same output twice and could reap
    // twice; one at a time, and a slow read just skips a beat.
    if (inflight) return;
    const pty = w.ptyId();
    if (pty == null) return;
    const now = w.look(pty);
    if (!now) return;
    inflight = true;
    try {
      const output = await w.read(pty);
      if (timer == null) return; // cancelled while we were reading
      if (output == null) return;
      if (reapsFailedRestore({ ...now, output, sessionId: w.sessionId })) {
        stop();
        w.reap();
      }
    } catch {
      // A pty that can't be read is one we know nothing about. Try again.
    } finally {
      inflight = false;
    }
  };
  timer = setInterval(() => void tick(), RESTORE_PROBE_MS) as unknown as number;
  return stop;
}

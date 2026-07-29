// How much of a brief can be typed at a shell prompt, and what to do with the
// rest of it.
//
// A new agent is started by typing its command into a freshly spawned shell —
// `claude '<the whole brief>'` followed by a carriage return (Term.tsx, and
// spawn_headless for the remote path). That works until the line gets long,
// and then it fails in the worst way available: silently, and only past a
// certain size.
//
// The terminal is still in canonical mode at that moment — the shell's line
// editor has not taken over yet — and a canonical-mode tty discards everything
// past MAX_CANON on a single line. MAX_CANON is 1024 on Darwin. So a brief that
// crosses 1024 BYTES arrives at the shell cut mid-word, which for a
// single-quoted command means the closing quote is gone: the shell sits at a
// `quote>` continuation prompt, the agent never starts, and nothing anywhere
// reports an error, because from our side the write succeeded.
//
// Four screenshots with their paths and notes is about 1200 bytes, so this is
// reachable by simply using the feature.
//
// The fix is not to type less — a brief that has been trimmed to fit is a brief
// that has lost the thing it was about. It is to stop putting long text on the
// command line at all: write it to a file and start the agent pointed at the
// file, which is what the screenshots themselves already do.

/** Darwin's MAX_CANON: the most a canonical-mode tty will hold for one line
 *  before it starts dropping. Linux allows 4096; the smaller number is the one
 *  that has to hold. */
export const MAX_CANON = 1024;

/** What we allow ourselves of it. The shell echoes as it reads and the CR is
 *  written separately, so aiming at the exact ceiling would be betting on the
 *  boundary — and the cost of being under it is one file write. */
export const SAFE_LINE_BYTES = 900;

/** Bytes, not characters. The brief that first hit this was 1012 characters and
 *  1024 bytes: em-dashes and arrows are three bytes each, so a length check in
 *  characters would have called it safe. */
export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Can this command line be typed at a shell prompt and arrive whole? */
export function fitsOnOneLine(command: string): boolean {
  return byteLength(command) + 1 <= SAFE_LINE_BYTES;
}

/** The command line to use instead, when it can't. The brief is on disk; this
 *  is the sentence that sends the agent to it.
 *
 *  Deliberately imperative and self-contained: it is the entire prompt the
 *  agent receives, so it has to say what the file is as well as where. */
export function briefPointer(path: string): string {
  return (
    `Read ${path} — a brief written for you, in full — and do everything it asks. ` +
    `It names the files to look at and the change to make.`
  );
}

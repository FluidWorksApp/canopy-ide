// Warnings and errors written in the webview reach the app's error log
// (errors.log beside resilience.log, see lib.rs). Without this a release build
// keeps no trace of a failure that only ever reached the console, which is how
// a failed remote open left nothing behind to read.
//
// Bounded on purpose: a loop that warns every frame must not fill the disk or
// flood the IPC channel. Lines are cut short here and cleaned again natively.

const MAX_LINE = 600;
const PER_MINUTE = 30;

type Write = (level: "warn" | "error", message: string) => void;

function text(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.message || String(arg);
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LINE);
}

/** Forward console.warn / console.error to `write`, at most `PER_MINUTE` lines
 *  a minute, repeats of the previous line dropped within the minute. Returns the undo. */
export function forwardConsole(
  write: Write,
  target: Pick<Console, "warn" | "error"> = console,
  now: () => number = () => Date.now(),
): () => void {
  const original = { warn: target.warn, error: target.error };
  let windowStart = 0;
  let count = 0;
  let last = "";
  let inside = false;
  const wrap = (level: "warn" | "error") =>
    function (this: unknown, ...args: unknown[]) {
      original[level].apply(this ?? target, args);
      // A warning raised while forwarding must not forward itself.
      if (inside) return;
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        count = 0;
        // A failure that keeps coming back is written again once a minute.
        last = "";
      }
      const line = text(args);
      if (!line || line === last) return;
      if (count >= PER_MINUTE) return;
      count++;
      last = line;
      inside = true;
      try {
        write(level, line);
      } catch {
        /* The log is best effort. */
      } finally {
        inside = false;
      }
    };
  target.warn = wrap("warn");
  target.error = wrap("error");
  return () => {
    target.warn = original.warn;
    target.error = original.error;
  };
}

// Reading a path for display, on both kinds of machine.
//
// Every surface that names a directory — a component row, a project tab, a
// terminal, a claim, a changed file — wants the last segment of a path, and
// they each wrote it as `p.split("/").pop()`. That is correct on macOS and
// Linux and wrong on Windows, where the separator is a backslash and the split
// finds nothing to cut: the whole path comes back as the "name". So a Windows
// user saw `C:\USERS\CORAA\DESKTOP\PROJECT` where a Mac user sees `Project`,
// in the components list, the project tab, the terminal chips — everywhere at
// once, because the same wrong line had been written twenty times.
//
// Node's `path.posix`/`path.win32` would answer this, but this code runs in the
// webview, where there is no `path`. So: one pair of functions, here, taking
// both separators, and a guard test (pathsGuard.test.ts) that keeps the
// twenty-first copy from being written.

/** The last segment of a path — the name you show. Trailing separators are
 *  ignored, so `C:\work\app\` and `/work/app/` both read `app`. */
export function basename(p?: string | null): string {
  if (!p) return "";
  const trimmed = p.replace(/[\\/]+$/, "");
  const cut = trimmed.split(/[\\/]/).filter(Boolean).pop();
  // A bare root (`/`, `C:\`) has no last segment; the path itself is the only
  // honest answer, and it is short enough to show.
  return cut ?? p;
}

/** Everything above the last segment. Empty when there is nothing above it. */
export function dirname(p?: string | null): string {
  if (!p) return "";
  const trimmed = p.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at <= 0 ? "" : trimmed.slice(0, at);
}

/** The last `count` segments, for a row that has space for more than a name but
 *  not for a home directory. Keeps the path's own separator so it still looks
 *  like the machine it came from. */
export function tailPath(p?: string | null, count = 2): string {
  if (!p) return "";
  const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-count).join(sep);
}

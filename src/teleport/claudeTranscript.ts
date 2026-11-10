/**
 * Teleport groundwork: moving a Claude Code session between machines, and
 * recording how Codex differs. Verified read-only on this Mac on 2026-11-10
 * (structure only, never conversation text). Nothing here runs a CLI.
 *
 * CLAUDE (implemented below)
 *  - Store: ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl, one JSON object
 *    per line. Across 44 session files, every line carrying `sessionId` carried
 *    the file's own name (minus .jsonl). Some line types carry none.
 *  - Directory name: the cwd with every character outside [A-Za-z0-9] replaced
 *    by "-" (so "/", ".", "_" and an existing "-" all become "-"; a leading
 *    "/." gives "--"). 4704 recorded cwds matched their directory by this rule.
 *    NOT verified: spaces, non-ASCII, and very long paths (the longest
 *    directory name seen is 83 characters, so any truncation rule is unseen).
 *  - A session's cwd can differ from its directory: `cd` inside a session
 *    changes the recorded cwd (314 of ~5000 lines), so the destination
 *    directory is derived from the session's launch cwd, not from every line.
 *  - Fields that carry a working directory (all string-valued):
 *      cwd                                  on user, assistant, system, attachment lines
 *                                           (also nested git_state.cwd: any key named cwd)
 *      attachment.snapshot.workingDirectory
 *      serverClassifierContext.context.live_cwd           (user lines)
 *      api-request ... classifier_context.live_cwd        (api-request lines)
 *    Many other fields hold paths that merely sit under the cwd (tool inputs
 *    and results, git_state.root, trusted_directories, scratchpad dirs).
 *    Those are history, not launch state, and are left alone.
 *  - Resume: src/projects.ts spells it `claude --resume <sessionId>` (by id,
 *    verified against `--help`). The structured runner does the same. Whether
 *    the CLI then looks the id up ONLY under the current cwd's directory is
 *    not verified here (no `claude --resume` was run); we assume it does, which
 *    is why the file is stored under the destination cwd's directory.
 *
 * CODEX (not implemented)
 *  - Store: ~/.codex/sessions/YYYY/MM/DD/rollout-<local timestamp>-<thread
 *    uuid>.jsonl, and archived ones as ~/.codex/archived_sessions/rollout-*.jsonl.zst.
 *    Keyed by thread id and date, NOT by cwd, so no path move is needed.
 *  - A cwd IS recorded: `session_meta` payload.cwd (plus runtime_workspace_roots,
 *    git) on line 1, and `turn_context` payload.cwd on each turn. Lines look like
 *    {timestamp, ordinal, type, payload}. Resume is `codex resume <id>`.
 *  - Not verified: whether Codex also indexes threads in its sqlite state
 *    (state_5.sqlite, session_index.jsonl), which a copied rollout may need.
 */

/** Directory name Claude uses under ~/.claude/projects for a working directory. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertPosixAbsolute(label: string, p: string): void {
  if (!p.startsWith("/") || /[\u0000-\u001f]/.test(p)) throw new Error(`${label} must be an absolute POSIX path`);
}

/** `${home}/.claude/projects/<encoded cwd>/<sessionId>.jsonl` on the machine whose home is `home`. */
export function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string {
  assertPosixAbsolute("home", home);
  assertPosixAbsolute("cwd", cwd);
  // The id becomes a filename: no separators, dots-only, or traversal.
  if (!SESSION_ID.test(sessionId)) throw new Error("sessionId is not a safe session id");
  return `${home.replace(/\/+$/, "")}/.claude/projects/${claudeProjectDirName(cwd)}/${sessionId}.jsonl`;
}

/** Keys whose string value is a working directory (see the field list above). */
const CWD_KEYS = ["cwd", "live_cwd", "workingDirectory"];
// A structural `"key":"value"` pair in raw JSON text. A quote inside a string
// value is always escaped as \", so `"cwd":"` can only be a real key here.
const CWD_PAIR = new RegExp(`"(${CWD_KEYS.join("|")})"(\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`, "g");

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Move `value` from under `from` to under `to`; null when it is not under `from`. */
function remap(value: string, from: string, to: string): string | null {
  if (value === from) return to;
  const prefix = from === "/" ? "/" : `${from}/`;
  if (!value.startsWith(prefix)) return null;
  return (to === "/" ? "" : to) + "/" + value.slice(prefix.length);
}

export interface MapTranscriptInput {
  transcript: string;
  sourceCwd: string;
  destCwd: string;
  /** When given, every line's own sessionId must equal it. */
  sessionId?: string;
}

export interface MapTranscriptResult {
  /** The rewritten transcript. Lines without a changed cwd are byte-identical. */
  text: string;
  /** Session id found in the transcript (all lines that carry one agree). */
  sessionId: string | null;
  lines: number;
  /** cwd values moved to the destination. */
  rewritten: number;
  /** cwd values not under sourceCwd (e.g. the session `cd`-ed elsewhere); left as is. */
  outsideSource: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string value stored under a cwd key, anywhere in the line. */
function collectCwdValues(v: unknown, out: string[]): void {
  if (Array.isArray(v)) return v.forEach((x) => collectCwdValues(x, out));
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (CWD_KEYS.includes(k) && typeof x === "string") out.push(x);
    else collectCwdValues(x, out);
  }
}

/**
 * Rewrite a Claude transcript for another cwd. Throws (fails closed) on any
 * line that is not a JSON object, on a mismatching sessionId, and when the
 * textual rewrite and a parsed walk disagree about how many values to move.
 * Only the bytes of the changed cwd strings differ from the input.
 */
export function mapClaudeTranscript(input: MapTranscriptInput): MapTranscriptResult {
  assertPosixAbsolute("sourceCwd", input.sourceCwd);
  assertPosixAbsolute("destCwd", input.destCwd);
  const from = trimSlash(input.sourceCwd);
  const to = trimSlash(input.destCwd);

  // Splitting on "\n" and rejoining keeps every other byte, including \r.
  const parts = input.transcript.split("\n");
  let sessionId: string | null = null;
  let lines = 0;
  let rewritten = 0;
  let outsideSource = 0;

  const out = parts.map((line, i) => {
    if (line === "" && i === parts.length - 1) return line; // final newline
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`transcript line ${i + 1} is not valid JSON`);
    }
    if (!isObj(parsed)) throw new Error(`transcript line ${i + 1} is not a JSON object`);
    lines++;

    const sid = parsed.sessionId;
    if (sid !== undefined) {
      if (typeof sid !== "string") throw new Error(`transcript line ${i + 1} has a non-string sessionId`);
      if ((input.sessionId ?? sessionId) !== null && (input.sessionId ?? sessionId) !== sid) {
        throw new Error(`transcript line ${i + 1} belongs to a different session`);
      }
      sessionId = sid;
    }

    const expected: string[] = [];
    collectCwdValues(parsed, expected);
    if (expected.length === 0) return line;

    let moved = 0;
    let seen = 0;
    const next = line.replace(CWD_PAIR, (whole, key: string, sep: string, raw: string) => {
      seen++;
      const mapped = remap(JSON.parse(`"${raw}"`) as string, from, to);
      if (mapped === null) return whole;
      moved++;
      return `"${key}"${sep}${JSON.stringify(mapped)}`;
    });
    if (seen !== expected.length) throw new Error(`transcript line ${i + 1}: could not locate every cwd field safely`);
    rewritten += moved;
    outsideSource += seen - moved;
    if (moved === 0) return line;
    try {
      JSON.parse(next);
    } catch {
      throw new Error(`transcript line ${i + 1}: rewrite produced invalid JSON`);
    }
    return next;
  });

  return { text: out.join("\n"), sessionId, lines, rewritten, outsideSource };
}

// The machine channel: run a command, and move files, on any machine this
// person works on, from one place.
//
// A person with a Mac and a faster machine elsewhere wants the heavy work (a
// compile, a test suite) done over there and the result back here, where the
// phone is plugged in. Three primitives cover it, and everything larger
// (sync.ts, recipe.ts) is built from them:
//
//   run   a command in a checkout on a machine, and its exit code and output;
//   copy  a file or a folder from a checkout on one machine to another;
//   sync  one checkout's working tree onto another machine's (sync.ts).
//
// A machine here is only an `invoke`: this Mac's own host, the window's
// workspace, or a second connection opened beside it (environments/live.ts).
// Nothing new has to be installed on a workspace for this to work: running
// goes through the check runner both hosts already have (`receipt_run_check`:
// a separate process, its own process group, a timeout, the output tail) and a
// workspace's files through its existing range read and upload. Only this
// Mac's side needed new commands (src-tauri/src/machine_channel.rs), because
// the desktop had no way to read or write a slice of a binary file.
//
// The window composes these, so the two machines never have to reach each
// other: each only ever talks to the window that is connected to both.
import { Sha256 } from "./sha256";
import type { Invoke } from "./repoIdentity";

export interface ChannelMachine {
  /** "local" for the computer showing the IDE, else the workspace id. */
  id: string;
  name: string;
  invoke: Invoke;
  /** The desktop app's own host rather than a workspace host. They serve
   *  files through different commands. */
  desktop: boolean;
  /** Connected view-only: nothing may be run or written there. */
  readOnly?: boolean;
}

/** A refusal or failure the person (or the agent) can act on. `detail` holds
 *  the evidence: a command's output, the files in the way. */
export class ChannelError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ChannelError";
    this.detail = detail;
  }
}

export interface RunRequest {
  cwd: string;
  argv: string[];
  env?: [string, string][];
  /** Default five minutes; the hosts stop a run at twenty. */
  timeoutMs?: number;
  /** How much of each stream to keep (64 KB by default, 1 MB at most). */
  keepBytes?: number;
  /** Keep the start of the output rather than the end. */
  head?: boolean;
}

export interface RunResult {
  /** null when the run was killed (timeout) or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** The program could not be started at all. */
  spawnError: string | null;
}

/** The longest one run may take: the ceiling both hosts enforce. */
export const RUN_CEILING_MS = 20 * 60 * 1000;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function writable(machine: ChannelMachine, what: string): void {
  if (machine.readOnly) throw new ChannelError(`${machine.name} is connected view-only, so ${what} there is not possible.`);
}

/** Run one command on a machine. A non-zero exit is a result, not an error. */
export async function runOn(machine: ChannelMachine, request: RunRequest): Promise<RunResult> {
  writable(machine, "running a command");
  if (!request.argv.length || !request.argv[0].trim()) throw new ChannelError("There is no command to run.");
  if (!request.cwd.startsWith("/")) throw new ChannelError(`Not a folder on ${machine.name}: ${request.cwd || "(none)"}`);
  let raw: Partial<RunResult>;
  try {
    raw = await machine.invoke<Partial<RunResult>>("receipt_run_check", {
      cwd: request.cwd,
      argv: request.argv,
      timeoutMs: Math.min(RUN_CEILING_MS, Math.max(1000, request.timeoutMs ?? 5 * 60 * 1000)),
      ...(request.keepBytes ? { keepBytes: request.keepBytes } : {}),
      ...(request.head ? { head: true } : {}),
      ...(request.env?.length ? { env: request.env } : {}),
    });
  } catch (error) {
    throw new ChannelError(`${machine.name} could not run the command: ${String((error as { message?: string })?.message ?? error)}`);
  }
  return {
    code: typeof raw?.code === "number" ? raw.code : null,
    stdout: text(raw?.stdout),
    stderr: text(raw?.stderr),
    stdoutTruncated: raw?.stdoutTruncated === true,
    stderrTruncated: raw?.stderrTruncated === true,
    timedOut: raw?.timedOut === true,
    durationMs: typeof raw?.durationMs === "number" ? raw.durationMs : 0,
    spawnError: typeof raw?.spawnError === "string" && raw.spawnError ? raw.spawnError : null,
  };
}

/** A shell script with positional arguments. The arguments never pass through
 *  the shell's parser, so a path with a space or a quote in it is just a path. */
export function shOn(
  machine: ChannelMachine,
  cwd: string,
  script: string,
  args: readonly string[] = [],
  opts: Omit<RunRequest, "cwd" | "argv"> = {},
): Promise<RunResult> {
  return runOn(machine, { ...opts, cwd, argv: ["sh", "-c", script, "canopy", ...args] });
}

/** What went wrong in a run, in one line, for a message. */
export function runFailure(result: RunResult): string | null {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return "it ran out of time and was stopped";
  if (result.code !== 0) return `it exited with ${result.code === null ? "a signal" : `code ${result.code}`}`;
  return null;
}

/** A script that must succeed; its stdout. */
export async function mustSh(
  machine: ChannelMachine,
  cwd: string,
  script: string,
  args: readonly string[] = [],
  what = "a step",
  opts: Omit<RunRequest, "cwd" | "argv"> = {},
): Promise<string> {
  const result = await shOn(machine, cwd, script, args, { head: true, ...opts });
  const failure = runFailure(result);
  if (failure) throw new ChannelError(`${what} on ${machine.name} failed: ${failure}`, (result.stderr || result.stdout).trim().slice(-2000));
  return result.stdout;
}

/** `key=value` lines, as the scripts here print them. A key printed more than
 *  once keeps every value (`all`). */
export function parseFields(out: string): { one: Record<string, string>; all: Record<string, string[]> } {
  const one: Record<string, string> = {};
  const all: Record<string, string[]> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    one[key] = value;
    (all[key] ??= []).push(value);
  }
  return { one, all };
}

// ---- paths -----------------------------------------------------------------

/** A path inside a checkout, as an agent or a recipe names it: relative, with
 *  no way out of the checkout and no way into its git directory. */
export function safeRelativePath(path: string): string {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) throw new ChannelError("A path is needed.");
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("~")) {
    throw new ChannelError(`Paths are relative to the repository: "${path}" is not.`);
  }
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (!parts.length) throw new ChannelError("A path is needed.");
  if (parts.includes("..")) throw new ChannelError(`"${path}" leaves the repository.`);
  if (parts[0] === ".git") throw new ChannelError("The git directory is not copied; use sync for repository state.");
  return parts.join("/");
}

/** Path segments joined with single slashes. */
export const joinPath = (root: string, ...rest: string[]): string =>
  rest.reduce((path, part) => `${path.replace(/\/+$/, "")}/${part}`, root);
const join = joinPath;
const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

// ---- files -----------------------------------------------------------------

/** One slice on the wire. A workspace takes at most 256 KB per upload chunk. */
const WORKSPACE_CHUNK = 256 * 1024;
/** Between a workspace and this Mac the reader's own limit (1 MB) is the bound. */
const DESKTOP_CHUNK = 768 * 1024;
/** Nothing larger is copied: a wrong path must not fill a disk. */
export const MAX_COPY_BYTES = 4 * 1024 ** 3;

function bytesOf(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Bytes `offset .. offset+length` of `root/rel`, and the file's whole size. */
async function readSlice(
  machine: ChannelMachine,
  root: string,
  rel: string,
  offset: number,
  length: number,
): Promise<{ b64: string; size: number }> {
  const slice = machine.desktop
    ? await machine.invoke<{ b64: string; size: number }>("machine_file_read", { root, path: rel, offset, length })
    : await machine.invoke<{ b64: string; size: number }>("fs_read_range", { path: join(root, rel), offset, length });
  if (typeof slice?.b64 !== "string" || typeof slice.size !== "number") throw new ChannelError(`${machine.name} did not return the file.`);
  return slice;
}

interface Writer {
  write(b64: string, offset: number): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

async function openWriter(
  machine: ChannelMachine,
  root: string,
  rel: string,
  size: number,
  mode: number,
): Promise<Writer> {
  writable(machine, "writing a file");
  if (machine.desktop) {
    let written = 0;
    return {
      async write(b64, offset) {
        const ack = await machine.invoke<{ written: number }>("machine_file_write", { root, path: rel, offset, b64, done: false, mode });
        written = ack.written;
      },
      async finish() {
        // The closing call carries no bytes: it checks the size and moves the
        // finished file into place, so a half-copied file is never at `rel`.
        const ack = await machine.invoke<{ written: number }>("machine_file_write", { root, path: rel, offset: written, b64: "", done: true, mode });
        if (ack.written !== size) throw new ChannelError(`${machine.name} holds ${ack.written} of ${size} bytes.`);
      },
      async abort() {
        await machine.invoke("machine_file_write", { root, path: rel, offset: 0, b64: "", done: false, mode, abort: true }).catch(() => undefined);
      },
    };
  }
  // A workspace keeps an existing file rather than replace it, which is right
  // for a person's upload and wrong for a build artifact copied a second time.
  const path = join(root, rel);
  await mustSh(machine, root, 'rm -f -- "$1"', [path], "Clearing the old copy");
  await machine.invoke("fs_upload_dir", { path: dirname(path) });
  const { id } = await machine.invoke<{ id: string }>("fs_upload_begin", { path, size, mode });
  const hash = new Sha256();
  return {
    async write(b64, offset) {
      const ack = await machine.invoke<{ written: number }>("fs_upload_chunk", { id, offset, b64 });
      const bytes = bytesOf(b64);
      hash.update(bytes);
      if (ack.written !== offset + bytes.length) throw new ChannelError(`${machine.name} did not confirm the upload.`);
    },
    async finish() {
      await machine.invoke("fs_upload_finish", { id, sha256: hash.hex() });
    },
    async abort() {
      await machine.invoke("fs_upload_abort", { id }).catch(() => undefined);
    },
  };
}

export interface CopyProgress {
  (done: number, total: number): void;
}

/** One file, `from.root/from.rel` → `to.root/to.rel`, streamed through the
 *  window slice by slice. The destination is replaced only once every byte has
 *  arrived. Returns the bytes copied. */
export async function copyFile(
  from: { machine: ChannelMachine; root: string; rel: string },
  to: { machine: ChannelMachine; root: string; rel: string },
  opts: { mode?: number; onProgress?: CopyProgress; maxBytes?: number } = {},
): Promise<number> {
  // A workspace's upload needs the size before the first byte.
  const { size } = await readSlice(from.machine, from.root, from.rel, 0, 0);
  const limit = opts.maxBytes ?? MAX_COPY_BYTES;
  if (size > limit) throw new ChannelError(`${from.rel} is ${formatBytes(size)}; the channel copies at most ${formatBytes(limit)}.`);
  const chunk = to.machine.desktop ? DESKTOP_CHUNK : WORKSPACE_CHUNK;
  const writer = await openWriter(to.machine, to.root, to.rel, size, opts.mode ?? 0o644);
  try {
    let offset = 0;
    while (offset < size) {
      const slice = await readSlice(from.machine, from.root, from.rel, offset, Math.min(chunk, size - offset));
      const length = b64Length(slice.b64);
      if (slice.size !== size || length === 0) throw new ChannelError(`${from.rel} changed on ${from.machine.name} while it was being copied.`);
      await writer.write(slice.b64, offset);
      offset += length;
      opts.onProgress?.(offset, size);
    }
    await writer.finish();
    return size;
  } catch (error) {
    await writer.abort();
    throw error instanceof ChannelError ? error : new ChannelError(`Copying ${from.rel} to ${to.machine.name} failed: ${String((error as { message?: string })?.message ?? error)}`);
  }
}

/** The byte length a base64 string decodes to, without decoding it. */
function b64Length(b64: string): number {
  if (!b64) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ---- checkouts -------------------------------------------------------------

/** A repository's working copy on one machine. */
export interface Checkout {
  machine: ChannelMachine;
  /** The top of the working tree. */
  top: string;
  /** The repository's own git directory (shared by its worktrees): where the
   *  channel keeps what it is moving, out of sight of `git status`. */
  common: string;
}

const DESCRIBE = `set -e
top=$(git rev-parse --show-toplevel)
common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
printf 'top=%s\\ncommon=%s\\n' "$top" "$common"`;

/** The checkout `dir` is in, on `machine`. */
export async function checkoutAt(machine: ChannelMachine, dir: string): Promise<Checkout> {
  const { one } = parseFields(await mustSh(machine, dir, DESCRIBE, [], "Reading the repository"));
  if (!one.top || !one.common) throw new ChannelError(`${dir} on ${machine.name} is not inside a git repository.`);
  return { machine, top: one.top, common: one.common };
}

/** Where the channel stages what it moves, inside the git directory. */
export const STAGING = "canopy-sync";

let counter = 0;
/** A name no other transfer uses. */
export const stagingName = (suffix: string): string =>
  `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}.${suffix}`;

/** Move a staged file (in each checkout's git directory) between machines. */
export function copyStaged(from: Checkout, to: Checkout, name: string, onProgress?: CopyProgress): Promise<number> {
  return copyFile(
    { machine: from.machine, root: from.common, rel: `${STAGING}/${name}` },
    { machine: to.machine, root: to.common, rel: `${STAGING}/${name}` },
    { mode: 0o600, onProgress },
  );
}

// ---- copy ------------------------------------------------------------------

const KIND = `if [ -d "$1" ]; then echo dir; elif [ -f "$1" ]; then if [ -x "$1" ]; then echo exec; else echo file; fi; else echo missing; fi`;

const PACK = `set -e
mkdir -p "$1"
tar -czf "$1/$2" -C "$3" -- "$4"`;

const UNPACK = `set -e
mkdir -p "$3"
tar -xzf "$1/$2" -C "$3"
rm -f "$1/$2"`;

export interface CopyResult {
  /** "file" or "folder". */
  kind: "file" | "folder";
  bytes: number;
  /** Where it landed, as an absolute path on the destination. */
  path: string;
}

/** Copy a file or a folder from one checkout to another. A folder travels as
 *  one archive and is unpacked over the destination (files there that the
 *  source does not have are left alone). */
export async function copyPath(
  from: Checkout,
  to: Checkout,
  path: string,
  toPath?: string,
  onProgress?: CopyProgress,
): Promise<CopyResult> {
  const rel = safeRelativePath(path);
  const destRel = safeRelativePath(toPath ?? path);
  writable(to.machine, "copying a file");
  const kind = (await mustSh(from.machine, from.top, KIND, [join(from.top, rel)], "Looking at the file")).trim();
  if (kind === "missing") throw new ChannelError(`${rel} does not exist in ${from.top} on ${from.machine.name}.`);
  if (kind !== "dir") {
    const bytes = await copyFile(
      { machine: from.machine, root: from.top, rel },
      { machine: to.machine, root: to.top, rel: destRel },
      { mode: kind === "exec" ? 0o755 : 0o644, onProgress },
    );
    return { kind: "file", bytes, path: join(to.top, destRel) };
  }
  // A folder: packed beside the repository's git data on the source, moved as
  // one file, unpacked where it belongs.
  const name = stagingName("tgz");
  const parent = dirname(rel);
  const base = rel.slice(parent ? parent.length + 1 : 0);
  const destParent = dirname(destRel);
  const destBase = destRel.slice(destParent ? destParent.length + 1 : 0);
  if (destBase !== base) throw new ChannelError(`A folder keeps its name when copied: "${base}" cannot arrive as "${destBase}".`);
  await mustSh(from.machine, from.top, PACK, [join(from.common, STAGING), name, parent ? join(from.top, parent) : from.top, base], "Packing the folder", {
    timeoutMs: 10 * 60 * 1000,
  });
  try {
    const bytes = await copyStaged(from, to, name, onProgress);
    await mustSh(to.machine, to.top, UNPACK, [join(to.common, STAGING), name, destParent ? join(to.top, destParent) : to.top], "Unpacking the folder", {
      timeoutMs: 10 * 60 * 1000,
    });
    return { kind: "folder", bytes, path: join(to.top, destRel) };
  } finally {
    await shOn(from.machine, from.top, 'rm -f -- "$1"', [join(from.common, STAGING, name)]).catch(() => undefined);
  }
}

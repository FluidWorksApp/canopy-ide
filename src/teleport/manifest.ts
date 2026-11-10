/**
 * Teleport manifest (`teleport.json`, version 1): see docs/teleport-design.md.
 *
 * The manifest arrives from another machine, so it is untrusted input. The
 * validator is strict: unknown keys are rejected, every bundle path must be
 * relative with no `..`, and every string has a size cap. It never throws on
 * bad data; it returns every problem it found so a caller can show them.
 */

export const TELEPORT_MANIFEST_VERSION = 1;
/** Largest manifest text parseTeleportManifest will look at. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BUNDLE_PATH = 512;
const MAX_SEGMENT = 255;
const MAX_CWD = 4096;
const MAX_SHORT = 256;
const MAX_ORIGIN = 2048;

export type TeleportFromKind = "local" | "remote";
export const TELEPORT_FROM_KINDS: readonly TeleportFromKind[] = ["local", "remote"];

export interface TeleportManifest {
  version: 1;
  from: { kind: TeleportFromKind; workspaceId?: string };
  agent: { cli: string; sessionId: string; model?: string; resumeKeeps?: string[] };
  repo: {
    origin: string | null;
    branch: string | null;
    head: string;
    worktree: string | null;
    gitBundle: string | null;
    filesArchive: string;
  };
  transcript: { path: string; sha256: string; cwdFrom: string; cwdTo: string | null };
  account: { copy: boolean };
}

export type ManifestResult =
  | { ok: true; manifest: TeleportManifest }
  | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hasControl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

/** A path inside the bundle. Relative, forward slashes, no `.`/`..`/empty segments. */
export function bundlePathIssue(p: string): string | null {
  if (p.length === 0) return "is empty";
  if (p.length > MAX_BUNDLE_PATH) return `is longer than ${MAX_BUNDLE_PATH} characters`;
  if (hasControl(p)) return "contains a control character";
  if (p.includes("\\")) return "contains a backslash";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith("~")) return "is not relative";
  for (const seg of p.split("/")) {
    if (seg === "") return "has an empty path segment";
    if (seg === "." || seg === "..") return `has a "${seg}" segment`;
    if (seg.length > MAX_SEGMENT) return "has a path segment that is too long";
  }
  return null;
}

/** A recorded working directory: absolute on its own machine (POSIX or drive letter). */
function cwdIssue(p: string): string | null {
  if (p.length === 0 || p.length > MAX_CWD) return `must be 1 to ${MAX_CWD} characters`;
  if (hasControl(p)) return "contains a control character";
  if (!p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p)) return "is not an absolute path";
  return null;
}

const CLI_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/; // lowercase hex only, so equality is a string compare
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/; // sha1 or sha256 repositories

export function validateTeleportManifest(input: unknown): ManifestResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path} ${msg}`);

  const object = (v: unknown, path: string, allowed: string[]): Obj | null => {
    if (!isObj(v)) return err(path, "must be an object"), null;
    for (const k of Object.keys(v)) if (!allowed.includes(k)) err(`${path}.${k}`, "is not a known field");
    return v;
  };
  const str = (v: unknown, path: string, max = MAX_SHORT): string | null => {
    if (typeof v !== "string") return err(path, "must be a string"), null;
    if (v.length === 0 || v.length > max) return err(path, `must be 1 to ${max} characters`), null;
    if (hasControl(v)) return err(path, "contains a control character"), null;
    return v;
  };
  const optStr = (v: unknown, path: string, max = MAX_SHORT) => (v === undefined || v === null ? null : str(v, path, max));
  const nullableStr = (v: unknown, path: string, max = MAX_SHORT) => {
    if (v === null) return;
    str(v, path, max);
  };
  const pattern = (v: unknown, path: string, re: RegExp, what: string) => {
    if (typeof v !== "string") return void err(path, "must be a string");
    if (!re.test(v)) err(path, `must be ${what}`);
  };
  const bundlePath = (v: unknown, path: string, nullable: boolean) => {
    if (v === null && nullable) return;
    if (typeof v !== "string") return void err(path, nullable ? "must be a string or null" : "must be a string");
    const issue = bundlePathIssue(v);
    if (issue) err(path, issue);
  };

  const top = object(input, "manifest", ["version", "from", "agent", "repo", "transcript", "account"]);
  if (!top) return { ok: false, errors };

  if (top.version !== TELEPORT_MANIFEST_VERSION) err("version", `must be ${TELEPORT_MANIFEST_VERSION}`);

  const from = object(top.from, "from", ["kind", "workspaceId"]);
  if (from) {
    if (!TELEPORT_FROM_KINDS.includes(from.kind as TeleportFromKind)) err("from.kind", 'must be "local" or "remote"');
    if (from.workspaceId !== undefined) str(from.workspaceId, "from.workspaceId");
    else if (from.kind === "remote") err("from.workspaceId", "is required when from.kind is remote");
  }

  const agent = object(top.agent, "agent", ["cli", "sessionId", "model", "resumeKeeps"]);
  if (agent) {
    pattern(agent.cli, "agent.cli", CLI_ID, "an agent id (letters, digits, . _ -; max 64)");
    pattern(agent.sessionId, "agent.sessionId", SESSION_ID, "a session id (letters, digits, . _ -; max 128)");
    optStr(agent.model, "agent.model");
    if (agent.resumeKeeps !== undefined) {
      if (!Array.isArray(agent.resumeKeeps) || agent.resumeKeeps.length > 32) err("agent.resumeKeeps", "must be an array of at most 32 strings");
      else agent.resumeKeeps.forEach((x, i) => str(x, `agent.resumeKeeps[${i}]`));
    }
  }

  const repo = object(top.repo, "repo", ["origin", "branch", "head", "worktree", "gitBundle", "filesArchive"]);
  if (repo) {
    nullableStr(repo.origin, "repo.origin", MAX_ORIGIN);
    nullableStr(repo.branch, "repo.branch");
    pattern(repo.head, "repo.head", GIT_SHA, "a full lowercase git object id (40 or 64 hex)");
    bundlePath(repo.worktree, "repo.worktree", true);
    bundlePath(repo.gitBundle, "repo.gitBundle", true);
    bundlePath(repo.filesArchive, "repo.filesArchive", false);
  }

  const tr = object(top.transcript, "transcript", ["path", "sha256", "cwdFrom", "cwdTo"]);
  if (tr) {
    bundlePath(tr.path, "transcript.path", false);
    pattern(tr.sha256, "transcript.sha256", SHA256, "64 lowercase hex characters");
    for (const k of ["cwdFrom", "cwdTo"] as const) {
      const v = tr[k];
      if (k === "cwdTo" && v === null) continue;
      if (typeof v !== "string") err(`transcript.${k}`, k === "cwdTo" ? "must be a string or null" : "must be a string");
      else {
        const issue = cwdIssue(v);
        if (issue) err(`transcript.${k}`, issue);
      }
    }
  }

  const account = object(top.account, "account", ["copy"]);
  if (account && typeof account.copy !== "boolean") err("account.copy", "must be a boolean");

  return errors.length ? { ok: false, errors } : { ok: true, manifest: input as TeleportManifest };
}

/** Parse then validate `teleport.json` text, with a size cap before parsing. */
export function parseTeleportManifest(text: string): ManifestResult {
  // Length in UTF-16 units is a lower bound on bytes; the cap is generous, so
  // check bytes properly when a TextEncoder exists (always in Node and WebView).
  const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length;
  if (bytes > MAX_MANIFEST_BYTES) return { ok: false, errors: [`manifest is larger than ${MAX_MANIFEST_BYTES} bytes`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["manifest is not valid JSON"] };
  }
  return validateTeleportManifest(parsed);
}

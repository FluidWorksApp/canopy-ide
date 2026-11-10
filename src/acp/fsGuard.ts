import type { StructuredRunnerAuthority } from "../structuredRunners";

export type FsDecision =
  | { ok: true; path: string }
  /** `blocked` means Canopy policy refused (the host is told); otherwise the
   *  request itself was malformed or out of scope. */
  | { ok: false; message: string; blocked: boolean };

export interface FsGuardOptions {
  /** Absolute directories the session may touch (the session cwd first). */
  roots: readonly string[];
  authority: StructuredRunnerAuthority;
}

const ABSOLUTE = /^([/]|[A-Za-z]:[/])/;

/** Forward slashes, `.`/`..` resolved, no trailing slash. Returns null for a
 *  relative path or one that climbs above its root. */
function normalize(raw: string): string | null {
  const slashed = raw.replace(/\\/g, "/");
  if (!ABSOLUTE.test(slashed)) return null;
  const drive = /^[A-Za-z]:/.test(slashed) ? slashed.slice(0, 2) : "";
  const parts: string[] = [];
  for (const part of slashed.slice(drive.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return `${drive}/${parts.join("/")}`.replace(/(.)\/$/, "$1");
}

const inside = (path: string, root: string): boolean => {
  // Windows paths compare case-insensitively; POSIX ones do not.
  const fold = /^[A-Za-z]:/.test(root) ? (s: string) => s.toLowerCase() : (s: string) => s;
  const p = fold(path);
  const r = fold(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
};

const AGENT_DIRS = new Set([".claude", ".codex", ".kiro", ".cursor"]);
const AGENT_CONFIG = /^(settings(\.local)?\.json|config\.toml|config\.json|mcp\.json|hooks\.json)$/;
const PROTECTED_NAMES = new Set([".mcp.json", ".gitmodules", "opencode.json", "opencode.jsonc", ".git"]);
const PROTECTED_DIRS = new Set([".husky", ".opencode"]);

/** Files that change what the agent, git or an editor task runner will execute
 *  next. Writing one is a privilege escalation, so it is refused even in
 *  workspace-write: the agent's own tools can still ask the person. Names are
 *  compared case-insensitively (macOS and Windows volumes usually are). This
 *  works on the path as written; the Rust writer repeats the check on the
 *  symlink-resolved path (`fs_write_file_confined`). */
function isProtected(path: string): boolean {
  const segs = path.toLowerCase().split("/").filter(Boolean);
  const name = segs[segs.length - 1] ?? "";
  if (PROTECTED_NAMES.has(name)) return true;
  if (name === "tasks.json" && segs[segs.length - 2] === ".vscode") return true;
  const git = segs.indexOf(".git");
  if (git >= 0) {
    const rest = segs.slice(git + 1);
    if (rest[0] === "hooks" && rest.length > 1) return true;
    if (rest.length === 1 && (rest[0] === "config" || rest[0] === "hooks")) return true;
  }
  if (segs.slice(0, -1).some((s) => PROTECTED_DIRS.has(s))) return true;
  const dir = segs.findIndex((s) => AGENT_DIRS.has(s));
  if (dir >= 0 && dir < segs.length - 1) {
    if (AGENT_CONFIG.test(name)) return true;
    if (segs[dir] === ".kiro" && segs[dir + 1] === "settings") return true;
  }
  return false;
}

/** Decide one `fs/read_text_file` or `fs/write_text_file` request. Pure: the
 *  caller does the IO only when this returns `ok`. */
export function checkFsAccess(
  op: "read" | "write",
  rawPath: string,
  { roots, authority }: FsGuardOptions,
): FsDecision {
  if (typeof rawPath !== "string" || !rawPath) {
    return { ok: false, message: "A file path is required.", blocked: false };
  }
  const path = normalize(rawPath);
  if (!path) {
    return { ok: false, message: "The path must be absolute and stay within its root.", blocked: false };
  }
  const normalizedRoots = roots.map(normalize).filter((r): r is string => r !== null);
  if (!normalizedRoots.some((r) => inside(path, r))) {
    return { ok: false, message: "The path is outside the session's working directories.", blocked: true };
  }
  if (op === "write") {
    if (authority !== "workspace-write") {
      return { ok: false, message: "This session is read-only; writes are refused.", blocked: true };
    }
    if (isProtected(path)) {
      return { ok: false, message: "That file configures hooks, settings or MCP servers and cannot be written without permission.", blocked: true };
    }
  }
  return { ok: true, path };
}

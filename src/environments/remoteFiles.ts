// Opening a file that lives on another machine (docs/multi-host-design.md, P3).
//
// This window's file tabs read this Mac's disk, so a path printed by a terminal
// on a workstation cannot go through them: it would name nothing here, or worse,
// a different file. These files open instead in a read-only viewer, read through
// THAT machine's own file commands, badged with the machine's name. Nothing is
// ever written back.
//
// The rules a local link follows still hold. The machine's host decides what is
// inside a project folder (its fs commands refuse the rest). Settings → Privacy
// → "Files outside projects" is the only way past that, one file at a time, and
// credential locations are refused on this side whatever the setting says.
import { liveEnvironments } from "./live";
import { getSettings } from "../settings";
import { basename } from "../paths";

export const OPEN_REMOTE_FILE_EVENT = "canopy:open-remote-file";

export interface RemoteFileRequest {
  /** "remote:<workspaceId>" */
  env: string;
  /** The machine's name, for the badge. */
  machine: string;
  /** Absolute path on that machine. */
  path: string;
  line?: number;
}

/** Cap on what is read: the host's own limit for a single read. */
export const REMOTE_READ_LIMIT = 1024 * 1024;

const HOME_PARTS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".password-store",
  ".local/share/keyrings", ".claude", ".codex", ".gemini", ".cursor",
  "Library/Keychains", "Library/Application Support", "Library/Cookies", "Library/Mail",
  "Library/Messages", "Library/Safari", "AppData",
];

const CREDENTIAL_NAMES = new Set([
  ".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", ".bash_history", ".zsh_history",
  ".zshrc", ".bashrc", ".profile", ".zprofile", "credentials", "credentials.json", "auth.json",
  "secrets.json",
]);

/** The same credential rule the native side applies to a link (fsx.rs), here so a
 *  remote path is refused before anything is asked of the machine. Case-insensitive
 *  and separator-agnostic; `..` segments are not collapsed, they make it refuse. */
export function isCredentialPath(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  if (norm.split("/").includes("..")) return true;
  const lower = norm.toLowerCase();
  for (const part of HOME_PARTS) {
    const p = part.toLowerCase();
    if (lower.includes(`/${p}/`) || lower.endsWith(`/${p}`)) return true;
  }
  const name = basename(lower);
  return (
    CREDENTIAL_NAMES.has(name) ||
    /^id_(rsa|ed25519|ecdsa|dsa)/.test(name) ||
    /\.(pem|key|p12|pfx|kdbx)$/.test(name)
  );
}

function hostFor(env: string) {
  const connected = liveEnvironments.get(env);
  if (!connected) throw new Error("That machine is not connected.");
  return connected.host;
}

const fromBase64 = (b64: string): Uint8Array => {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** Is `path` a file (not a folder) on that machine? False on any failure. */
export async function remoteFileExists(env: string, path: string): Promise<boolean> {
  try {
    const stat = await hostFor(env).invoke<{ is_dir: boolean }>("fs_stat", { path });
    return !stat.is_dir;
  } catch {
    return false;
  }
}

export class RemoteFileRefused extends Error {}

/** Read a file on that machine, up to the read limit. Throws RemoteFileRefused
 *  with a sentence for the person when the file may not be opened. */
export async function readRemoteFile(
  env: string,
  path: string,
  options: { allowOutside?: boolean } = {},
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (isCredentialPath(path)) throw new RemoteFileRefused("That file holds credentials, so it is never opened from a terminal link.");
  const host = hostFor(env);
  const allowOutside = options.allowOutside ?? getSettings().allowOutsideFileLinks;
  const read = async () => {
    const data = await host.invoke<{ b64: string } | ArrayBuffer | number[]>("fs_read_file", {
      path,
      maxBytes: REMOTE_READ_LIMIT,
    });
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data)
      : Array.isArray(data) ? Uint8Array.from(data)
      : fromBase64((data as { b64: string }).b64);
    return { bytes, truncated: bytes.length >= REMOTE_READ_LIMIT };
  };
  try {
    return await read();
  } catch (first) {
    const outside = /outside|scope|not allowed|permission|denied/i.test(String((first as Error)?.message ?? first));
    if (!outside) throw first;
    if (!allowOutside)
      throw new RemoteFileRefused(
        "That file is outside the project folders. Settings → Privacy → Files outside projects lets a clicked link open it.",
      );
    // Only that file, only because the person clicked it.
    await host.invoke("fs_grant_link_file", { path }).catch(() => {});
    return read();
  }
}

/** Ask the app to show a file from another machine. */
export function openRemoteFile(request: RemoteFileRequest): void {
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(request.path)) return;
  window.dispatchEvent(new CustomEvent<RemoteFileRequest>(OPEN_REMOTE_FILE_EVENT, { detail: request }));
}

// Where the active remote workspace keeps its files. Managed and Docker hosts use
// /workspace; a canopy-host process workspace reports its own folder from /open.
export const DEFAULT_REMOTE_ROOT = "/workspace";

let root = DEFAULT_REMOTE_ROOT;

export function normalizeRemoteRoot(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) return DEFAULT_REMOTE_ROOT;
  return value.replace(/\/+$/, "") || DEFAULT_REMOTE_ROOT;
}

export const remoteRoot = () => root;
export function setRemoteRoot(value: unknown) { root = normalizeRemoteRoot(value); }

export const insideRemoteRoot = (path: string, base = root) => path === base || path.startsWith(`${base}/`);

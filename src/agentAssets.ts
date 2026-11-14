// What an agent has made: the documents, images and pages among the files it
// wrote, collected for the card. Source code is deliberately not here: the
// Workspace overlay already shows code changes; this is for the things you
// would open and look at.
//
// The input is the session digest's `files` (src-tauri canopy_hook.rs), which
// holds paths relative to the agent's folder when inside it, absolute otherwise.

export type AssetKind = "preview" | "markdown" | "image" | "html" | "pdf" | "json" | "sheet" | "notebook" | "docx";

export interface Asset {
  /** Absolute path. */
  path: string;
  name: string;
  kind: AssetKind;
}

const KINDS: Record<string, AssetKind> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  html: "html",
  htm: "html",
  pdf: "pdf",
  json: "json",
  jsonc: "json",
  csv: "sheet",
  xlsx: "sheet",
  xls: "sheet",
  ipynb: "notebook",
  docx: "docx",
  doc: "docx",
};

/** Files that are documents or artefacts for the project's own tooling, not
 *  something an agent made to be looked at. */
const NOT_AN_ASSET = new Set(["package.json", "package-lock.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "composer.json", "deno.json", "components.json", ".eslintrc.json", "biome.json", "turbo.json", "vercel.json", "renovate.json"]);

export const assetKind = (path: string): AssetKind | null => {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (NOT_AN_ASSET.has(name.toLowerCase())) return null;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return KINDS[ext] ?? null;
};

/** An absolute path for a digest entry. */
export function resolveAssetPath(file: string, cwd: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(file)) return file;
  const base = cwd.replace(/[\\/]+$/, "");
  return `${base}/${file.replace(/^\.\//, "")}`;
}

/** The session's assets, newest first, each once. */
export function collectAssets(files: readonly string[] | undefined, cwd: string, max = 40): Asset[] {
  const seen = new Set<string>();
  const out: Asset[] = [];
  // The digest lists files oldest first.
  for (const file of [...(files ?? [])].reverse()) {
    if (out.length >= max) break;
    if (typeof file !== "string" || !file) continue;
    const kind = assetKind(file);
    if (!kind) continue;
    const path = resolveAssetPath(file, cwd);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: path.split(/[\\/]/).pop() ?? path, kind });
  }
  return out;
}

export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

export const imageMime = (path: string): string => IMAGE_MIME[(path.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";

/** Kinds a text excerpt makes sense for; the rest are opened to be seen. */
export const hasTextPreview = (kind: AssetKind): boolean => kind === "markdown" || kind === "json" || kind === "sheet" || kind === "notebook";

/** The servers an agent's terminal is running, as assets: each opens in a
 *  preview tab. Only plausible web ports (a few services listen on others for
 *  their own reasons), each once, lowest first. */
export function previewAssets(ports: readonly number[] | undefined, max = 6): Asset[] {
  const seen = new Set<number>();
  const out: Asset[] = [];
  for (const port of [...(ports ?? [])].sort((a, b) => a - b)) {
    if (out.length >= max) break;
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || seen.has(port)) continue;
    seen.add(port);
    out.push({ path: `http://localhost:${port}`, name: `localhost:${port}`, kind: "preview" });
  }
  return out;
}

export const isPreviewUrl = (path: string): boolean => /^https?:\/\//.test(path);

/** How the card stops a server in this terminal: the ports whose listening
 *  process is known, and a stop that ends exactly those processes. Undefined
 *  when no process reports a port (an older core, or a terminal on another
 *  machine, where a local kill would hit the wrong computer). */
export function stopServerFor(
  stat:
    | {
        id: number;
        procs: readonly { pid: number; parent?: number | null; ports?: readonly number[] }[];
        agent_hint?: unknown;
      }
    | undefined,
  kill: (pid: number) => Promise<void>,
): { ports: number[]; stop: (port: number) => Promise<void> } | undefined {
  const procs = stat?.procs ?? [];
  const pids = new Set(procs.map((p) => p.pid));
  // Never the terminal's own process, and in an agent's terminal never the
  // processes started straight from it: that is the agent CLI, which may hold
  // a port of its own (a sign-in callback, an editor bridge). A server the
  // agent runs sits below it.
  const roots = new Set(procs.filter((p) => p.parent == null || !pids.has(p.parent)).map((p) => p.pid));
  const spared = (p: { pid: number; parent?: number | null }) =>
    roots.has(p.pid) || (!!stat?.agent_hint && p.parent != null && roots.has(p.parent));
  const owners = procs.filter((p) => (p.ports?.length ?? 0) > 0 && !spared(p));
  if (!stat || owners.length === 0) return undefined;
  return {
    ports: [...new Set(owners.flatMap((p) => [...(p.ports ?? [])]))],
    stop: async (port) => {
      const pids = owners.filter((p) => p.ports!.includes(port)).map((p) => p.pid);
      if (pids.length === 0) throw new Error("nothing is listening there now");
      await Promise.all(pids.map((pid) => kill(pid)));
    },
  };
}

/** ACP registry discovery. Read-only: nothing here runs a package or
 *  downloads a binary. The person picks an entry and adds it as a custom CLI;
 *  the launch command is theirs to run on first use. */

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const CACHE_KEY = "canopy.acpRegistry.v1";
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const MAX_AGENTS = 500;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const NPX_PKG = /^(?:@[^/@\s]+\/[^@\s]+|[a-z0-9][a-z0-9._-]*)@v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/i;
const UVX_PKG = /^[a-z0-9][a-z0-9._-]*(?:@|==)v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/i;

export interface RegistryLaunch {
  kind: "npx" | "uvx" | "binary";
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Binary distributions are not installed by Canopy: the command must
   *  already be on PATH. */
  needsInstall: boolean;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  website?: string;
  launch: RegistryLaunch[];
}

export class AcpRegistryError extends Error {
  reason: "offline" | "invalid";
  constructor(reason: "offline" | "invalid", message: string) {
    super(message);
    this.reason = reason;
  }
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max && !v.includes("\0") ? v : undefined;

function argv(v: unknown): string[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 64) return undefined;
  const out: string[] = [];
  for (const a of v) {
    const s = str(a, 1024);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}

function envRecord(v: unknown): Record<string, string> | undefined | null {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = str(val, 1024);
    if (s === undefined || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) return null;
    out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `darwin-aarch64`, `linux-x86_64`, `windows-x86_64` keys, from navigator. */
export function registryPlatform(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const os = /Mac/i.test(ua) ? "darwin" : /Win/i.test(ua) ? "windows" : "linux";
  const arch = /arm64|aarch64/i.test(ua) ? "aarch64" : "x86_64";
  return `${os}-${arch}`;
}

function parseLaunch(dist: unknown, platform: string): RegistryLaunch[] {
  if (!dist || typeof dist !== "object") return [];
  const d = dist as Record<string, unknown>;
  const out: RegistryLaunch[] = [];
  for (const kind of ["npx", "uvx"] as const) {
    const e = d[kind] as { package?: unknown; args?: unknown; env?: unknown } | undefined;
    if (!e || typeof e !== "object") continue;
    const pkg = str(e.package, 256);
    const args = argv(e.args);
    const env = envRecord(e.env);
    if (!pkg || !(kind === "npx" ? NPX_PKG : UVX_PKG).test(pkg) || !args || env === null) continue;
    out.push({
      kind,
      command: kind,
      args: kind === "npx" ? ["-y", pkg, ...args] : [pkg, ...args],
      env,
      needsInstall: false,
    });
  }
  const bin = d.binary as Record<string, unknown> | undefined;
  const target = bin && typeof bin === "object" ? (bin[platform] as Record<string, unknown> | undefined) : undefined;
  if (target && typeof target === "object") {
    const cmd = str(target.cmd, 1024);
    const args = argv(target.args);
    const env = envRecord(target.env);
    const archive = str(target.archive, 2048);
    let https = false;
    try {
      const u = new URL(archive ?? "");
      https = u.protocol === "https:" && !u.username && !u.password;
    } catch {
      /* not a URL */
    }
    // Last path segment, extension kept: the archive is not unpacked by
    // Canopy, so this names the executable the person installs on PATH.
    const name = cmd?.split(/[\\/]/).pop();
    if (name && name !== "." && name !== ".." && args && env !== null && https)
      out.push({ kind: "binary", command: name, args, env, needsInstall: true });
  }
  return out;
}

/** Validate registry JSON. Entries that fail validation are dropped; a payload
 *  that is not a registry at all throws. */
export function parseRegistry(json: unknown, platform = registryPlatform()): RegistryAgent[] {
  const root = json as { agents?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.agents))
    throw new AcpRegistryError("invalid", "Registry response has no agents list.");
  const out: RegistryAgent[] = [];
  for (const raw of root.agents.slice(0, MAX_AGENTS)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const id = str(a.id, 128);
    const name = str(a.name, 160)?.trim();
    const version = str(a.version, 128);
    if (!id || !ID.test(id) || !name || !version) continue;
    const launch = parseLaunch(a.distribution, platform);
    if (!launch.length) continue;
    const website = str(a.website, 2048);
    out.push({
      id,
      name,
      version,
      description: str(a.description, 1024) ?? "",
      website: website && /^https:\/\//.test(website) ? website : undefined,
      launch,
    });
  }
  return out;
}

interface Cached {
  at: number;
  json: unknown;
}

function readCache(): Cached | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Cached | null;
    return c && typeof c.at === "number" ? c : null;
  } catch {
    return null;
  }
}

/** Fetch the registry. Fresh cache wins; a failed fetch falls back to a stale
 *  cache; with neither it throws AcpRegistryError("offline") and the caller
 *  shows the built-in presets alone. */
export async function fetchAcpRegistry(
  opts: { fetchImpl?: typeof fetch; now?: number; force?: boolean; platform?: string } = {},
): Promise<RegistryAgent[]> {
  const now = opts.now ?? Date.now();
  const cached = readCache();
  if (cached && !opts.force && now - cached.at < TTL_MS) {
    try {
      return parseRegistry(cached.json, opts.platform);
    } catch {
      /* corrupt cache: refetch */
    }
  }
  let json: unknown;
  try {
    const res = await (opts.fetchImpl ?? fetch)(ACP_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new AcpRegistryError("invalid", "Registry response is too large.");
    json = JSON.parse(text);
    const agents = parseRegistry(json, opts.platform);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, json }));
    } catch {
      /* cache is best effort */
    }
    return agents;
  } catch (e) {
    if (e instanceof AcpRegistryError && e.reason === "invalid" && json !== undefined && !cached) throw e;
    if (cached) {
      try {
        return parseRegistry(cached.json, opts.platform);
      } catch {
        /* fall through */
      }
    }
    if (e instanceof AcpRegistryError) throw e;
    throw new AcpRegistryError("offline", e instanceof Error ? e.message : "Registry unreachable.");
  }
}

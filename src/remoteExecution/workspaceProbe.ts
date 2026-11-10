// A short, on-demand look at a workspace that is NOT the one this window is
// connected to. The window has one live host (src/host), so everything about
// another workspace used to be "unavailable"; this asks the workspace's own
// gateway, with the same credential flow the live connection uses
// (NativeWorkspaceHost's token renewal), and keeps nothing open afterwards.
//
// Deliberately small and read-only: it lists sessions, nothing more. It never
// heartbeats and never resumes a stopped workspace.
import { invoke } from "@tauri-apps/api/core";
import { RemoteExecutionClient, type RemoteSession } from "./client";

export interface ProbeConnection {
  endpoint: string;
  token: string;
  workspaceId: string;
}

export interface ProbeDeps {
  /** The account request that issues a workspace credential. */
  connect: (workspaceId: string, clientId: string) => Promise<ProbeConnection>;
  sessions: (connection: ProbeConnection) => Promise<RemoteSession[]>;
  clientId: (workspaceId: string) => string;
  now: () => number;
}

/** A listing newer than this is reused, so opening and refreshing the overview
 *  does not ask every workspace again each time. */
export const PROBE_TTL_MS = 20_000;
/** One slow workspace must not hold the whole overview. */
export const PROBE_TIMEOUT_MS = 8_000;

/** After a failure, do not ask the same workspace again for a little while: the
 *  overview and the placement picker both ask, and each would wait out the
 *  timeout on an unreachable workspace. */
export const PROBE_FAILURE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; sessions: RemoteSession[] }>();
const failures = new Map<string, { at: number; error: Error }>();
const inflight = new Map<string, Promise<RemoteSession[]>>();

/** One stable id per workspace on this computer. A new id every time would look
 *  like a new connected client on every look. */
function stableClientId(workspaceId: string): string {
  const key = `canopy:probe-client:${workspaceId}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const made = crypto.randomUUID();
    localStorage.setItem(key, made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}

const defaultDeps: ProbeDeps = {
  connect: async (workspaceId, clientId) => {
    const result = await invoke<{ connection?: ProbeConnection; expiresAt?: string }>("canopy_account_request", {
      route: "/api/operations",
      body: { action: "connect", workspaceId, clientId },
    });
    const c = result?.connection;
    if (
      !c ||
      c.workspaceId !== workspaceId ||
      typeof c.endpoint !== "string" ||
      typeof c.token !== "string" ||
      !c.token
    ) {
      throw new Error("The workspace did not issue a usable credential.");
    }
    return c;
  },
  sessions: async (c) => {
    const client = new RemoteExecutionClient(c.endpoint, c.token);
    return client.workspace<RemoteSession[]>(c.workspaceId, "/sessions");
  },
  clientId: stableClientId,
  now: () => Date.now(),
};

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The workspace did not answer in time.")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** The workspace's sessions right now. Throws when it cannot be reached, so a
 *  caller can say "unknown" rather than "idle". */
export function probeSessions(workspaceId: string, deps: ProbeDeps = defaultDeps): Promise<RemoteSession[]> {
  const hit = cache.get(workspaceId);
  if (hit && deps.now() - hit.at < PROBE_TTL_MS) return Promise.resolve(hit.sessions);
  const failed = failures.get(workspaceId);
  if (failed && deps.now() - failed.at < PROBE_FAILURE_TTL_MS) return Promise.reject(failed.error);
  const pending = inflight.get(workspaceId);
  if (pending) return pending;
  const run = withTimeout(
    (async () => {
      const connection = await deps.connect(workspaceId, deps.clientId(workspaceId));
      return deps.sessions(connection);
    })(),
    PROBE_TIMEOUT_MS,
  )
    .then(
      (sessions) => {
        cache.set(workspaceId, { at: deps.now(), sessions });
        failures.delete(workspaceId);
        return sessions;
      },
      (error) => {
        failures.set(workspaceId, { at: deps.now(), error: error instanceof Error ? error : new Error(String(error)) });
        throw error;
      },
    )
    .finally(() => inflight.delete(workspaceId));
  inflight.set(workspaceId, run);
  return run;
}

/** Sessions still running: an exited one is history, not load. */
export const runningSessions = (sessions: RemoteSession[]): number =>
  sessions.filter((s) => s.exitCode == null).length;

/** Test seam. */
export function resetProbeCache(): void {
  cache.clear();
  failures.clear();
  inflight.clear();
}

// Another account's sessions must never be served to this one.
if (typeof window !== "undefined") window.addEventListener("canopy:account-changed", resetProbeCache);

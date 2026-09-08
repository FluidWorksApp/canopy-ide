import * as ipc from "./ipc";
import { runAbstractionPlan } from "./vibeAbstractionRunner";
import { providerMcpToolAllowances } from "./vibeServices";

export type DatabaseProvider = "supabase" | "firebase";
export interface ProviderProject { id: string; name: string }
export interface MigrationPlan {
  provider: DatabaseProvider;
  cwd: string;
  resourceId: string;
  environment: "local" | "production";
  fingerprint: string;
  files: string[];
  /** Transient review content; never persisted in workspace operation records. */
  changes: Array<{ path: string; content: string }>;
  pending: string[];
  applied: string[];
}
export interface ProviderDeps {
  run(argv: string[], cwd: string): Promise<string>;
  read(path: string): Promise<string>;
  list(path: string): Promise<string[]>;
  projectsViaMcp(provider: DatabaseProvider, cwd: string): Promise<ProviderProject[] | null>;
  acquire?(key: string): Promise<() => Promise<void>>;
}

export function parseProviderProjects(value: unknown, provider: DatabaseProvider): ProviderProject[] {
  const object = value as { result?: unknown; projects?: unknown; data?: unknown } | null;
  const result = Array.isArray(value) ? value : object?.result ?? object?.projects ?? object?.data;
  const rows = Array.isArray(result) ? result : (result as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(rows)) throw new Error("The provider returned an unrecognized project list.");
  return rows.map((value) => {
    const row = value as Record<string, unknown>;
    const id = provider === "firebase" ? row.projectId : row.id ?? row.ref;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,127}$/i.test(id)) throw new Error("The provider returned an invalid project ID.");
    return { id, name: String(row.displayName ?? row.name ?? id).slice(0, 128) };
  });
}

export const nativeProviderDeps: ProviderDeps = {
  acquire: async (key) => {
    const token = await ipc.buildOperationAcquire(key);
    return () => ipc.buildOperationRelease(key, token);
  },
  run: async (argv, cwd) => {
    const localBin = `${cwd}/node_modules/.bin/${argv[0]}`;
    const local = await ipc.fsStat(localBin).catch(() => null);
    const resolved = local && !local.is_dir ? [localBin, ...argv.slice(1)] : argv;
    const result = await runAbstractionPlan(resolved, cwd, {
      ptySpawnDetached: (opts) => ipc.ptySpawnArgv(opts),
      onPtyExit: (listen) => ipc.onPtyExit((event) => listen({ id: event.id, exit_code: event.exit_code ?? null })),
      ptyOutput: ipc.ptyOutput, ptyKill: ipc.ptyKill,
    });
    if (!result.ok) throw new Error(result.timedOut ? "The provider did not finish. Check its status before retrying." : "The provider command failed. Check the account connection and project permissions.");
    return result.output;
  },
  read: async (path) => {
    const stat = await ipc.fsStat(path);
    if (stat.is_dir || stat.size > 1024 * 1024) throw new Error("This database file is too large to review completely. Split it into smaller migrations.");
    return ipc.fsReadText(path, 1024 * 1024);
  },
  list: async (path) => (await ipc.fsReadDir(path)).map((entry) => entry.name),
  projectsViaMcp: async (provider, cwd) => {
    const servers = await ipc.mcpServers([cwd]);
    for (const server of servers.filter((server) => providerMcpToolAllowances(provider, [server]).length)) {
      try {
        const session = await ipc.mcpConnect(server.key);
        const name = provider === "supabase" ? "list_projects" : "firebase_list_projects";
        if (!session.tools.some((tool) => tool.name === name)) continue;
        const result = await ipc.mcpCallTool(server.key, name, {});
        if (result.is_error || result.task) continue;
        const value = result.structured ?? JSON.parse(result.content.find((block) => block.type === "text")?.text ?? "null");
        return parseProviderProjects(value, provider);
      } catch { /* An unavailable account route falls back to the installed CLI. */ }
    }
    return null;
  },
};

export async function listProviderProjects(provider: DatabaseProvider, cwd: string, deps = nativeProviderDeps): Promise<ProviderProject[]> {
  const linked = await deps.projectsViaMcp(provider, cwd);
  if (linked) return linked;
  const argv = provider === "supabase" ? ["supabase", "projects", "list", "--output", "json"]
    : ["firebase", "projects:list", "--json", "--non-interactive"];
  return parseProviderProjects(JSON.parse(await deps.run(argv, cwd)), provider);
}

/** Re-query access immediately before recording a binding. Config presence alone is not authentication. */
export async function verifyProviderProject(provider: DatabaseProvider, cwd: string, id: string, deps = nativeProviderDeps): Promise<ProviderProject> {
  const project = (await listProviderProjects(provider, cwd, deps)).find((project) => project.id === id);
  if (!project) throw new Error("This account cannot access the selected project. Refresh the project list.");
  return project;
}

export function parseMigrationStatus(output: string): { pending: string[]; applied: string[] } {
  if (!/Local\s*\|\s*Remote/i.test(output)) throw new Error("Could not read migration history; no changes were applied.");
  const pending: string[] = [], applied: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d*)\s*\|\s*(\d*)\s*\|/);
    if (!match) continue;
    const [, local, remote] = match;
    if (remote && local !== remote) throw new Error("The database history differs from local migrations. Reconcile it before applying changes.");
    if (remote) applied.push(remote);
    else if (local) pending.push(local);
  }
  return { pending, applied };
}

async function ensureSupabaseTarget(cwd: string, resourceId: string, deps: ProviderDeps): Promise<void> {
  // Never relink implicitly: the user must be able to review which remote a
  // repository targets, and a stale CLI link must not redirect an approved plan.
  const linked = (await deps.read(`${cwd}/supabase/.temp/project-ref`)).trim();
  if (linked !== resourceId) throw new Error("Supabase CLI targets a different project. Configure the selected project before inspecting migrations.");
}

export async function inspectMigrations(provider: DatabaseProvider, cwd: string, resourceId: string, environment: "local" | "production", deps = nativeProviderDeps): Promise<MigrationPlan> {
  let files: string[];
  let history = { pending: [] as string[], applied: [] as string[] };
  if (provider === "supabase") {
    if (environment === "production") await ensureSupabaseTarget(cwd, resourceId, deps);
    const names = (await deps.list(`${cwd}/supabase/migrations`)).filter((name) => name.endsWith(".sql"));
    if (names.some((name) => !/^\d+_[\w.-]+\.sql$/.test(name))) throw new Error("Every SQL migration needs a unique timestamp and name before it can be reviewed.");
    const versions = names.map((name) => name.split("_")[0]);
    if (new Set(versions).size !== versions.length) throw new Error("Migration timestamps must be unique.");
    files = names.sort().map((name) => `supabase/migrations/${name}`);
    history = parseMigrationStatus(await deps.run(["supabase", "migration", "list", environment === "local" ? "--local" : "--linked"], cwd));
    const observed = [...history.pending, ...history.applied];
    if (versions.length !== observed.length || versions.some((id) => !observed.includes(id))) throw new Error("Migration files do not match the CLI history. Refresh and reconcile before applying.");
  } else {
    const config = JSON.parse(await deps.read(`${cwd}/firebase.json`));
    const stores = Array.isArray(config.firestore) ? config.firestore : [config.firestore];
    files = stores.flatMap((store: { rules?: unknown; indexes?: unknown } | undefined) => [store?.rules, store?.indexes])
      .filter((path: unknown): path is string => typeof path === "string");
    if (!files.length || files.some((path) => path.startsWith("/") || path.includes("..") || path.includes("\\"))) throw new Error("Firebase needs project-relative Firestore rules and index files.");
    files = [...new Set(["firebase.json", ...files])].sort();
    history.pending = files.map((path) => path.replaceAll("/", "_"));
  }
  const contents = await Promise.all(files.map(async (file) => [file, await deps.read(`${cwd}/${file}`)]));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ provider, resourceId, environment, contents, history })));
  const fingerprint = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { provider, cwd, resourceId, environment, fingerprint, files, changes: contents.map(([path, content]) => ({ path, content })), ...history };
}

const applying = new Set<string>();
export async function applyMigrations(plan: MigrationPlan, confirmedFingerprint: string, persist: (status: "running" | "succeeded" | "unknown") => Promise<void>, deps = nativeProviderDeps): Promise<void> {
  const key = `${plan.provider}:${plan.resourceId}:${plan.environment}`;
  if (applying.has(key)) throw new Error("A database operation is already running for this environment.");
  if (confirmedFingerprint !== plan.fingerprint) throw new Error("Review the current database changes before applying them.");
  applying.add(key);
  let started = false;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await deps.acquire?.(key);
    const current = await inspectMigrations(plan.provider, plan.cwd, plan.resourceId, plan.environment, deps);
    if (current.fingerprint !== plan.fingerprint) throw new Error("Database files or migration history changed. Review the new plan.");
    if (plan.provider === "firebase" && plan.environment === "local") throw new Error("Firebase emulators load local rules. Production rules are published from the Production tab.");
    await persist("running");
    started = true;
    const argv = plan.provider === "supabase"
      ? ["supabase", "migration", "up", plan.environment === "local" ? "--local" : "--linked", "--yes"]
      : ["firebase", "deploy", "--only", "firestore:rules,firestore:indexes", "--project", plan.resourceId, "--non-interactive"];
    await deps.run(argv, plan.cwd);
    if (plan.provider === "supabase") {
      const after = await inspectMigrations(plan.provider, plan.cwd, plan.resourceId, plan.environment, deps);
      if (plan.pending.some((id) => !after.applied.includes(id))) throw new Error("The database has not confirmed every migration.");
    }
    await persist("succeeded");
  } catch (error) {
    if (started) await persist("unknown").catch(() => {});
    throw error;
  } finally { applying.delete(key); await release?.(); }
}

// Research, claims and mesh commands in a Linux workspace. Their stores belong
// to the workspace's canopy-service (it is what the VM's agents write through
// their canopy_* tools), which runs beside the container rather than in it, so
// these are answered through the harness query/action routes instead of the
// workspace host. Arguments and answers keep the desktop commands' shapes
// (research.rs, context.rs); the service's are translated here.
export type HarnessIo = {
  query<T>(store: string, action: string, args?: Record<string, unknown>): Promise<T>;
  action<T>(kind: string, args: Record<string, unknown>): Promise<T>;
  /** A workspace host command (file reads for imports). */
  native<T>(command: string, args: Record<string, unknown>): Promise<T>;
  /** The desktop, for a mesh job submitted by something on this computer. */
  desktop<T>(command: string, args: Record<string, unknown>): Promise<T>;
  /** This workspace's run id, `remote-<workspace>`. */
  instance: string;
  /** A view-only member: reads must not write anything on the way. */
  readOnly?: boolean;
};
type Args = Record<string, unknown>;

export const HARNESS_COMMANDS = [
  "research_list", "research_search", "research_get", "research_start", "research_update",
  "research_set_status", "research_link", "research_read_file", "research_for_file",
  "research_delete", "research_import", "research_sweep", "research_dir",
  "context_claims", "context_claim_history", "context_claim_history_for_path",
  "context_messages", "context_mesh_severed", "context_release_claim", "context_mesh_sever",
  "context_mesh_job_update", "context_hotspot_claim",
  "workspace_memory_sync", "workspace_memory_proposals", "workspace_memory_ack",
] as const;
const HANDLED = new Set<string>(HARNESS_COMMANDS);
/** The ones that only read: a view-only member may ask these. */
export const HARNESS_READS: ReadonlySet<string> = new Set([
  "research_list", "research_search", "research_get", "research_read_file", "research_for_file", "research_dir",
  "context_claims", "context_claim_history", "context_claim_history_for_path", "context_messages", "context_mesh_severed",
]);
/** How a workspace whose gateway and service predate a query or action
 *  refuses it — which means "update the workspace", not a missing feature. */
export const isOutdatedHarnessError = (error: unknown) =>
  /Invalid harness action|no query \S+ on|unknown action kind|unknown research action: (?:import_text|import_chunk|replace|delete)\b/.test(String(error));
export const isHarnessCommand = (command: string) => HANDLED.has(command);

/** The service's own limit on an imported file (research.rs SOURCE_MAX). */
const IMPORT_MAX = 512 * 1024;
/** The gateway caps a harness action body at 256 KiB, so a larger import goes
 *  in pieces this many characters long (≤ 192 KiB even fully JSON-escaped). */
const IMPORT_CHUNK = 32 * 1024;
const QUERY_BATCH_BYTES = 48 * 1024;

const items = <T>(value: unknown): T[] => {
  const rows = (value as { items?: unknown })?.items;
  return Array.isArray(rows) ? (rows as T[]) : [];
};
/** Leave out fields the caller did not give, so the service applies its own defaults. */
const defined = (value: Args) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

async function readWorkspaceText(io: HarnessIo, path: string): Promise<string> {
  const slice = await io.native<{ b64: string; size: number }>("fs_read_range", { path, offset: 0, length: 1024 * 1024 });
  if (slice.size > IMPORT_MAX)
    throw Error(`cannot read ${path}: ${path} is ${slice.size} bytes; the read limit is ${IMPORT_MAX}`);
  return new TextDecoder().decode(Uint8Array.from(atob(slice.b64), (c) => c.charCodeAt(0)));
}
/** Import a workspace file the service cannot open: in one action when it
 *  fits the gateway's body cap, else in pieces the service joins (import_chunk). */
async function importText(io: HarnessIo, path: string): Promise<unknown> {
  const text = await readWorkspaceText(io, path);
  if (text.length <= IMPORT_CHUNK) return io.action<unknown>("research_write", { action: "import_text", path, text });
  const upload = crypto.randomUUID();
  let result: unknown = null;
  for (let offset = 0; offset < text.length; offset += IMPORT_CHUNK) {
    const done = offset + IMPORT_CHUNK >= text.length;
    result = await io.action<unknown>("research_write", { action: "import_chunk", upload, path, offset, text: text.slice(offset, offset + IMPORT_CHUNK), done });
  }
  return result;
}

type EntryFile = { name: string; path: string; text: string };
/** What a workspace research run wrote in its entry's directory in the VM
 *  (research-mirror.mjs), copied into the entry as sources once each. */
async function syncEntryFiles(io: HarnessIo, id: string, detail: unknown): Promise<boolean> {
  if (io.readOnly || !id) return false;
  const files = await io.native<EntryFile[]>("research_entry_files", { id }).catch(() => [] as EntryFile[]);
  const sources = (detail as { sources?: { origin?: string }[] } | null)?.sources ?? [];
  const have = new Set(sources.map((s) => s.origin ?? ""));
  let added = false;
  for (const f of files) {
    const origin = `workspace:${f.path}`;
    if (have.has(origin) || !f.text.trim() || f.text.length > IMPORT_CHUNK * 5) continue;
    try {
      await io.action("research_write", { action: "source", id, title: f.name.replace(/\.[^.]+$/, ""), text: f.text, origin });
      added = true;
    } catch {
      // The entry may be full (64 sources); the rest still go.
    }
  }
  return added;
}

export async function harnessCommand(command: string, args: Args, io: HarnessIo): Promise<unknown> {
  const write = (body: Args) => io.action<unknown>("research_write", defined(body));
  switch (command) {
    case "research_list":
      return items(await io.query("research", "list", defined({ statuses: args.status ?? undefined, limit: args.limit ?? undefined })));
    case "research_search": {
      const found = await io.query<{ research?: unknown[] }>("research", "search", defined({ query: args.query, limit: args.limit ?? undefined }));
      return Array.isArray(found?.research) ? found.research : [];
    }
    case "research_get": {
      const detail = await io.query("research", "get", { id: args.id });
      return (await syncEntryFiles(io, String(args.id ?? ""), detail)) ? io.query("research", "get", { id: args.id }) : detail;
    }
    case "research_start":
      return write({ action: "start", title: args.title, question: args.question, agent: args.agent, pty_id: args.ptyId, tags: args.tags, text: args.body, instance: io.instance });
    case "research_update": {
      const fields = { id: args.id, title: args.title, digest: args.digest, recommendation: args.recommendation, open_questions: args.openQuestions, tags: args.tags };
      // A whole replacement write-up is the person's edit: the service's
      // user-only "replace", which no agent op reaches.
      if (typeof args.body === "string" && args.append == null) return write({ action: "replace", text: args.body, ...fields });
      return write(args.append != null ? { action: "append", text: args.append, ...fields } : { action: "update", ...fields });
    }
    case "research_set_status":
      return write({ action: "status", id: args.id, status: args.status, by: args.by ?? "", note: args.note });
    case "research_link":
      return write({ action: "link", id: args.id, pr: args.pr, ticket: args.ticket, branch: args.branch, files: args.files, supersedes: args.supersedes });
    case "research_read_file":
      return (await io.query<{ text: string }>("research", "read_file", { id: args.id, path: args.path })).text;
    case "research_for_file":
      return (await io.query<{ id: string | null }>("research", "for_file", { path: args.path })).id ?? null;
    case "research_delete":
      await write({ action: "delete", id: args.id });
      return null;
    case "research_import":
      return importText(io, String(args.path ?? ""));
    case "research_sweep": {
      // The service decides which files to adopt (sweep_plan applies the
      // desktop sweep's rules); the workspace host lists and reads them.
      const roots = (Array.isArray(args.roots) ? args.roots : []).map(String);
      const files = await io.native<string[]>("fs_list_files", { roots, limit: 20000 });
      const markdown = [...new Set(files.filter((path) => /\.md$/i.test(path)))];
      let imported = 0, matched = 0, skipped = 0;
      for (let start = 0; start < markdown.length;) {
        const batch: string[] = [];let bytes = 0;
        while (start < markdown.length && (bytes + markdown[start].length < QUERY_BATCH_BYTES || !batch.length)) {
          bytes += markdown[start].length + 4;batch.push(markdown[start++]);
        }
        const plan = await io.query<{ candidates: string[]; matched: number }>("research", "sweep_plan", { paths: batch });
        matched += plan.matched;
        for (const path of plan.candidates) {
          try { await importText(io, path); imported++; } catch { skipped++; }
        }
      }
      return { imported, matched, skipped };
    }
    case "research_dir":
      // The entry itself is on the service's machine, which a workspace agent
      // cannot write; its run writes prose and progress in a directory in the
      // VM instead (research-mirror.mjs), copied in as sources on the next
      // read. An older host has none: "" turns the hook's prose gate off.
      if (io.readOnly) return "";
      return io.native<string>("research_entry_dir", { id: args.id }).catch((error) => {
        if (/does not support research_entry_dir yet/.test(String(error))) return "";
        throw error;
      });
    case "context_claims":
      return items(await io.query("claims", "list"));
    case "context_claim_history":
      return items(await io.query("claims", "history"));
    case "context_claim_history_for_path":
      return items(await io.query("claims", "history", { path: args.path }));
    case "context_messages":
      return items(await io.query("mesh", "messages"));
    case "context_mesh_severed":
      return items(await io.query("mesh", "severed"));
    case "context_release_claim":
      await io.action("claim_release", { ownerKey: args.ownerKey });
      return null;
    case "context_mesh_sever":
      return items(await io.action("mesh_sever", { a: args.a, b: args.b, severed: args.severed }));
    case "context_mesh_job_update":
      // A job submitted from this computer (the companion) answers there.
      if (args.instance !== io.instance) return io.desktop("context_mesh_job_update", args);
      return (await io.action<{ id: string }>("mesh_job_update", defined({ ptyId: args.ptyId, instance: args.instance, jobId: args.jobId, text: args.text, refKind: args.refKind }))).id;
    case "context_hotspot_claim":
      // Agent awareness claims a hotspot for the agent that just edited it, in
      // the store the workspace's agents claim through (context.rs twin).
      return (await io.action<{ message: string }>("hotspot_claim", { ptyId: args.ptyId, paths: args.paths, owner: args.owner, note: args.note ?? null })).message;
    // Team memory: the ledger is on this computer, so memorySync.ts copies
    // what agents may be told to the service and takes their proposals back.
    case "workspace_memory_sync":
      return io.action("memory_sync", { root: args.root, entries: args.entries });
    case "workspace_memory_proposals":
      return items(await io.query("memory", "proposals"));
    case "workspace_memory_ack":
      return io.action("memory_ack", { ids: args.ids });
  }
  throw Error(`Unknown harness command ${command}`);
}

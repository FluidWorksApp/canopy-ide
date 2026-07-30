// Typed wrappers around the Tauri command surface. All native work (PTYs, LSP
// servers, fs, watchers) lives in the Rust core; this file is the only place the
// frontend touches IPC.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------- PTY ----------

/** The size a pty agreed to. It is the authority, not the webview — see ptyResize. */
export interface PtyGeometry {
  cols: number;
  rows: number;
}

export interface SpawnResult extends PtyGeometry {
  id: number;
  pid: number | null;
}

export async function ptySpawn(
  opts: {
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
    highWater?: number;
    /** A run tab: the shell runs this one command and exits with its status,
     *  passed as shell args (correct on cmd.exe / PowerShell / POSIX) rather
     *  than typed with a Bourne-only `; exit $?`. */
    runCommand?: string;
    /** Stamped onto the child. A run inside a workspace carries that
     *  workspace's port lease here, so two checkouts can serve at once. */
    env?: [string, string][];
  },
  onData: (bytes: Uint8Array) => void,
): Promise<SpawnResult> {
  const channel = new Channel<ArrayBuffer | number[]>();
  // Raw channel payloads arrive as ArrayBuffer for large chunks but as plain
  // number[] below Tauri's internal direct-execute threshold — handle both.
  channel.onmessage = (data) =>
    onData(
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Uint8Array.from(data),
    );
  return invoke("pty_spawn", { ...opts, onData: channel });
}

// Write/ack/kill/set-title can always lose a race with the session's own exit:
// the Rust reaper removes the session and emits pty:exit while a final ack or
// write is still in flight, and that call then rejects with "no pty session N".
// Every caller is fire-and-forget — a session that is already gone needs
// nothing — so the rejection is swallowed here rather than at a dozen call
// sites, where one missed `void` becomes an unhandled rejection in the log.
// ptyResize is not in this set: it resolves with data its caller uses.
const gone = (p: Promise<void>) => p.catch(() => {});
export const ptyWrite = (id: number, data: string) =>
  gone(invoke<void>("pty_write", { id, data }));
export const ptyAck = (id: number, bytes: number) =>
  gone(invoke<void>("pty_ack", { id, bytes }));
/** Resize the pty; resolves with the size it actually took (clamped to >= 1). */
export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<PtyGeometry>("pty_resize", { id, cols, rows });
export const ptyKill = (id: number) => gone(invoke<void>("pty_kill", { id }));
export const ptyKillAll = () => invoke<void>("pty_kill_all");
export const ptySetTitle = (id: number, title: string) =>
  gone(invoke<void>("pty_set_title", { id, title }));

/** Spawn a PTY with no tab attached to it: a micro-task's agent, which runs its
 *  one job and reports through canopy_job_done. Nothing is announced, so no tab
 *  opens; the Tasks panel watches it by pty id, and `ptyAttach` is how the user
 *  looks at it if they want to. `command` runs as the shell's argument, so the
 *  PTY exits when the agent does. */
export const ptySpawnDetached = (opts: {
  cwd?: string;
  command: string;
  env?: [string, string][];
}) => invoke<SpawnResult>("pty_spawn_detached", opts);

/** The tail of a PTY's raw output, escape sequences and all — the transcript of
 *  a run with no xterm buffer to read. Feed it through renderPtyText (ptyText.ts)
 *  to get something a human can read. */
export const ptyOutput = (id: number, max?: number) =>
  invoke<string | null>("pty_output", { id, max }).catch(() => null);

/** Attach to a PTY that already exists (spawned headless from the remote
 *  portal). Streams the scrollback snapshot first, then live output — the same
 *  byte contract as ptySpawn's onData, but no ack/backpressure: a headless PTY
 *  fans out over a lossy broadcast, so the desktop just consumes. Resolves with
 *  the size the pty is running at, so the tab renders at the same grid. */
export async function ptyAttach(
  id: number,
  onData: (bytes: Uint8Array) => void,
): Promise<PtyGeometry> {
  const channel = new Channel<ArrayBuffer | number[]>();
  channel.onmessage = (data) =>
    onData(
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Uint8Array.from(data),
    );
  return invoke("pty_attach", { id, onData: channel });
}

export interface PtyExit {
  id: number;
  exit_code: number | null;
}
export const onPtyExit = (cb: (e: PtyExit) => void): Promise<UnlistenFn> =>
  listen<PtyExit>("pty:exit", (event) => cb(event.payload));

/** A PTY opened headlessly from the remote portal, announced so the desktop can
 *  open a tab attached to it (via ptyAttach) in the matching project. */
export interface PtySpawned {
  id: number;
  cwd: string;
  title: string;
  cols: number;
  rows: number;
}
export const onPtySpawned = (
  cb: (e: PtySpawned) => void,
): Promise<UnlistenFn> =>
  listen<PtySpawned>("pty:spawned", (event) => cb(event.payload));

/** An action an agent requested through the MCP context bridge (start a run
 *  command, open a preview). `route` is a path used to pick the target project;
 *  the rest is action-specific. Handled the same way as pty:spawned — App
 *  routes it to a project and hands it to that ProjectView. */
export interface AgentAction {
  kind:
    | "start_server"
    | "open_preview"
    | "restart_server"
    | "open_file"
    | "show_diff"
    | "notify"
    | "job_done";
  route: string;
  dir?: string;
  name?: string;
  command?: string;
  url?: string;
  ptyId?: number;
  path?: string;
  line?: number;
  text?: string;
  level?: "info" | "success" | "warn" | "error";
  /** job_done: how the micro-task ended and its one-line summary. */
  status?: "done" | "blocked";
  summary?: string;
}
export const onAgentAction = (
  cb: (a: AgentAction) => void,
): Promise<UnlistenFn> =>
  listen<AgentAction>("agent:action", (event) => cb(event.payload));

// ---------- Native notifications ----------

/** Post an OS notification carrying a deep-link target (see deepLinks.ts).
 *
 *  Not `@tauri-apps/plugin-notification`: that path posts and forgets, so a
 *  click could only ever raise the window. The backend keeps the click and
 *  hands the target back through `onDeepLink`. */
export const notifyNative = (
  title: string,
  body: string,
  target?: string,
): Promise<void> => invoke("notify_native", { title, body, target });

/** A notification the user clicked, or a `canopy://…` forwarded from a second
 *  CLI invocation. The payload is the raw target — parse it with
 *  `parseDeepLink`. */
export const onDeepLink = (cb: (target: string) => void): Promise<UnlistenFn> =>
  listen<string>("deep-link", (event) => cb(event.payload));

/** A browser-control op an agent sent through the MCP bridge (canopy_browser_*).
 *  Request/response: the bridge holds the agent's HTTP request open under `id`
 *  until the answer comes back via `browserResult`. Routed like AgentAction. */
export interface AgentBrowserOp {
  id: number;
  op:
    | "navigate"
    | "snapshot"
    | "click"
    | "type"
    | "point"
    | "eval"
    | "console"
    | "network"
    | "screenshot";
  route: string;
  url?: string | null;
  action?: string | null;
  ref?: number | null;
  selector?: string | null;
  text?: string | null;
  /** point: the caption shown on the cursor while it rests on the element. */
  label?: string | null;
  submit?: boolean | null;
  append?: boolean | null;
  code?: string | null;
  lines?: number | null;
  clear?: boolean | null;
  max?: number | null;
}
export const onAgentBrowser = (
  cb: (op: AgentBrowserOp) => void,
): Promise<UnlistenFn> =>
  listen<AgentBrowserOp>("agent:browser", (event) => cb(event.payload));
/** Answer a browser op: `data` (any JSON value) becomes the tool's result. */
export const browserResult = (id: number, ok: boolean, data: unknown) =>
  // Never rejects: a dropped answer would leave the agent's tool call hanging
  // to its timeout with no trace of why, so failures are logged, not thrown.
  invoke<void>("browser_result", {
    id,
    ok,
    data: JSON.stringify(data ?? null),
  }).catch((err) => console.warn("browser_result failed", id, err));

/** An op only the running UI can answer: a language-server question, the
 *  trackers it holds keys for, a question for the user. Same ticketing as
 *  AgentBrowserOp — answer with `browserResult`. */
export interface AgentUiOp {
  id: number;
  op:
    | "diagnostics"
    | "references"
    | "definition"
    | "hover"
    | "symbols"
    | "tickets"
    | "reviews"
    | "ask"
    | "vault";
  route: string;
  path?: string | null;
  line?: number | null;
  column?: number | null;
  symbol?: string | null;
  /** symbols: a name to search the workspace for, instead of a file to outline. */
  query?: string | null;
  question?: string | null;
  options?: string[];
  /** vault: list | fill | read. */
  vaultOp?: string | null;
  /** vault: a specific entry, when the agent already listed them. */
  entryId?: string | null;
  /** diagnostics: how long the caller will hold. A hook firing after every
   *  edit can't sit through a cold server's first index. */
  waitMs?: number | null;
}
export const onAgentUi = (cb: (op: AgentUiOp) => void): Promise<UnlistenFn> =>
  listen<AgentUiOp>("agent:ui", (event) => cb(event.payload));

/** Which canopy_* tools are switched off (Settings → Agents), pushed to the
 *  bridge so the sidecar can hide them from the agent entirely. */
export const contextTools = (disabled: string[]) =>
  invoke<void>("context_tools", { disabled }).catch(() => {});

/** Advisory file claims agents have taken, for the Agents panel. */
export interface AgentClaim {
  paths: string[];
  owner: string;
  note: string | null;
  at_ms: number;
}
export const contextClaims = () => invoke<AgentClaim[]>("context_claims");
export const contextReleaseClaim = (owner: string) =>
  invoke<void>("context_release_claim", { owner });
export const onAgentClaims = (cb: () => void): Promise<UnlistenFn> =>
  listen("agent:claims", () => cb());

/** PNG (base64) of a rectangle of the app's own webview, via the webview's own
 *  snapshot API — a picture of the preview under the proxy engine, where the
 *  page is an iframe in this window, and of the app's UI anywhere else. Works
 *  with native preview tabs open; child webviews are captured whole by
 *  {@link browserSnapshot} instead. */
export const webviewSnapshot = (
  x: number,
  y: number,
  width: number,
  height: number,
  maxWidth?: number,
) => invoke<string>("webview_snapshot", { x, y, width, height, maxWidth });

/** A line into the app's own log, so a failure in something devtools can't see
 *  — a native child webview — leaves a trace a user can read back. */
export const jsLog = (level: string, message: string) =>
  invoke<void>("js_log", { level, message }).catch(() => {});

/** The scripted browser scenario, when the app was launched to test itself
 *  (`canopy --selftest=browser`). Null on every ordinary launch. */
export interface SelftestConfig {
  scenario: string;
  /** A page the app serves itself, so nothing depends on the network. */
  url: string;
  /** A throwaway directory to open as the project the scenario runs in. */
  projectDir: string;
  reportPath: string;
}

export const selftestConfig = () =>
  invoke<SelftestConfig | null>("selftest_config").catch(() => null);

/** Hand back the report and end the process — 0 if every step passed. */
export const selftestFinish = (report: unknown) =>
  invoke<void>("selftest_finish", { report }).catch(() => {});

/** PNG (base64) of one browser view — the whole child webview, no cropping,
 *  because it is its own view. */
export const browserSnapshot = (tabId: string, maxWidth?: number) =>
  invoke<string>("browser_snapshot", { tabId, maxWidth });

/** JPEG (base64) of a browser view, for the freeze-frame the pane shows while
 *  the view is hidden behind an overlay. Lossy and half-size on purpose: it is
 *  a still under a dialog, and it travels every time a menu opens. */
export const browserFrame = (tabId: string, maxWidth?: number) =>
  invoke<string>("browser_frame", { tabId, maxWidth });

// ---------- Embedded browser (webview engine) ----------

/** Whether this platform can host a real child webview at all. Everywhere it
 *  can't, preview tabs fall back to the proxy engine. */
export const browserSupported = () =>
  invoke<boolean>("browser_supported").catch(() => false);

/** Create the view for a tab, or point an existing one at `url`. */
export const browserOpen = (
  tabId: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
  background?: [number, number, number],
) => invoke<void>("browser_open", { tabId, url, x, y, width, height, background });

export const browserNavigate = (
  tabId: string,
  url?: string | null,
  action?: string | null,
) => invoke<void>("browser_navigate", { tabId, url, action });

export const browserSetBounds = (
  tabId: string,
  x: number,
  y: number,
  width: number,
  height: number,
) => invoke<void>("browser_set_bounds", { tabId, x, y, width, height });

export const browserSetVisible = (tabId: string, visible: boolean) =>
  invoke<void>("browser_set_visible", { tabId, visible });

/** Whether the page has ever rendered a frame — which "loaded" does not
 *  imply. A page that loads while its view is hidden never paints, and shows
 *  blank when the view finally appears. */
export const browserPainted = (tabId: string) =>
  invoke<boolean>("browser_painted", { tabId });

export const browserClose = (tabId: string) =>
  invoke<void>("browser_close", { tabId }).catch(() => {});

/** Run one agent browser op against the page. Read-only ops answer here;
 *  anything cursor-led reports `done: false` and lands on `onBrowserEvents`. */
export interface BrowserOpAck {
  done: boolean;
  ok?: boolean;
  data?: unknown;
}
export const browserRunOp = (tabId: string, op: Record<string, unknown>) =>
  invoke<BrowserOpAck | null>("browser_run_op", { tabId, op });

/** A host->page command with no answer: annotate mode, badge sync, navigate. */
export const browserCommand = (tabId: string, message: Record<string, unknown>) =>
  invoke<void>("browser_command", { tabId, message });

/** Where the page thinks it is, for in-page navigations the load hook can't
 *  see. */
export const browserHere = (tabId: string) =>
  invoke<{ url: string; title: string } | null>("browser_here", { tabId });

/** Wipe the shared browser profile — cookies, storage, caches, every site. */
export const browserClearData = () => invoke<void>("browser_clear_data");

/** Messages a page pushed up: agent-op results, annotations, in-page
 *  navigations, the ready announcement after every load. */
export interface BrowserEvents {
  tabId: string;
  events: Record<string, unknown>[];
}
export const onBrowserEvents = (
  cb: (e: BrowserEvents) => void,
): Promise<UnlistenFn> =>
  listen<BrowserEvents>("browser:events", (event) => cb(event.payload));

export interface BrowserNav {
  tabId: string;
  url: string;
  loading: boolean;
}
export const onBrowserNav = (cb: (n: BrowserNav) => void): Promise<UnlistenFn> =>
  listen<BrowserNav>("browser:nav", (event) => cb(event.payload));

/** target=_blank / window.open, which the view refuses to spawn a real window
 *  for — the tab follows the link itself instead. */
export interface BrowserPopup {
  tabId: string;
  url: string;
}
export const onBrowserPopup = (
  cb: (p: BrowserPopup) => void,
): Promise<UnlistenFn> =>
  listen<BrowserPopup>("browser:popup", (event) => cb(event.payload));

// ---------- Workspaces / FS ----------

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const workspaceAdd = (path: string) =>
  invoke<string>("workspace_add", { path });
export const workspaceRemove = (path: string) =>
  invoke<void>("workspace_remove", { path });
export const workspaceList = () => invoke<string[]>("workspace_list");
export const fsReadDir = (path: string) =>
  invoke<DirEntry[]>("fs_read_dir", { path });
export const fsWriteFile = (path: string, content: string) =>
  invoke<void>("fs_write_file", { path, content });
export const fsStat = (path: string) =>
  invoke<{ is_dir: boolean; size: number; modified_ms: number | null }>(
    "fs_stat",
    { path },
  );

export async function fsReadFile(path: string): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer | number[]>("fs_read_file", { path });
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : Uint8Array.from(data);
}

const textDecoder = new TextDecoder();
export async function fsReadText(path: string): Promise<string> {
  return textDecoder.decode(await fsReadFile(path));
}

// ---------- agent instructions ----------

/** One instruction file an agent reads — a CLAUDE.md, an AGENTS.md, a SKILL.md,
 *  a subagent definition. `exists: false` is a real row: a project set up with a
 *  CLI that has no instruction file yet still lists it, so it can be created.
 *  See src-tauri/src/instructions.rs for where each one lives and who reads it. */
export interface InstructionFile {
  path: string;
  /** instructions | rule | skill | subagent | command | style */
  kind: string;
  /** project | global */
  scope: string;
  /** Agent registry ids (projects.ts) that read this file. */
  agents: string[];
  /** Display name relative to its root; `~/`-prefixed when global. */
  label: string;
  /** Workspace root it belongs to; "" for global files. */
  root: string;
  exists: boolean;
  bytes: number;
  /** Unix seconds. */
  modified: number | null;
  /** `name` / `description` from YAML frontmatter, for skills and subagents. */
  title: string | null;
  description: string | null;
}

export const instructionsScan = (roots: string[]) =>
  invoke<InstructionFile[]>("instructions_scan", { roots });

// `roots` rides along on read/write too: the backend re-derives the allowlist
// from them rather than trusting that a path came from a previous scan.
export const instructionsRead = (path: string, roots: string[]) =>
  invoke<string>("instructions_read", { path, roots });

export const instructionsWrite = (
  path: string,
  roots: string[],
  content: string,
) => invoke<void>("instructions_write", { path, roots, content });

export interface GitStatusResult {
  is_repo: boolean;
  branch: string | null;
  entries: { status: string; path: string }[];
}
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** Flat file list under roots — the quick-open corpus (bounded in Rust). */
export const fsListFiles = (roots: string[], limit?: number) =>
  invoke<string[]>("fs_list_files", { roots, limit });

export const fsSearch = (roots: string[], query: string, limit?: number) =>
  invoke<SearchHit[]>("fs_search", { roots, query, limit });

// ---------- SpotSearch index (spot.rs) ----------
// The persistent half of the palette: FTS5 over agent transcripts and terminal
// scrollback. Everything else SpotSearch shows is queried live in the frontend.

export interface SpotIndexHit {
  /** "transcript" | "terminal". */
  kind: string;
  /** Session id for a transcript, "pty:<id>" for a terminal. */
  key: string;
  /** Registry id of the CLI that wrote it, or "terminal". */
  agent: string;
  /** Where the conversation was running. */
  cwd: string;
  /** Tab title for a terminal; empty for a transcript. */
  title: string;
  snippet: string;
  /** The file the hit came from — a transcript path, or the terminal's cwd. */
  meta: string;
  ts: number;
}

export interface SpotIngestReport {
  more: boolean;
  /** Transcript bytes still unread when the call returned — what makes a
   *  catching-up index legible as progress rather than as a rising number. */
  pending: number;
  messages: number;
  terminals: number;
  /** Research entries in the index after this call. */
  research: number;
  /** Documents dropped: vanished files, disabled agents, retention. */
  pruned: number;
}

export interface SpotIndexStats {
  messages: number;
  sessions: number;
  terminals: number;
  bytes: number;
  /** [registry id, messages], busiest first. */
  by_agent: [string, number][];
}

export interface SpotIngestOptions {
  /** Registry ids to index. An agent left out is purged, not just skipped. */
  agents: string[];
  terminals: boolean;
  /** The open project's directories — how the per-project stores (gemini,
   *  aider) are found at all. */
  roots: string[];
  /** Drop transcript messages older than this. 0 keeps everything. */
  retentionDays: number;
}

/** Bring the index up to date; call again while `more`. */
export const spotIngest = (opts: SpotIngestOptions) =>
  invoke<SpotIngestReport>("spot_ingest", {
    agents: opts.agents,
    terminals: opts.terminals,
    roots: opts.roots,
    retentionDays: opts.retentionDays,
  });

/** Search the index. `roots` scopes to the open project; `allProjects` asks
 *  across every project on the machine instead. */
export const spotSearch = (
  query: string,
  limit?: number,
  roots?: string[],
  allProjects?: boolean,
) => invoke<SpotIndexHit[]>("spot_search", { query, limit, roots, allProjects });

/** What the index holds right now (Settings → SpotSearch). */
export const spotIndexStats = () => invoke<SpotIndexStats>("spot_index_stats");

// ---------- Credential vault ----------
//
// The password never crosses this boundary in the fill direction: `vaultFill`
// sends two ids and the backend puts the value into the page itself. Only
// `vaultReveal` (the user's own click in Settings) and `vaultRead` (an entry
// the user marked readable, after an approval prompt) ever return plaintext.

export interface VaultStatus {
  /** A vault file exists on disk — "unlock" rather than "create one". */
  exists: boolean;
  unlocked: boolean;
  entries: number;
  auto_lock_minutes: number;
}

/** An entry without its password — what the UI lists and what agents are told. */
export interface VaultItem {
  id: string;
  label: string;
  domain: string;
  username: string;
  readable: boolean;
  notes: string;
  updated: number;
}

export interface VaultApproval {
  domain: string;
  fill: boolean;
  read: boolean;
  granted: number;
}

/** What a fill did — which fields took a value, never the value. */
export interface VaultFillReport {
  filled: string[];
  label: string;
  domain: string;
  form: boolean;
}

export const vaultStatus = () => invoke<VaultStatus>("vault_status");
export const vaultCreate = (passphrase: string) =>
  invoke<void>("vault_create", { passphrase });
export const vaultUnlock = (passphrase: string) =>
  invoke<void>("vault_unlock", { passphrase });
export const vaultLock = () => invoke<void>("vault_lock");
export const vaultChangePassphrase = (old: string, next: string) =>
  invoke<void>("vault_change_passphrase", { old, new: next });
export const vaultList = () => invoke<VaultItem[]>("vault_list");
/** Entries whose domain covers this URL's host, most specific first. */
export const vaultMatches = (url: string) =>
  invoke<VaultItem[]>("vault_matches", { url });
export const vaultSave = (entry: {
  id?: string;
  label: string;
  domain: string;
  username: string;
  /** Omitted means "keep the stored password" — editing a label never has to
   *  hold the secret. */
  password?: string;
  readable?: boolean;
  notes?: string;
}) => invoke<string>("vault_save", entry);
export const vaultDelete = (id: string) => invoke<void>("vault_delete", { id });
/** Plaintext for the user's own eyes, from Settings. */
export const vaultReveal = (id: string) => invoke<string>("vault_reveal", { id });
/** Plaintext for an agent — only for an entry marked readable. */
export const vaultRead = (id: string) =>
  invoke<{ username: string; password: string }>("vault_read", { id });
/** Put an entry into the page in `tabId`. Returns which fields took a value. */
export const vaultFill = (tabId: string, id: string) =>
  invoke<VaultFillReport>("vault_fill", { tabId, id });
/** One row a .kdbx import could not take, and why. */
export interface VaultSkipped {
  title: string;
  why: string;
}

export interface VaultImportReport {
  imported: number;
  /** Already in the vault under the same site and username. */
  duplicates: number;
  skipped: VaultSkipped[];
}

/** Merge a KeePass export into the vault. Existing entries are never
 *  overwritten, and imported ones are always fill-only. */
export const vaultImportKdbx = (path: string, password: string) =>
  invoke<VaultImportReport>("vault_import_kdbx", { path, password });

export const vaultApprovals = () => invoke<VaultApproval[]>("vault_approvals");
export const vaultApprove = (domain: string, op: "fill" | "read") =>
  invoke<void>("vault_approve", { domain, op });
export const vaultRevoke = (domain: string) =>
  invoke<void>("vault_revoke", { domain });

// ---------- Research ----------
//
// Every one of these carries a projectId, and the backend resolves nothing on
// its own: research is scoped to one project by construction, on this side as
// on the agents' (see /ctx/research in context.rs).

export type ResearchStatus =
  | "open"
  | "researching"
  | "researched"
  | "implementing"
  | "implemented"
  | "blocked"
  | "superseded"
  | "archived";

export interface ResearchPrLink {
  repo: string;
  number: number;
  url: string;
  /** "open" | "merged" | "closed" — kept current by the PR watcher, which is
   *  what lets an entry reach `implemented` without anyone asserting it. */
  state: string;
}

export interface ResearchTicketLink {
  id: string;
  title: string;
  url: string;
}

export interface ResearchLinks {
  tickets: ResearchTicketLink[];
  prs: ResearchPrLink[];
  branches: string[];
  files: string[];
  supersedes: string[];
  superseded_by: string | null;
}

export interface ResearchSource {
  /** Relative to the entry directory, always under `sources/`. */
  file: string;
  title: string;
  origin: string;
  bytes: number;
}

export interface ResearchHistory {
  at: number;
  from: string;
  to: string;
  by: string;
  note: string;
}

/** A list row — the one paragraph, never the whole entry. */
export interface ResearchSummary {
  id: string;
  title: string;
  status: ResearchStatus;
  digest: string;
  tags: string[];
  agent: string;
  created_at: number;
  updated_at: number;
  source_count: number;
  pr_count: number;
  superseded_by: string | null;
}

export interface ResearchDetail extends ResearchSummary {
  question: string;
  recommendation: string;
  open_questions: string[];
  body: string;
  sources: ResearchSource[];
  links: ResearchLinks;
  history: ResearchHistory[];
  /** Absolute path to the entry directory. */
  dir: string;
}

export const researchList = (
  projectId: string,
  status?: ResearchStatus[],
  limit?: number,
) => invoke<ResearchSummary[]>("research_list", { projectId, status, limit });

export const researchSearch = (projectId: string, query: string, limit?: number) =>
  invoke<ResearchSummary[]>("research_search", { projectId, query, limit });

export const researchGet = (projectId: string, id: string) =>
  invoke<ResearchDetail>("research_get", { projectId, id });

export interface ResearchStartArgs {
  projectId: string;
  projectName?: string;
  roots?: string[];
  title: string;
  question?: string;
  agent?: string;
  cwd?: string;
  ptyId?: number;
  tags?: string[];
}

export const researchStart = (args: ResearchStartArgs) =>
  invoke<ResearchSummary>("research_start", { ...args });

export interface ResearchUpdateArgs {
  projectId: string;
  id: string;
  title?: string;
  digest?: string;
  recommendation?: string;
  openQuestions?: string[];
  tags?: string[];
  append?: string;
  body?: string;
}

export const researchUpdate = (args: ResearchUpdateArgs) =>
  invoke<ResearchSummary>("research_update", { ...args });

export const researchSetStatus = (
  projectId: string,
  id: string,
  status: ResearchStatus,
  by?: string,
  note?: string,
) => invoke<ResearchSummary>("research_set_status", { projectId, id, status, by, note });

export interface ResearchLinkArgs {
  projectId: string;
  id: string;
  pr?: ResearchPrLink;
  ticket?: ResearchTicketLink;
  branch?: string;
  files?: string[];
  supersedes?: string;
}

export const researchLink = (args: ResearchLinkArgs) =>
  invoke<ResearchDetail>("research_link", { ...args });

/** Read a source or artifact. The store lives outside every registered
 *  workspace root, so fs_read_file cannot reach it — this is the only reader. */
export const researchReadFile = (projectId: string, id: string, path: string) =>
  invoke<string>("research_read_file", { projectId, id, path });

/** Where an entry lives — exported to a research session as
 *  CANOPY_RESEARCH_DIR, which is what the PreToolUse gate compares against. */
export const researchDir = (projectId: string, id: string) =>
  invoke<string>("research_dir", { projectId, id });

/** Adopt a markdown file already in the repo as a research entry. Mechanical
 *  and instant — no agent — so the digest it derives is the file's own opening
 *  paragraph; Continue research is what improves on that. */
export const researchImport = (args: {
  projectId: string;
  projectName?: string;
  roots?: string[];
  path: string;
  instance?: string;
}) => invoke<ResearchSummary>("research_import", { ...args });

/** The entry that already adopted this file, if one has. */
export const researchForFile = (projectId: string, path: string) =>
  invoke<string | null>("research_for_file", { projectId, path });

export const researchDelete = (projectId: string, id: string) =>
  invoke<void>("research_delete", { projectId, id });

/** One PR's state — "OPEN", "MERGED" or "CLOSED". The watcher only holds open
 *  PRs, so this is the only way to tell a merge from a close. */
export const ghPrState = (repo: string, number: number) =>
  invoke<string>("gh_pr_state", { repo, number });

/** Empty the index. Everything in it is derived, so this costs recall until
 *  the next ingest and nothing else. */
export const spotIndexClear = () => invoke<void>("spot_index_clear");

/** Persist a captured page screenshot under `<dir>/.canopy/spot/` so a task
 *  brief can point an agent at it. Returns the absolute path. */
export const spotSaveContextImage = (dir: string, base64Png: string) =>
  invoke<string>("spot_save_context_image", { dir, base64Png });

/** Persist a brief too long to type at a shell prompt (see agentSeed.ts) under
 *  `<dir>/.canopy/spot/`, and return its path for the agent to read. */
export const spotSaveContextText = (dir: string, text: string) =>
  invoke<string>("spot_save_context_text", { dir, text });

// ---------- file management ----------

export const fsCreateFile = (path: string) =>
  invoke<string>("fs_create_file", { path });
export const fsCreateDir = (path: string) =>
  invoke<string>("fs_create_dir", { path });
export const fsRename = (from: string, to: string) =>
  invoke<string>("fs_rename", { from, to });
/** Moves to the OS trash — recoverable, unlike an unlink. */
export const fsTrash = (path: string) => invoke<void>("fs_trash", { path });
export const fsReveal = (path: string) => invoke<void>("fs_reveal", { path });
export const fsDuplicate = (path: string) =>
  invoke<string>("fs_duplicate", { path });

export const gitStatus = (path: string) =>
  invoke<GitStatusResult>("git_status", { path });
export const gitHeadContent = (path: string) =>
  invoke<string | null>("git_head_content", { path });

export interface ClaudeSessionStats {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  turns: number;
}
export const claudeSessionStats = (transcriptPath: string) =>
  invoke<ClaudeSessionStats>("claude_session_stats", { transcriptPath });

/** One agent session's token/cost usage, summed across its turns. `cost` is
 *  set only when the CLI records its own (omp); otherwise estimate from
 *  `model`. `supported` is false for CLIs whose usage Canopy can't read yet
 *  (amp/aider/opencode) — the row is returned so the CLI mix stays honest. */
export interface AgentSessionUsage {
  session_id: string;
  agent: string;
  cwd: string;
  title: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost: number | null;
  turns: number;
  updated: number;
  supported: boolean;
}
/** Usage for every session Canopy knows, across all supported CLIs. Drives the
 *  Statistics panel and the status-tray grand total. */
export const agentUsage = () => invoke<AgentSessionUsage[]>("agent_usage");

/** One rolling subscription window ("5h", "7d") and how much of it is gone. */
export interface PlanWindow {
  label: string;
  used_percent: number;
  resets_at: number | null;
}
/** A CLI's subscription headroom — the cap side of usage, as opposed to the
 *  spend side in AgentSessionUsage. Only CLIs that actually report appear. */
export interface PlanUsage {
  agent: string;
  plan: string | null;
  windows: PlanWindow[];
  credits: number | null;
  /** Unix seconds these numbers were last true; they persist across the gap
   *  where a rate-limited request returns no limit headers. */
  observed: number;
}
export const planUsage = () => invoke<PlanUsage[]>("plan_usage");

export interface FsChange {
  root: string;
  paths: string[];
  kind: "create" | "modify" | "remove" | "other";
}
export const onFsChange = (cb: (e: FsChange) => void): Promise<UnlistenFn> =>
  listen<FsChange>("fs:change", (event) => cb(event.payload));

export interface GitChange {
  root: string;
}
/** "Whatever git would say about this root just changed" — a commit, a stage,
 *  a branch switch, a fetch, or a plain edit to a tracked file.
 *
 *  This is what replaced the git polls. `fs:change` can't do the job: the
 *  watcher filters `.git` out of it (and must — the file tree does not want
 *  object churn), so everything an agent does with git in a terminal was
 *  invisible to it, which is precisely why every git surface kept a
 *  `setInterval` running. The debounce lives in Rust, once, so a burst like a
 *  commit's five writes is one event here rather than five refreshes per
 *  panel. */
export const onGitChange = (cb: (e: GitChange) => void): Promise<UnlistenFn> =>
  listen<GitChange>("git:change", (event) => cb(event.payload));

// ---------- Context bridge (agent-facing MCP context) ----------

/** Publish a project's live context snapshot (components, run servers,
 *  agents) to the Rust bridge that the `canopy-hook --mcp` sidecar serves to
 *  agents. Fire-and-forget: stale context must never break the UI. */
export const contextPublish = (projectId: string, data: string) =>
  invoke<void>("context_publish", { projectId, data }).catch(() => {});
export const contextRemove = (projectId: string) =>
  invoke<void>("context_remove", { projectId }).catch(() => {});

// ---------- Preview proxy ----------

export interface PreviewInfo {
  port: number;
  origin: string;
}
/** Start (or reuse) the annotating reverse proxy for a target origin. */
export const previewStart = (target: string) =>
  invoke<PreviewInfo>("preview_start", { target });
export const previewStop = (origin: string) =>
  invoke<void>("preview_stop", { origin });

// ---------- LSP ----------

export async function lspStart(
  command: string,
  args: string[],
  root: string,
  onMessage: (message: string) => void,
): Promise<number> {
  const channel = new Channel<string>();
  channel.onmessage = onMessage;
  return invoke("lsp_start", { command, args, root, onMessage: channel });
}
export const lspSend = (id: number, message: string) =>
  invoke<void>("lsp_send", { id, message });
export const lspStop = (id: number) => invoke<void>("lsp_stop", { id });
export const onLspExit = (cb: (id: number) => void): Promise<UnlistenFn> =>
  listen<number>("lsp:exit", (event) => cb(event.payload));

// ---------- Agents / process stats ----------

export interface ProcInfo {
  pid: number;
  parent: number | null;
  name: string;
  cmd: string;
  cpu: number;
  mem_bytes: number;
}
/** What a terminal is running, resolved from the process the pty has in the
 *  foreground — evidence, not a verdict. `bin` is the invoked name with any
 *  language runtime already seen through (`python train.py` is `train.py`, not
 *  `Python`); `pkg` is the package that ships it (`npm:@anthropic-ai/claude-code`,
 *  `brew:omp`, `py:aider`), which is what survives a renamed or wrapped binary;
 *  `path` is the canonical executable, stable enough to key a learned mapping
 *  on. Turning this into an agent id is agentIdentity.ts's job. */
export interface AgentHint {
  bin: string;
  pkg: string | null;
  path: string | null;
  /** The foreground app holds the tty in raw mode — something interactive is
   *  in control, not a script printing lines. */
  interactive: boolean;
}
export interface SessionStats {
  id: number;
  title: string;
  cwd: string;
  total_cpu: number;
  total_mem_bytes: number;
  procs: ProcInfo[];
  /** TCP ports anything in this session is listening on, ascending. */
  ports: number[];
  /** Absent when the terminal is an idle shell. */
  agent_hint: AgentHint | null;
}
export const onPtyStats = (
  cb: (stats: SessionStats[]) => void,
): Promise<UnlistenFn> =>
  listen<SessionStats[]>("pty:stats", (event) => cb(event.payload));

export interface AppStats {
  cpu: number;
  mem_bytes: number;
  procs: number;
}

/** Whole-app footprint (this process + every descendant), emitted every 2s. */
export const onAppStats = (cb: (s: AppStats) => void): Promise<UnlistenFn> =>
  listen<AppStats>("app:stats", (e) => cb(e.payload));

export const killProcess = (pid: number) =>
  invoke<void>("kill_process", { pid });
export const hookBridgePath = () => invoke<string | null>("hook_bridge_path");
/** Whether our hooks are already written into an agent CLI's config — lets the
 *  panel tell "not set up" (offer setup) from "set up, but the agent predates
 *  it" (restart to stream) rather than nagging on a missing digest alone. */
export const agentHooksInstalled = (agent: string) =>
  invoke<boolean>("agent_hooks_installed", { agent });

/** One step of one agent's setup. Steps are reported apart because they fail
 *  apart: an unparseable MCP registry says nothing about whether the hooks
 *  landed, and collapsing them lost one result behind the other's error. */
export interface SetupStep {
  step: string;
  ok: boolean;
  message: string;
}
export interface SetupReport {
  agent: string;
  /** True only when every step succeeded. */
  ok: boolean;
  steps: SetupStep[];
  /** One line, naming the agent and any step that failed. */
  summary: string;
}
export const setupAgentHooks = (agent: string) =>
  invoke<SetupReport>("setup_agent_hooks", { agent });

/** State of one half of one CLI's integration: `ours` (points at our helper),
 *  `missing`, `foreign` (someone else took the name — never touched),
 *  `unreadable`, or `unsupported` (no such integration point for this CLI). */
export interface IntegrationHealth {
  agent: string;
  cli_installed: boolean;
  hooks: string;
  mcp: string;
}
export interface HealthReport {
  version: string;
  upgraded: boolean;
  agents: IntegrationHealth[];
  repaired: string[];
  failed: string[];
}
export const agentIntegrationHealth = () =>
  invoke<IntegrationHealth[]>("agent_integration_health");

/** One config file's claim on an MCP server. A server configured in four CLIs
 *  arrives as one McpServer carrying four of these. */
export interface McpSource {
  agent: string;
  /** CLI plus scope, as the panel shows it: "Claude Code (project)". */
  label: string;
  /** The name it has in *this* config — CLIs rarely agree. */
  name: string;
  config_path: string;
  scope: "global" | "project";
  /** "pending" is a `.mcp.json` server nobody has approved or rejected yet. */
  status: "enabled" | "disabled" | "pending";
}
/** One MCP server, folded across every CLI that configures it. Credentials are
 *  stripped in Rust: `args` is redacted and `env_keys` holds names only, so
 *  there is no value here to leak. */
export interface McpServer {
  key: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  url: string | null;
  env_keys: string[];
  sources: McpSource[];
  enabled: boolean;
}
/** Every MCP server configured on this machine. Reads config files only — no
 *  server is started or connected to, so this is cheap to call on panel open.
 *  Pass the project's component roots to include their `.mcp.json` and the CLIs'
 *  per-project registries; pass none for the user-scope answer alone. */
export const mcpServers = (projectDirs: string[] = []) =>
  invoke<McpServer[]>("mcp_servers", { projectDirs });

/** One tool a server exposes. `input_schema` is the server's own JSON Schema,
 *  passed through untouched — the argument form is generated from it. */
export interface McpTool {
  name: string;
  title: string | null;
  description: string | null;
  input_schema: JsonSchema;
  output_schema: JsonSchema | null;
  /** `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`,
   *  verbatim. What the run button uses to decide whether to warn first. */
  annotations: Record<string, unknown> | null;
}

/** As much JSON Schema as an argument form can act on. Anything richer is still
 *  shown — the raw-JSON editor takes whatever the server asks for. */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  [key: string]: unknown;
}

/** A prompt or a resource: listed so a server's whole surface is visible, not
 *  driven the way tools are. */
export interface McpNamed {
  name: string;
  description: string | null;
  uri: string | null;
  mime_type: string | null;
}

/** A live connection's answer to "what do you expose?". */
export interface McpSession {
  key: string;
  /** The name the *server* gives itself, which is often not the config's. */
  server_name: string | null;
  server_version: string | null;
  protocol_version: string | null;
  instructions: string | null;
  tools: McpTool[];
  prompts: McpNamed[];
  resources: McpNamed[];
  capabilities: string[];
  /** What the user actually waited, cold start included. */
  elapsed_ms: number;
}

/** One tool call. `is_error` is the tool saying no; a rejected call rejects the
 *  promise instead — the difference is "it ran and refused" vs "it never ran". */
export interface McpCallResult {
  content: McpContent[];
  is_error: boolean;
  structured: unknown | null;
  elapsed_ms: number;
}

/** A block of a tool's answer. Only `text` is rendered as itself; the rest are
 *  described, since the panel is not the place to open a PDF. */
export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [key: string]: unknown;
}

/** Start the server if it isn't running and list what it exposes. Costs a cold
 *  start the first time — `npx` may fetch the package — and is cheap after,
 *  because the connection is pooled until it goes idle. `refresh` throws the
 *  pooled connection away first, for when the user has just edited the config. */
export const mcpConnect = (key: string, refresh = false) =>
  invoke<McpSession>("mcp_connect", { key, refresh });

/** Run one tool against a connected server. */
export const mcpCallTool = (
  key: string,
  tool: string,
  args: Record<string, unknown>,
) => invoke<McpCallResult>("mcp_call_tool", { key, tool, arguments: args });

/** Stop the server — for stdio, kill the process. */
export const mcpDisconnect = (key: string) =>
  invoke<void>("mcp_disconnect", { key });

/** Keys of the servers currently connected, so the list can mark them live. */
export const mcpConnected = () => invoke<string[]>("mcp_connected");
/** The launch's integration report if the pass has already finished. It runs
 *  before the webview does, so the event below can fire with nobody listening —
 *  ask for this on mount and take whichever arrives first. */
export const agentHealthReport = () =>
  invoke<HealthReport | null>("agent_health_report");
/** What the launch's integration pass found and did. Emitted once per start. */
export const onIntegrationHealth = (
  cb: (r: HealthReport) => void,
): Promise<UnlistenFn> =>
  listen<HealthReport>("agents:health", (e) => cb(e.payload));
/** This app launch's instance tag — pair with SessionDigest.instance so a
 *  digest from another instance/run can't bind to this instance's terminals. */
export const instanceId = () => invoke<string>("instance_id");
/** One batch per hook-bridge poll (500ms): every new JSONL line since the
 *  last, so a busy agent costs one React commit per window, not one per line. */
export const onAgentEvents = (
  cb: (lines: string[]) => void,
): Promise<UnlistenFn> =>
  listen<string[]>("agent:events", (event) => cb(event.payload));

// ---------- git ----------

export interface RepoInfo {
  path: string;
  name: string;
  components: string[];
  branch: string | null;
  detached: boolean;
}

export interface FileChange {
  status: string;
  path: string;
  abs: string;
  staged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface RepoStatus {
  path: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
  conflicted: FileChange[];
}

export interface BranchInfo {
  /** Logical branch name — never an `origin/…` tracking ref. */
  name: string;
  current: boolean;
  /** On a remote but not checked out locally; selecting it checks it out. */
  remote_only: boolean;
  /** A local branch that also exists on the remote (already pushed). */
  synced: boolean;
  subject: string;
  /** An integration branch, or this repo's actual base. Decided in the backend
   *  because only it knows what the base is. */
  protected: boolean;
}

export interface CommitInfo {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  refs: string;
}

export const gitRepos = (components: [string, string][]) =>
  invoke<RepoInfo[]>("git_repos", { components });
export const gitRepoStatus = (repo: string) =>
  invoke<RepoStatus>("git_repo_status", { repo });
export const gitBranches = (repo: string) =>
  invoke<BranchInfo[]>("git_branches", { repo });
/** The worktree standing between you and a branch — git allows a branch in one
 *  checkout at a time. */
export interface BranchHolder {
  branch: string;
  path: string;
  name: string;
  /** A workspace Canopy made for an agent (under `.claude/worktrees`). */
  agent: boolean;
  is_main: boolean;
  dirty: number;
  locked: string | null;
  prunable: string | null;
  head: string;
}

/** What a branch switch did, or why it couldn't. Every refusal a person can
 *  resolve comes back as an outcome, not a thrown error — the UI turns these
 *  into choices instead of showing git's stderr. */
export type CheckoutOutcome =
  | {
      kind: "switched";
      message: string;
      /** The checkout to work in when it isn't the repo root — a workspace we
       *  landed in or created. Null means "here". */
      path?: string | null;
    }
  | { kind: "branch_in_worktree"; holder: BranchHolder }
  | {
      kind: "local_changes";
      files: string[];
      untracked: boolean;
      detail: string;
    }
  | { kind: "changes_stashed"; stash: string; detail: string }
  /** A half-finished merge/rebase/cherry-pick/revert/am, or another git process
   *  holding the index. */
  | {
      kind: "repo_busy";
      operation:
        | "merge"
        | "rebase"
        | "cherry-pick"
        | "revert"
        | "am"
        | "another-command";
      detail: string;
    }
  /** No branch, tag or commit of that name is here. `can_create` means the name
   *  is legal and free, so starting it here is a real way out. */
  | {
      kind: "nothing_called";
      name: string;
      can_create: boolean;
      detail: string;
    }
  /** A create-shaped request refused because the name is taken. */
  | { kind: "name_taken"; branch: string; detail: string }
  /** A workspace couldn't go there. `usable` means the path is a worktree of
   *  this repo, so opening it as it stands is safe. */
  | { kind: "path_in_use"; path: string; usable: boolean; detail: string }
  /** GitHub couldn't be reached, or doesn't have what we asked it for. */
  | { kind: "remote_unreachable"; summary: string; detail: string }
  /** The switch worked, but left a detached HEAD's commits on no branch. Git
   *  says this and exits 0, so nothing else would mention it. `commits` is
   *  "<short> <subject>", newest first. */
  | {
      kind: "switched_with_leftovers";
      message: string;
      commits: string[];
      detail: string;
    }
  | { kind: "failed"; summary: string; detail: string };

export const gitCheckout = (repo: string, branch: string, create = false) =>
  invoke<CheckoutOutcome>("git_checkout", { repo, branch, create });
/** Check out a ref without moving any branch onto it — look, then leave. */
export const gitCheckoutDetached = (repo: string, refname: string) =>
  invoke<CheckoutOutcome>("git_checkout_detached", { repo, refname });
/** Switch, carrying this checkout's uncommitted changes across. */
export const gitCheckoutCarry = (repo: string, branch: string) =>
  invoke<CheckoutOutcome>("git_checkout_carry", { repo, branch });
/** Free a branch name from the worktree holding it. That worktree keeps every
 *  file it has — it just stops claiming the name. A locked workspace comes back
 *  as `branch_in_worktree` so the caller can re-ask, not as an error. */
export const gitBranchRelease = (repo: string, branch: string) =>
  invoke<CheckoutOutcome>("git_branch_release", { repo, branch });
/** Call off a half-finished merge/rebase/cherry-pick/revert/am. Only the
 *  operation's bookkeeping is dropped; every file stays exactly as it is. */
export const gitOperationQuit = (repo: string) =>
  invoke<string>("git_operation_quit", { repo });
/** Give a commit a branch name without checking it out — how a commit a switch
 *  left reachable from nothing gets kept, without moving you off where you just
 *  landed. */
export const gitBranchAt = (repo: string, name: string, commit: string) =>
  invoke<string>("git_branch_at", { repo, name, commit });
/** Delete a local branch. `force` (git -D) is needed for a squash-merged branch
 *  whose remote is gone; otherwise the safe -d refuses unmerged work. Protected
 *  and current branches are refused by the backend. */
export const gitBranchDelete = (repo: string, branch: string, force = false) =>
  invoke<string>("git_branch_delete", { repo, branch, force });
/** Delete a branch on the remote — `git push origin --delete`. The remote twin
 *  of gitBranchDelete; a fully-cleaned branch needs both. Protected branches are
 *  refused by the backend. */
export const gitBranchDeleteRemote = (repo: string, branch: string) =>
  invoke<string>("git_branch_delete_remote", { repo, branch });
export const gitStage = (repo: string, paths: string[]) =>
  invoke<void>("git_stage", { repo, paths });
export const gitUnstage = (repo: string, paths: string[]) =>
  invoke<void>("git_unstage", { repo, paths });
/** Throw away changes: tracked paths are restored from HEAD (staged or not),
 *  untracked ones are deleted. Unrecoverable — confirm before calling. */
export const gitDiscard = (
  repo: string,
  tracked: string[],
  untracked: string[],
) => invoke<void>("git_discard", { repo, tracked, untracked });
export const gitCommit = (repo: string, message: string, amend = false) =>
  invoke<string>("git_commit", { repo, message, amend });
export const gitFetch = (repo: string) => invoke<string>("git_fetch", { repo });
export const gitPull = (repo: string) => invoke<string>("git_pull", { repo });
export const gitPush = (repo: string, setUpstream = false) =>
  invoke<string>("git_push", { repo, setUpstream });
/** Clone `url` into `parent` (a folder the user picked). Returns the new
 *  working tree so the caller can register it as a project component. */
export interface CloneResult {
  path: string;
  name: string;
}
export const gitClone = (parent: string, url: string) =>
  invoke<CloneResult>("git_clone", { parent, url });
export const gitDiff = (repo: string, path: string, staged: boolean) =>
  invoke<string>("git_diff", { repo, path, staged });
export interface CommitDetail {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  refs: string;
  parents: string[];
}

export interface CommitPatch {
  patch: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
}

export const gitCommitDetail = (repo: string, hash: string) =>
  invoke<CommitDetail>("git_commit_detail", { repo, hash });

export const gitCommitPatch = (repo: string, hash: string) =>
  invoke<CommitPatch>("git_commit_patch", { repo, hash });

export const gitLog = (repo: string, limit?: number) =>
  invoke<CommitInfo[]>("git_log", { repo, limit });

// ---------- pull requests (gh) ----------

export interface PrInfo {
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  state: string;
  url: string;
  created: string;
  updated: string;
  review_decision: string;
  additions: number;
  deletions: number;
  mine: boolean;
  /** "MERGEABLE", "CONFLICTING", or "UNKNOWN". */
  mergeable: string;
  /** Rolled-up CI state: "PASS", "FAIL", "PENDING", or "" when no checks ran. */
  checks: string;
  /** Human count for a tooltip, e.g. "3/4 checks passed" ("" when none). */
  checks_summary: string;
}

export interface WorktreeInfo {
  path: string;
  name: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
  is_main: boolean;
  dirty: number;
}

export interface BranchWork {
  branch: string;
  worktree: string | null;
  is_main: boolean;
  prunable: boolean;
  current: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  upstream_gone: boolean;
  merged: boolean;
  /** Integration branch (main/develop/…) or the base — never cleanable. */
  protected: boolean;
  last_commit: string;
  age_days: number;
  subject: string;
  author: string;
}

export interface WorkAudit {
  base: string;
  counts_degraded: boolean;
  items: BranchWork[];
}

export const gitBranchCommits = (repo: string, branch: string) =>
  invoke<CommitInfo[]>("git_branch_commits", { repo, branch });

export const gitBranchPatch = (
  repo: string,
  branch: string,
  worktree: string | null,
  uncommitted: boolean,
) =>
  invoke<CommitPatch>("git_branch_patch", {
    repo,
    branch,
    worktree,
    uncommitted,
  });

export const gitRemoteUrl = (repo: string) =>
  invoke<string>("git_remote_url", { repo });

/** What the branch can do about the branch it was cut from. */
export type SyncState = "current" | "clean" | "conflict" | "unknown" | "blocked";

export interface SyncProbe {
  repo: string;
  branch: string | null;
  /** The ref measured against, e.g. "origin/main". */
  base: string;
  /** Base tip — dismissals key on it, so "not now" lasts until it moves. */
  base_head: string;
  behind: number;
  ahead: number;
  dirty: number;
  state: SyncState;
  /** Paths the merge would conflict in. Found without touching the worktree. */
  conflicts: string[];
  /** Uncommitted files the incoming commits also touch — git refuses to start
   *  a merge over these, so they're worth naming before the user clicks. */
  overlap: string[];
  subjects: string[];
  blocked: string | null;
  /** Fetch failed: counts are from the last successful fetch, not from now. */
  fetch_error: string | null;
}

export interface SyncOutcome {
  merged: boolean;
  conflicts: string[];
  message: string;
}

/** Non-destructive: dry-runs the merge in the object store, so it is safe to
 *  call on a timer while the user is mid-edit. `fetch` refreshes the remote. */
export const gitSyncProbe = (repo: string, fetch: boolean, base?: string | null) =>
  invoke<SyncProbe>("git_sync_probe", { repo, fetch, base: base ?? null });

/** The only writing call — merges base into the current branch, on a click. */
export const gitSyncApply = (repo: string, base: string) =>
  invoke<SyncOutcome>("git_sync_apply", { repo, base });

export const gitSyncAbort = (repo: string) => invoke<string>("git_sync_abort", { repo });

export const gitWorkAudit = (repo: string) =>
  invoke<WorkAudit>("git_work_audit", { repo });

/** One agent session's work joined against git — metadata only; patches come
 *  from gitBranchPatch and the PR match from ghPrList. */
export interface AgentWorkspace {
  session_id: string;
  agent: string | null;
  state: string | null;
  cwd: string | null;
  updated: number | null;
  /** The session's working-time clock (see SessionDigest.active_secs): seconds
   *  actually worked over its life, and seconds in the current uninterrupted
   *  stretch. Null when no hook ever wrote a digest for this session. */
  active_secs: number | null;
  run_secs: number | null;
  /** Files the agent itself reported editing — intent, capped by the hook;
   *  the diff panes are the authoritative list. */
  touched: string[];
  /** Live HEAD of the workdir when it exists, else the digest's snapshot. */
  branch: string | null;
  detached: boolean;
  base: string;
  /** Working directly on the base/protected branch — no branch-scoped view. */
  on_base: boolean;
  /** Directory for uncommitted diffs; null when gone or owned elsewhere. */
  workdir: string | null;
  /** The workdir is a linked worktree, not the shared checkout. */
  isolated: boolean;
  cwd_missing: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  merged: boolean;
  commits: CommitInfo[];
}

export const agentWorkspace = (repo: string, sessionId: string) =>
  invoke<AgentWorkspace>("agent_workspace", { repo, sessionId });

/** Workspace keyed on a live terminal's cwd, so hookless CLIs (codex, agy, …)
 *  get the same branch/diff/commit/PR view. `agent` is the authoritative id from
 *  the process tree; `sessionId` is optional hook enrichment. */
export const agentWorkspaceAt = (
  repo: string,
  cwd: string,
  agent?: string,
  sessionId?: string,
) =>
  invoke<AgentWorkspace>("agent_workspace_at", { repo, cwd, agent, sessionId });

/** One edit the agent authored, from its change journal. `present` = the `new`
 *  text is still in the file (a later edit by anyone supersedes it). */
export interface AgentEdit {
  ts: number;
  path: string;
  tool: string;
  old: string | null;
  new: string | null;
  present: boolean;
}

/** The per-agent change journal: what this agent changed, at hunk granularity,
 *  attributed even on a shared checkout. Empty for a hookless/pre-journal
 *  session. */
export const agentEdits = (repo: string | null, sessionId: string) =>
  invoke<AgentEdit[]>("agent_edits", { repo, sessionId });

export const gitWorktrees = (repo: string) =>
  invoke<WorktreeInfo[]>("git_worktrees", { repo });
export const gitWorktreeAdd = (
  repo: string,
  path: string,
  branch: string,
  create: boolean,
) =>
  invoke<CheckoutOutcome>("git_worktree_add", { repo, path, branch, create });
export const gitWorktreeAddPr = (
  repo: string,
  path: string,
  number: number,
  branch: string,
) =>
  invoke<CheckoutOutcome>("git_worktree_add_pr", {
    repo,
    path,
    number,
    branch,
  });
/** What a fresh workspace was given so it can actually build, and the install
 *  to run when cloning the dependencies wasn't possible. */
export interface BootstrapReport {
  carried: string[];
  cloned: string[];
  install: string | null;
  note: string | null;
}
/** Give a just-created workspace the two things `git worktree add` leaves out:
 *  the gitignored config, and the dependencies. */
export const gitWorktreeBootstrap = (repo: string, path: string) =>
  invoke<BootstrapReport>("git_worktree_bootstrap", { repo, path });
/** `force` counts rather than toggles: 1 drops uncommitted work, 2 also clears
 *  a locked workspace — git needs `remove -f -f` for that and says so. */
export const gitWorktreeRemove = (repo: string, path: string, force: 0 | 1 | 2) =>
  invoke<string>("git_worktree_remove", { repo, path, force });
export const gitWorktreePrune = (repo: string) =>
  invoke<string>("git_worktree_prune", { repo });

export const ghAvailable = () => invoke<boolean>("gh_available");
export const ghPrList = (repo: string) =>
  invoke<PrInfo[]>("gh_pr_list", { repo });
export const ghPrDiff = (repo: string, number: number) =>
  invoke<string>("gh_pr_diff", { repo, number });
export const ghPrBody = (repo: string, number: number) =>
  invoke<string>("gh_pr_body", { repo, number });
export const ghPrReview = (
  repo: string,
  number: number,
  action: "approve" | "comment" | "request-changes",
  body?: string,
) => invoke<string>("gh_pr_review", { repo, number, action, body });
/** Check out a PR's head here — ordinary branch switching wearing gh's coat, so
 *  it refuses in the same ways and returns the same outcomes. `carry` sets the
 *  working tree aside and puts it back, as the local-changes answer does. */
export const ghPrCheckout = (repo: string, number: number, carry = false) =>
  invoke<CheckoutOutcome>("gh_pr_checkout", { repo, number, carry });
export const ghPrMerge = (
  repo: string,
  number: number,
  method: "squash" | "merge" | "rebase",
) => invoke<string>("gh_pr_merge", { repo, number, method });
/** Close a PR without merging. `deleteBranch` also throws away its branch (local
 *  + remote) via `gh pr close --delete-branch` — the "close it and discard it". */
export const ghPrClose = (repo: string, number: number, deleteBranch = false) =>
  invoke<string>("gh_pr_close", { repo, number, deleteBranch });
export const ghPrReady = (repo: string, number: number) =>
  invoke<string>("gh_pr_ready", { repo, number });

// ---------- PR conversation (review threads, comments, reviews) ----------

export interface PrComment {
  /** GraphQL node id — what a reply or resolve is addressed to. */
  id: string;
  author: string;
  body: string;
  created: string;
  url: string;
  mine: boolean;
  /** OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR / NONE. */
  association: string;
}

export interface PrReviewSummary extends PrComment {
  /** APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING. */
  state: string;
  submitted: string;
  /** Head commit the review was submitted against. */
  commit: string;
}

export interface PrThread {
  id: string;
  path: string;
  line: number;
  start_line: number;
  /** LEFT or RIGHT. */
  side: string;
  resolved: boolean;
  outdated: boolean;
  comments: PrComment[];
}

export interface PrFileState {
  path: string;
  viewed: boolean;
  additions: number;
  deletions: number;
}

export interface PrConversation {
  node_id: string;
  body: string;
  head_sha: string;
  viewer: string;
  review_decision: string;
  mergeable: string;
  /** OPEN / CLOSED / MERGED — live, unlike the PrInfo the tab opened with. */
  state: string;
  /** Live rollup in PrInfo's vocabulary: PASS / FAIL / PENDING / "". */
  checks: string;
  auto_merge: boolean;
  draft: boolean;
  comments: PrComment[];
  reviews: PrReviewSummary[];
  threads: PrThread[];
  files: PrFileState[];
  my_last_review_sha: string;
}

/** One inline comment of a review that hasn't been posted yet. */
export interface DraftThread {
  path: string;
  line: number;
  start_line?: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Everything the PR tab needs about the conversation, in one GraphQL call. */
export const ghPrConversation = (repo: string, number: number) =>
  invoke<PrConversation>("gh_pr_conversation", { repo, number });
export const ghPrThreadReply = (repo: string, threadId: string, body: string) =>
  invoke<string>("gh_pr_thread_reply", { repo, threadId, body });
export const ghPrThreadResolved = (
  repo: string,
  threadId: string,
  resolved: boolean,
) => invoke<string>("gh_pr_thread_resolved", { repo, threadId, resolved });
export const ghPrFileViewed = (
  repo: string,
  prId: string,
  path: string,
  viewed: boolean,
) => invoke<void>("gh_pr_file_viewed", { repo, prId, path, viewed });
/** Submit a review and all its inline comments as one review. */
export const ghPrReviewBatch = (
  repo: string,
  prId: string,
  event: "approve" | "comment" | "request-changes",
  body: string,
  threads: DraftThread[],
) => invoke<string>("gh_pr_review_batch", { repo, prId, event, body, threads });
export const ghPrUpdateBranch = (repo: string, number: number) =>
  invoke<string>("gh_pr_update_branch", { repo, number });
export const ghPrRequestReview = (
  repo: string,
  number: number,
  reviewers: string[],
) => invoke<string>("gh_pr_request_review", { repo, number, reviewers });
export const ghPrAutoMerge = (
  repo: string,
  number: number,
  method: "squash" | "merge" | "rebase",
  enable: boolean,
) => invoke<string>("gh_pr_auto_merge", { repo, number, method, enable });
/** Tail of the failing checks' logs — "" when nothing is failing. */
export const ghPrFailingLogs = (repo: string, number: number) =>
  invoke<string>("gh_pr_failing_logs", { repo, number });
/** Logins with access to the repo — who "Ask for review" can offer. */
export const ghPrReviewerCandidates = (repo: string) =>
  invoke<string[]>("gh_pr_reviewer_candidates", { repo });
export const ghPrDiffSince = (repo: string, baseSha: string, headSha: string) =>
  invoke<string>("gh_pr_diff_since", { repo, baseSha, headSha });

// ---------- cross-project PR watcher ----------

/** One row of the PR inbox. Everything here comes from the batched query, so a
 *  row renders without a second call. */
export interface PrRow {
  /** Local checkout this PR belongs to — what a click opens. */
  repo: string;
  nwo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  branch: string;
  base: string;
  draft: boolean;
  created: string;
  updated: string;
  additions: number;
  deletions: number;
  mergeable: string;
  review_decision: string;
  checks: string;
  comments: number;
  threads: number;
  /** Waiting on the signed-in user's review. */
  requested_from_me: boolean;
  mine: boolean;
}

export interface PrSnapshot {
  repo: string;
  nwo: string;
  rows: PrRow[];
  viewer: string;
  fetched_ms: number;
}

/** What a whole pass cost and what failed. */
export interface PrTick {
  fetched_ms: number;
  repos: number;
  requests: number;
  cost: number;
  remaining: number;
  reset_at: string;
  errors: Record<string, string>;
  next_in: number;
}

/** Declare which repos are worth watching, and whether the user is looking.
 *  The backend owns the schedule — see src-tauri/src/prwatch.rs. */
export const prWatchSet = (paths: string[], focused: boolean) =>
  invoke<void>("pr_watch_set", { paths, focused });
/** Wake the poller (the panel's ↻). Never runs a pass of its own. */
export const prWatchNow = () => invoke<void>("pr_watch_now");
/** A repo's rows changed. Unchanged repos emit nothing at all. */
export const onPrSnapshot = (
  cb: (s: PrSnapshot) => void,
): Promise<UnlistenFn> =>
  listen<PrSnapshot>("prs:snapshot", (e) => cb(e.payload));
export const onPrTick = (cb: (t: PrTick) => void): Promise<UnlistenFn> =>
  listen<PrTick>("prs:tick", (e) => cb(e.payload));
export const onPrNext = (cb: (seconds: number) => void): Promise<UnlistenFn> =>
  listen<number>("prs:next", (e) => cb(e.payload));

// ---------- cross-session context ----------

export interface SessionDigest {
  session_id: string;
  cwd?: string;
  branch?: string;
  agent?: string;
  idle?: boolean;
  /** Lifecycle state derived from the hook stream by canopy_hook.rs:
   *  "working" (a turn is in flight), "waiting" (blocked on the user),
   *  "idle" (finished, nothing outstanding) or "ended" (session closed).
   *  Absent for pre-upgrade digests and CLIs read straight from disk. */
  state?: "working" | "waiting" | "idle" | "ended";
  /** Subagents (Claude's Task tool) that finished in the current turn, zeroed
   *  when the next human prompt starts. */
  subagents?: number;
  updated?: number;
  /** Seconds this session has actually spent working, over its whole life —
   *  idle and blocked-on-you spans excluded. Kept by canopy_hook.rs, which is
   *  the only writer that sees every transition; see shared/agentDuration.ts
   *  for how a row turns it into a number on screen. Absent on pre-upgrade
   *  digests and on CLIs read straight from disk. */
  active_secs?: number;
  /** Seconds in the current (or most recent) uninterrupted working stretch. */
  run_secs?: number;
  /** Unix seconds the current stretch began. For display only — the span since
   *  then is wall clock, which is the thing these fields exist to replace. */
  run_started?: number;
  prompts?: string[];
  files?: string[];
  /** Where the session was launched. Pinned at first sighting and never
   *  updated, unlike `cwd`, which follows the agent as it cds. */
  launch_cwd?: string;
  /** The terminal that owns this session — our PTY id, inherited through the
   *  spawn env, as a string. Present only for sessions started under a Canopy
   *  terminal. This is the deterministic session -> surface binding: matching
   *  on titles or newest-file-by-mtime guesses, and a wrong guess attaches to
   *  someone else's conversation. */
  surface?: string;
  /** The app launch that spawned this session's terminal (env CANOPY_INSTANCE).
   *  `surface` (the PTY id) resets to 1 every launch and every instance writes
   *  to the same sessions dir, so it collides across instances/restarts; pairing
   *  a digest to a live terminal must also match this. Absent for pre-upgrade
   *  digests. */
  instance?: string;
  /** Directory the agent's resume must run in — claude files a conversation
   *  under its project root, not the directory the agent ran in. Derived in
   *  agents.rs; may differ from `cwd`. */
  resume_cwd?: string;
  /** False when no transcript was ever persisted, so every --resume would fail. */
  resumable?: boolean;
  /** A one-shot micro-task session (CANOPY_MICRO_TASK in its launch env),
   *  recorded by the hook at first sighting. Never offered for restore —
   *  resuming a finished task re-runs it. Absent on digests written before the
   *  marker existed, and on any CLI read straight from disk. */
  micro?: boolean;
}

/** Publish which projects share context between their agent sessions. The hook
 *  helper reads this; a project absent (or disabled) here shares nothing. */
export const setContextScopes = (
  scopes: { name: string; roots: string[]; enabled: boolean }[],
) => invoke<void>("set_context_scopes", { scopes });

/** Every agent conversation this machine has a record of: Canopy's own hook
 *  records, plus each CLI's own on-disk store. `roots` are the open project's
 *  directories — the stores that file themselves by project (gemini, aider)
 *  can only be found through them. */
export const sessionDigests = (roots?: string[]) =>
  invoke<SessionDigest[]>("session_digests", { roots });

/** Drop a session the user no longer wants offered for restore. */
export const sessionForget = (sessionId: string) =>
  invoke<void>("session_forget", { sessionId });

// ---------- team relay ----------

export interface RelayMember {
  id: string;
  name: string;
  joined_ms: number;
  is_host: boolean;
  /** Ed25519 identity public key (hex) proven on the direct link. */
  key: string | null;
  /** Trust-on-first-use verdict from our perspective:
   *  "self" us | "new" first sight | "known" pinned & matches |
   *  "changed" pinned but key differs (warn!) | "relayed" host-asserted. */
  trust: "self" | "new" | "known" | "changed" | "relayed" | "";
}

/** Who we are on the relay right now. role "off" = not hosting, not joined. */
export interface RelayStatus {
  role: "off" | "host" | "client";
  code: string | null;
  port: number | null;
  /** Host only: LAN addresses teammates can reach us on. */
  ips: string[];
  /** Client only: the host address we joined. */
  addr: string | null;
  self_id: string | null;
  name: string | null;
  /** Host only: "local" (LAN) or "public" (internet-reachable). */
  visibility: "local" | "public" | null;
  /** Host only, public mode: the internet-facing address teammates dial. */
  public_ip: string | null;
  members: RelayMember[];
}

export interface RelayChatMsg {
  id: string;
  /** Set on entries synthesised from a completed file transfer, so the
   *  conversation records what was sent/received as well as what was said. */
  file?: { name: string; path: string | null; direction: "in" | "out" };
  from: string;
  from_name: string;
  /** null = everyone; an id = a direct message. */
  to: string | null;
  text: string;
  ts: number;
}

export interface RelayCommandMsg {
  id: string;
  from: string;
  from_name: string;
  to: string | null;
  /** e.g. "open-pr" — the payload's shape belongs to the kind. */
  kind: string;
  payload: unknown;
  ts: number;
}

export const relayStatus = () => invoke<RelayStatus>("relay_status");
export const relayHostStart = (
  name: string,
  visibility: "local" | "public",
  port?: number,
) => invoke<RelayStatus>("relay_host_start", { name, visibility, port });
export const relayHostStop = () => invoke<RelayStatus>("relay_host_stop");
export const relayRegenerateCode = () =>
  invoke<RelayStatus>("relay_regenerate_code");
export const relayConnect = (addr: string, code: string, name: string) =>
  invoke<RelayStatus>("relay_connect", { addr, code, name });
export const relayDisconnect = () => invoke<RelayStatus>("relay_disconnect");

/** Canopy Remote — the embedded control-panel server (src-tauri/src/portal.rs).
 *  Separate from the team relay: this drives your own agents from a browser. */
export interface RemoteStatus {
  enabled: boolean;
  port: number;
  /** The PIN to enter in the portal — present only while enabled. */
  pin: string | null;
  /** Same-network `http://<lan-ip>:<port>/remote` addresses. */
  urls: string[];
  /** `http://<public-ip>:<port>/remote` — needs TCP <port> port-forwarded. */
  public_url: string | null;
  /** Inline SVG QR of the primary LAN URL, for scan-to-connect. */
  qr_svg: string | null;
}
export const remoteStatus = () => invoke<RemoteStatus>("remote_status");
export const remoteEnable = () => invoke<RemoteStatus>("remote_enable");
export const remoteDisable = () => invoke<RemoteStatus>("remote_disable");
export const remoteRotatePin = () => invoke<RemoteStatus>("remote_rotate_pin");
/** Push the current theme tokens (var name → color) so the portal matches the
 *  desktop's skin. */
export const remoteSetTheme = (theme: Record<string, string>) =>
  invoke<void>("remote_set_theme", { theme });
/** A QR SVG for any URL (LAN address or the active tunnel URL). */
export const remoteQr = (text: string) =>
  invoke<string | null>("remote_qr", { text });

/** Public-link tunnel (Cloudflare / ngrok / Tailscale). Exposes the portal to
 *  the internet so it loads from any browser without router config. */
export interface TunnelState {
  running: boolean;
  provider: string | null;
  url: string | null;
  message: string | null;
}
export const tunnelStart = (provider: string, port: number, token?: string) =>
  invoke<TunnelState>("tunnel_start", { provider, port, token });
export const tunnelStop = () => invoke<TunnelState>("tunnel_stop");
export const tunnelStatus = () => invoke<TunnelState>("tunnel_status");
export const onTunnelState = (
  cb: (s: TunnelState) => void,
): Promise<UnlistenFn> =>
  listen<TunnelState>("tunnel:state", (e) => cb(e.payload));

/** Which of these commands are installed (login-shell PATH). */
export const whichCheck = (commands: string[]) =>
  invoke<Record<string, boolean>>("which_check", { commands });
/** Stdout of one allowlisted donor-CLI model-list command (see MODEL_DONORS in
 *  agents.rs), or null when that donor can't answer — not installed, needs a
 *  tty, timed out. `query` indexes the donor's own argv table; nothing about
 *  the command line crosses this boundary. */
export const modelCatalog = (donor: string, query: number) =>
  invoke<string | null>("model_catalog", { donor, query });
/** Resolves with the stamped message — the sender's UI appends it; the relay
 *  never echoes a frame back to its author. */
export const relaySendChat = (to: string | null, text: string) =>
  invoke<RelayChatMsg>("relay_send_chat", { to, text });
export const relaySendCommand = (
  to: string | null,
  kind: string,
  payload: unknown,
) => invoke<RelayCommandMsg>("relay_send_command", { to, kind, payload });

export const onRelayState = (
  cb: (s: RelayStatus) => void,
): Promise<UnlistenFn> =>
  listen<RelayStatus>("relay:state", (e) => cb(e.payload));
export const onRelayChat = (
  cb: (m: RelayChatMsg) => void,
): Promise<UnlistenFn> =>
  listen<RelayChatMsg>("relay:chat", (e) => cb(e.payload));
export const onRelayCommand = (
  cb: (m: RelayCommandMsg) => void,
): Promise<UnlistenFn> =>
  listen<RelayCommandMsg>("relay:command", (e) => cb(e.payload));

/** Live collaborative editing. `doc` is an opaque id minted by the sharer; the
 *  backend never learns which file it refers to, and no path is ever sent —
 *  see docs/collab-editing.md §5. Separate from sendCommand because this runs
 *  at a frame per keystroke and must not touch the inbox or notifications. */
export const relaySendCollab = (
  to: string | null,
  doc: string,
  body: import("./collab").CollabBody,
) => invoke<void>("relay_send_collab", { to, doc, body });
export const onRelayCollab = (
  cb: (m: import("./collab").CollabMsg) => void,
): Promise<UnlistenFn> =>
  listen<import("./collab").CollabMsg>("relay:collab", (e) => cb(e.payload));

/** A "file-offer" command's payload: where to fetch, the one-time token that
 *  gates the fetch, and the hash the received bytes must match. */
export interface RelayFileOffer {
  name: string;
  size: number;
  sha256: string;
  addrs: string[];
  token: string;
}

export interface RelayTransferEvent {
  /** Correlates with the progress stream. Non-secret (never the token). */
  id: string;
  direction: "in" | "out";
  name: string;
  total: number;
  ok: boolean;
  /** in+ok: saved path; out+ok: receiver's name; !ok: what failed. */
  detail: string;
  /** The member on the other end, so a finished transfer can be filed into
   *  that conversation instead of only flashing past as a toast. */
  peer: string | null;
}

export interface RelayTransferProgress {
  id: string;
  direction: "in" | "out";
  name: string;
  done: number;
  total: number;
}

/** Offer a file to a member: the bytes go peer-to-peer, only the offer rides
 *  the relay. Resolves once the offer is sent; the outcome arrives later as a
 *  relay:transfer event. */
export const relayOfferFile = (to: string, path: string) =>
  invoke<void>("relay_offer_file", { to, path });
export const relayAcceptFile = (
  offer: RelayFileOffer,
  dest: string,
  from?: string | null,
) => invoke<void>("relay_accept_file", { ...offer, dest, from: from ?? null });
export const onRelayTransfer = (
  cb: (e: RelayTransferEvent) => void,
): Promise<UnlistenFn> =>
  listen<RelayTransferEvent>("relay:transfer", (e) => cb(e.payload));
export const onRelayTransferProgress = (
  cb: (e: RelayTransferProgress) => void,
): Promise<UnlistenFn> =>
  listen<RelayTransferProgress>("relay:transfer-progress", (e) =>
    cb(e.payload),
  );

// ---------- issue trackers ----------

/** One ticket, whatever the tracker. See src/trackers.ts for the provider
 *  registry that produces these. */
export interface TicketInfo {
  id: string;
  title: string;
  state: string;
  state_type: string;
  assignee: string | null;
  mine: boolean;
  url: string;
  branch: string | null;
  body: string;
  priority: string;
}

export interface GhAuth {
  installed: boolean;
  path: string;
  authenticated: boolean;
  account: string;
  host: string;
  detail: string;
}

export const ghAuth = () => invoke<GhAuth>("gh_auth");

export const ghIssueList = (repo: string) =>
  invoke<TicketInfo[]>("gh_issue_list", { repo });
export const linearIssues = (apiKey: string) =>
  invoke<TicketInfo[]>("linear_issues", { apiKey });

// ---- voice dictation (local ASR: Parakeet / SenseVoice / Moonshine) ----

export interface DictationModel {
  id: string;
  name: string;
  /** BCP-47 language codes the model covers. */
  languages: string[];
  size_mb: number;
  downloaded: boolean;
  multilingual: boolean;
  is_default: boolean;
}

export interface DictationStatus {
  recording: boolean;
  /** Model id currently downloading, if any. */
  downloading: string | null;
  /** Model id currently loaded in memory, if any. */
  loaded: string | null;
}

export interface DictationProgress {
  /** Which model this event is about. */
  model: string;
  phase: "download" | "extract" | "load" | "ready" | "error";
  pct: number;
  message: string | null;
}

export const dictationModels = () =>
  invoke<DictationModel[]>("dictation_models");
export const dictationStatus = () =>
  invoke<DictationStatus>("dictation_status");
export const dictationDownload = (modelId: string) =>
  invoke<void>("dictation_download", { modelId });
export const dictationDeleteModel = (modelId: string) =>
  invoke<void>("dictation_delete_model", { modelId });
/** Resolves to "recording" (mic live) or "downloading" (model fetch started).
 *  `streaming` turns on the live preview loop (dictation:partial events); it
 *  costs a core while recording and does not change the final text. */
export const dictationStart = (
  modelId: string,
  streaming?: boolean,
  language?: string,
  muteOutput?: boolean,
) =>
  invoke<string>("dictation_start", {
    modelId,
    streaming: streaming ?? false,
    language: language || null,
    muteOutput: muteOutput ?? false,
  });
/** Stops the mic and resolves to the transcribed text. `language` is an
 *  optional BCP-47 hint (empty/undefined = auto-detect). */
export const dictationStop = (language?: string) =>
  invoke<string>("dictation_stop", { language: language || null });
export const dictationCancel = () => invoke<void>("dictation_cancel");
/** Whether this build/platform can run dictation (false on Intel macOS, which
 *  has no compatible ONNX Runtime). The UI hides dictation entirely when false. */
export const dictationSupported = () => invoke<boolean>("dictation_supported");
export const onDictationProgress = (
  cb: (p: DictationProgress) => void,
): Promise<UnlistenFn> =>
  listen<DictationProgress>("dictation:progress", (e) => cb(e.payload));

/** Live transcription while the mic is open, split into the part successive
 *  decodes agree on and the tail they don't (see dictation.rs). Only fires
 *  when dictation_start was passed streaming: true. */
export interface DictationPartial {
  confirmed: string;
  unconfirmed: string;
}
export const onDictationPartial = (
  cb: (p: DictationPartial) => void,
): Promise<UnlistenFn> =>
  listen<DictationPartial>("dictation:partial", (e) => cb(e.payload));

/** Input loudness as RMS in 0..1, ~30 times a second while recording. Drives
 *  the pill's visualiser. Raw, not normalised — speech sits around 0.02–0.2,
 *  so callers scale it themselves. */
export const onDictationLevel = (
  cb: (rms: number) => void,
): Promise<UnlistenFn> =>
  listen<number>("dictation:level", (e) => cb(e.payload));

// ---------- Android ----------

export interface AndroidSdk {
  root: string;
  adb: string;
  /** The `android` CLI; null when cmdline-tools was never installed. */
  cli: string | null;
}

export interface AndroidSdkStatus {
  sdk: AndroidSdk | null;
  /** What to install, phrased for the user. Empty means everything is there. */
  missing: string[];
}

export interface AndroidDevice {
  serial: string;
  state: string;
  model: string;
  emulator: boolean;
}

/** `projectDir` locates the SDK: a project's local.properties pins one, and it
 *  outranks the environment the same way it does for Gradle. */
export const androidSdkStatus = (projectDir?: string) =>
  invoke<AndroidSdkStatus>("android_sdk_status", { projectDir });

export const androidDevices = (projectDir?: string) =>
  invoke<AndroidDevice[]>("android_devices", { projectDir });

/** Emulators, each with whether it can actually boot. `android emulator start`
 *  exits 0 on an AVD whose system image is gone, so this is checked up front
 *  rather than discovered as an unexplainable failure afterwards. */
export const androidAvds = (projectDir?: string) =>
  invoke<AndroidAvd[]>("android_avds", { projectDir });

export interface AndroidAvd {
  name: string;
  ready: boolean;
  /** Why it can't boot, in the user's terms; null when it can. */
  problem: string | null;
}

/** Resolves once the emulator is genuinely usable, with its serial. */
export const androidEmulatorStart = (name: string, projectDir?: string) =>
  invoke<string>("android_emulator_start", { name, projectDir });

export const androidEmulatorStop = (serial: string, projectDir?: string) =>
  invoke<void>("android_emulator_stop", { serial, projectDir });

/** PNG bytes of the device screen, as an ArrayBuffer — no base64 round trip. */
export const androidScreencap = (serial: string, projectDir?: string) =>
  invoke<ArrayBuffer>("android_screencap", { serial, projectDir });

/** uiautomator's XML: the only source with a rectangle on every node, which is
 *  what hit-testing a click needs. */
export const androidUiDump = (serial: string, projectDir?: string) =>
  invoke<string>("android_ui_dump", { serial, projectDir });

/** The same tree as the `android` CLI's JSON — what an agent reads. */
export const androidLayout = (serial: string, projectDir?: string) =>
  invoke<string>("android_layout", { serial, projectDir });

/** `package/activity` in front, or "" when nothing is focused. */
export const androidForeground = (serial: string, projectDir?: string) =>
  invoke<string>("android_foreground", { serial, projectDir });

export const androidTap = (serial: string, x: number, y: number, projectDir?: string) =>
  invoke<void>("android_tap", { serial, x, y, projectDir });

export const androidText = (serial: string, text: string, projectDir?: string) =>
  invoke<void>("android_text", { serial, text, projectDir });

export const androidSwipe = (
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  ms?: number,
  projectDir?: string,
) => invoke<void>("android_swipe", { serial, x1, y1, x2, y2, ms, projectDir });

export const androidKey = (serial: string, key: string, projectDir?: string) =>
  invoke<void>("android_key", { serial, key, projectDir });

export const androidLogcat = (
  serial: string,
  packageName?: string,
  lines?: number,
  projectDir?: string,
) => invoke<string>("android_logcat", { serial, package: packageName, lines, projectDir });

/** Build targets and where their APKs land, straight from Gradle. */
export const androidDescribe = (projectDir: string) =>
  invoke<string>("android_describe", { projectDir });

export const androidRun = (projectDir: string, apk: string, serial: string) =>
  invoke<string>("android_run", { projectDir, apk, serial });

// ---------------------------------------------------------------------------
// Cleanup: reclaiming the disk the projects only borrowed (cleanup.rs).

export interface CleanupTarget {
  path: string;
  /** The allowlist entry that matched — "node_modules", "target". */
  name: string;
  /** Where it sits inside its checkout ("packages/web/node_modules"). */
  rel: string;
  category: "cache" | "build" | "deps";
  bytes: number;
  files: number;
  /** Days since the newest file inside was written — when the build last ran. */
  idle_days: number;
  /** What brings it back. Shown, never run. */
  regenerate: string;
  workspace: string;
  recommended: boolean;
  /** Why it isn't recommended, in words the row shows as-is. */
  hold: string | null;
  /** Its size is a floor: the file count hit the scan's budget. */
  partial: boolean;
}

export interface CleanupWorkspace {
  path: string;
  name: string;
  branch: string | null;
  main: boolean;
  dirty: number;
  busy: boolean;
  asleep: boolean;
  idle_days: number | null;
  /** Its work is already in the base branch, and how we know ("already merged
   *  into origin/main"). The reason a workspace this new is being offered. */
  landed: string | null;
  bytes: number;
  recommended_bytes: number;
}

export interface CleanupScan {
  workspaces: CleanupWorkspace[];
  targets: CleanupTarget[];
  bytes: number;
  recommended_bytes: number;
  skipped: string[];
  truncated: boolean;
}

export interface CleanupOutcome {
  removed: string[];
  bytes: number;
  failed: [string, string][];
  refused: string[];
  trashed: boolean;
}

/** Find disposable directories under the open projects. `busy` is every cwd
 *  something live is running in and `asleep` the roots of hibernating projects:
 *  both only ever take rows *out* of the default selection. */
export const cleanupScan = (roots: string[], busy: string[], asleep: string[]) =>
  invoke<CleanupScan>("cleanup_scan", { roots, busy, asleep });

/** Delete the chosen directories. Every path is re-checked against the
 *  allowlist in Rust, so this can only ever remove what a scan would produce. */
export const cleanupRun = (paths: string[], trash: boolean) =>
  invoke<CleanupOutcome>("cleanup_run", { paths, trash });

export interface CleanupProgress {
  workspace: string;
  done: number;
  total: number;
}

/** One event per checkout the scan finishes, so the dialog can say where it is
 *  instead of showing a spinner for a minute. */
export const onCleanupProgress = (
  cb: (p: CleanupProgress) => void,
): Promise<UnlistenFn> =>
  listen<CleanupProgress>("cleanup:progress", (e) => cb(e.payload));

export interface DiskUsage {
  mount: string;
  label: string;
  total_bytes: number;
  free_bytes: number;
}

/** The volumes the open projects live on. A statfs per mount — no walking, so
 *  the usage panel can poll it like it polls plan limits. */
export const cleanupDisk = (roots: string[]) =>
  invoke<DiskUsage[]>("cleanup_disk", { roots });

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
  },
  onData: (bytes: Uint8Array) => void,
): Promise<SpawnResult> {
  const channel = new Channel<ArrayBuffer | number[]>();
  // Raw channel payloads arrive as ArrayBuffer for large chunks but as plain
  // number[] below Tauri's internal direct-execute threshold — handle both.
  channel.onmessage = (data) =>
    onData(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
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
    onData(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
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
export const onPtySpawned = (cb: (e: PtySpawned) => void): Promise<UnlistenFn> =>
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
export const onAgentAction = (cb: (a: AgentAction) => void): Promise<UnlistenFn> =>
  listen<AgentAction>("agent:action", (event) => cb(event.payload));

/** A browser-control op an agent sent through the MCP bridge (canopy_browser_*).
 *  Request/response: the bridge holds the agent's HTTP request open under `id`
 *  until the answer comes back via `browserResult`. Routed like AgentAction. */
export interface AgentBrowserOp {
  id: number;
  op: "navigate" | "snapshot" | "click" | "type" | "point" | "eval" | "console" | "screenshot";
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
export const onAgentBrowser = (cb: (op: AgentBrowserOp) => void): Promise<UnlistenFn> =>
  listen<AgentBrowserOp>("agent:browser", (event) => cb(event.payload));
/** Answer a browser op: `data` (any JSON value) becomes the tool's result. */
export const browserResult = (id: number, ok: boolean, data: unknown) =>
  // Never rejects: a dropped answer would leave the agent's tool call hanging
  // to its timeout with no trace of why, so failures are logged, not thrown.
  invoke<void>("browser_result", { id, ok, data: JSON.stringify(data ?? null) }).catch((err) =>
    console.warn("browser_result failed", id, err),
  );

/** An op only the running UI can answer: a language-server question, the
 *  trackers it holds keys for, a question for the user. Same ticketing as
 *  AgentBrowserOp — answer with `browserResult`. */
export interface AgentUiOp {
  id: number;
  op: "diagnostics" | "references" | "definition" | "tickets" | "reviews" | "ask";
  route: string;
  path?: string | null;
  line?: number | null;
  column?: number | null;
  symbol?: string | null;
  question?: string | null;
  options?: string[];
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

/** PNG (base64) of a rectangle of this window, via the webview's own snapshot
 *  API — used to hand an agent a picture of the preview. */
export const webviewSnapshot = (
  x: number,
  y: number,
  width: number,
  height: number,
  maxWidth?: number,
) => invoke<string>("webview_snapshot", { x, y, width, height, maxWidth });

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
  invoke<{ is_dir: boolean; size: number; modified_ms: number | null }>("fs_stat", { path });

export async function fsReadFile(path: string): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer | number[]>("fs_read_file", { path });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
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

export const instructionsWrite = (path: string, roots: string[], content: string) =>
  invoke<void>("instructions_write", { path, roots, content });

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

// ---------- file management ----------

export const fsCreateFile = (path: string) => invoke<string>("fs_create_file", { path });
export const fsCreateDir = (path: string) => invoke<string>("fs_create_dir", { path });
export const fsRename = (from: string, to: string) => invoke<string>("fs_rename", { from, to });
/** Moves to the OS trash — recoverable, unlike an unlink. */
export const fsTrash = (path: string) => invoke<void>("fs_trash", { path });
export const fsReveal = (path: string) => invoke<void>("fs_reveal", { path });
export const fsDuplicate = (path: string) => invoke<string>("fs_duplicate", { path });

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

export interface FsChange {
  root: string;
  paths: string[];
  kind: "create" | "modify" | "remove" | "other";
}
export const onFsChange = (cb: (e: FsChange) => void): Promise<UnlistenFn> =>
  listen<FsChange>("fs:change", (event) => cb(event.payload));

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
export const previewStop = (origin: string) => invoke<void>("preview_stop", { origin });

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
export const onPtyStats = (cb: (stats: SessionStats[]) => void): Promise<UnlistenFn> =>
  listen<SessionStats[]>("pty:stats", (event) => cb(event.payload));

export interface AppStats {
  cpu: number;
  mem_bytes: number;
  procs: number;
}

/** Whole-app footprint (this process + every descendant), emitted every 2s. */
export const onAppStats = (cb: (s: AppStats) => void): Promise<UnlistenFn> =>
  listen<AppStats>("app:stats", (e) => cb(e.payload));

export const killProcess = (pid: number) => invoke<void>("kill_process", { pid });
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
/** The launch's integration report if the pass has already finished. It runs
 *  before the webview does, so the event below can fire with nobody listening —
 *  ask for this on mount and take whichever arrives first. */
export const agentHealthReport = () => invoke<HealthReport | null>("agent_health_report");
/** What the launch's integration pass found and did. Emitted once per start. */
export const onIntegrationHealth = (cb: (r: HealthReport) => void): Promise<UnlistenFn> =>
  listen<HealthReport>("agents:health", (e) => cb(e.payload));
/** This app launch's instance tag — pair with SessionDigest.instance so a
 *  digest from another instance/run can't bind to this instance's terminals. */
export const instanceId = () => invoke<string>("instance_id");
export const onAgentEvent = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>("agent:event", (event) => cb(event.payload));

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
export const gitRepoStatus = (repo: string) => invoke<RepoStatus>("git_repo_status", { repo });
export const gitBranches = (repo: string) => invoke<BranchInfo[]>("git_branches", { repo });
export const gitCheckout = (repo: string, branch: string, create = false) =>
  invoke<string>("git_checkout", { repo, branch, create });
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
export const gitDiscard = (repo: string, tracked: string[], untracked: string[]) =>
  invoke<void>("git_discard", { repo, tracked, untracked });
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
) => invoke<CommitPatch>("git_branch_patch", { repo, branch, worktree, uncommitted });

export const gitRemoteUrl = (repo: string) => invoke<string>("git_remote_url", { repo });

export const gitWorkAudit = (repo: string) => invoke<WorkAudit>("git_work_audit", { repo });

/** One agent session's work joined against git — metadata only; patches come
 *  from gitBranchPatch and the PR match from ghPrList. */
export interface AgentWorkspace {
  session_id: string;
  agent: string | null;
  state: string | null;
  cwd: string | null;
  updated: number | null;
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
) => invoke<AgentWorkspace>("agent_workspace_at", { repo, cwd, agent, sessionId });

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

export const gitWorktrees = (repo: string) => invoke<WorktreeInfo[]>("git_worktrees", { repo });
export const gitWorktreeAdd = (repo: string, path: string, branch: string, create: boolean) =>
  invoke<string>("git_worktree_add", { repo, path, branch, create });
export const gitWorktreeAddPr = (repo: string, path: string, number: number, branch: string) =>
  invoke<string>("git_worktree_add_pr", { repo, path, number, branch });
export const gitWorktreeRemove = (repo: string, path: string, force: boolean) =>
  invoke<string>("git_worktree_remove", { repo, path, force });
export const gitWorktreePrune = (repo: string) => invoke<string>("git_worktree_prune", { repo });

export const ghAvailable = () => invoke<boolean>("gh_available");
export const ghPrList = (repo: string) => invoke<PrInfo[]>("gh_pr_list", { repo });
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
export const ghPrCheckout = (repo: string, number: number) =>
  invoke<string>("gh_pr_checkout", { repo, number });
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
export const ghPrThreadResolved = (repo: string, threadId: string, resolved: boolean) =>
  invoke<string>("gh_pr_thread_resolved", { repo, threadId, resolved });
export const ghPrFileViewed = (repo: string, prId: string, path: string, viewed: boolean) =>
  invoke<void>("gh_pr_file_viewed", { repo, prId, path, viewed });
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
export const ghPrRequestReview = (repo: string, number: number, reviewers: string[]) =>
  invoke<string>("gh_pr_request_review", { repo, number, reviewers });
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
export const onPrSnapshot = (cb: (s: PrSnapshot) => void): Promise<UnlistenFn> =>
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

export const sessionDigests = () => invoke<SessionDigest[]>("session_digests");

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
export const relayHostStart = (name: string, visibility: "local" | "public", port?: number) =>
  invoke<RelayStatus>("relay_host_start", { name, visibility, port });
export const relayHostStop = () => invoke<RelayStatus>("relay_host_stop");
export const relayRegenerateCode = () => invoke<RelayStatus>("relay_regenerate_code");
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
export const remoteQr = (text: string) => invoke<string | null>("remote_qr", { text });

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
export const onTunnelState = (cb: (s: TunnelState) => void): Promise<UnlistenFn> =>
  listen<TunnelState>("tunnel:state", (e) => cb(e.payload));

/** Which of these commands are installed (login-shell PATH). */
export const whichCheck = (commands: string[]) =>
  invoke<Record<string, boolean>>("which_check", { commands });
/** Resolves with the stamped message — the sender's UI appends it; the relay
 *  never echoes a frame back to its author. */
export const relaySendChat = (to: string | null, text: string) =>
  invoke<RelayChatMsg>("relay_send_chat", { to, text });
export const relaySendCommand = (to: string | null, kind: string, payload: unknown) =>
  invoke<RelayCommandMsg>("relay_send_command", { to, kind, payload });

export const onRelayState = (cb: (s: RelayStatus) => void): Promise<UnlistenFn> =>
  listen<RelayStatus>("relay:state", (e) => cb(e.payload));
export const onRelayChat = (cb: (m: RelayChatMsg) => void): Promise<UnlistenFn> =>
  listen<RelayChatMsg>("relay:chat", (e) => cb(e.payload));
export const onRelayCommand = (cb: (m: RelayCommandMsg) => void): Promise<UnlistenFn> =>
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
export const relayAcceptFile = (offer: RelayFileOffer, dest: string, from?: string | null) =>
  invoke<void>("relay_accept_file", { ...offer, dest, from: from ?? null });
export const onRelayTransfer = (cb: (e: RelayTransferEvent) => void): Promise<UnlistenFn> =>
  listen<RelayTransferEvent>("relay:transfer", (e) => cb(e.payload));
export const onRelayTransferProgress = (
  cb: (e: RelayTransferProgress) => void,
): Promise<UnlistenFn> =>
  listen<RelayTransferProgress>("relay:transfer-progress", (e) => cb(e.payload));

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

export const ghIssueList = (repo: string) => invoke<TicketInfo[]>("gh_issue_list", { repo });
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

export const dictationModels = () => invoke<DictationModel[]>("dictation_models");
export const dictationStatus = () => invoke<DictationStatus>("dictation_status");
export const dictationDownload = (modelId: string) =>
  invoke<void>("dictation_download", { modelId });
export const dictationDeleteModel = (modelId: string) =>
  invoke<void>("dictation_delete_model", { modelId });
/** Resolves to "recording" (mic live) or "downloading" (model fetch started). */
export const dictationStart = (modelId: string) =>
  invoke<string>("dictation_start", { modelId });
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

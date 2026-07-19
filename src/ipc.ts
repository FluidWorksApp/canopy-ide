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
  opts: { cols: number; rows: number; cwd?: string; shell?: string; highWater?: number },
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

export interface PtyExit {
  id: number;
  exit_code: number | null;
}
export const onPtyExit = (cb: (e: PtyExit) => void): Promise<UnlistenFn> =>
  listen<PtyExit>("pty:exit", (event) => cb(event.payload));

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

export interface FsChange {
  root: string;
  paths: string[];
  kind: "create" | "modify" | "remove" | "other";
}
export const onFsChange = (cb: (e: FsChange) => void): Promise<UnlistenFn> =>
  listen<FsChange>("fs:change", (event) => cb(event.payload));

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
export interface SessionStats {
  id: number;
  title: string;
  cwd: string;
  total_cpu: number;
  total_mem_bytes: number;
  procs: ProcInfo[];
  /** TCP ports anything in this session is listening on, ascending. */
  ports: number[];
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
  name: string;
  current: boolean;
  upstream: string | null;
  remote: boolean;
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
export const gitStage = (repo: string, paths: string[]) =>
  invoke<void>("git_stage", { repo, paths });
export const gitUnstage = (repo: string, paths: string[]) =>
  invoke<void>("git_unstage", { repo, paths });
export const gitDiscard = (repo: string, paths: string[]) =>
  invoke<void>("git_discard", { repo, paths });
export const gitCommit = (repo: string, message: string, amend = false) =>
  invoke<string>("git_commit", { repo, message, amend });
export const gitFetch = (repo: string) => invoke<string>("git_fetch", { repo });
export const gitPull = (repo: string) => invoke<string>("git_pull", { repo });
export const gitPush = (repo: string, setUpstream = false) =>
  invoke<string>("git_push", { repo, setUpstream });
export const gitDiff = (repo: string, path: string, staged: boolean) =>
  invoke<string>("git_diff", { repo, path, staged });
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
  updated: string;
  review_decision: string;
  additions: number;
  deletions: number;
  mine: boolean;
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

export const gitWorktrees = (repo: string) => invoke<WorktreeInfo[]>("git_worktrees", { repo });
export const gitWorktreeAdd = (repo: string, path: string, branch: string, create: boolean) =>
  invoke<string>("git_worktree_add", { repo, path, branch, create });
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

// ---------- cross-session context ----------

export interface SessionDigest {
  session_id: string;
  cwd?: string;
  branch?: string;
  agent?: string;
  idle?: boolean;
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
  /** Directory the agent's resume must run in — claude files a conversation
   *  under its project root, not the directory the agent ran in. Derived in
   *  agents.rs; may differ from `cwd`. */
  resume_cwd?: string;
  /** False when no transcript was ever persisted, so every --resume would fail. */
  resumable?: boolean;
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
}

export const ghIssueList = (repo: string) => invoke<TicketInfo[]>("gh_issue_list", { repo });
export const linearIssues = (apiKey: string) =>
  invoke<TicketInfo[]>("linear_issues", { apiKey });

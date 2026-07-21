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

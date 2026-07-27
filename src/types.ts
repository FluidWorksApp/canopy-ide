import type { ViewerKind } from "./components/viewers";
import type { RelayChatMsg, RelayCommandMsg, RelayStatus } from "./ipc";

export interface ChangeEntry {
  path: string;
  kind: "create" | "modify" | "remove" | "other";
  ts: number;
}

export interface OpenFile {
  path: string;
  name: string;
  kind: ViewerKind;
  /** 'preview' native viewer; 'source' Monaco; 'diff' vs git HEAD. */
  view: "preview" | "source" | "diff";
  /** Baseline content (git HEAD) when view === 'diff'. */
  diffOriginal?: string | null;
  dirty: boolean;
  /** New disk content pending user review (diff-first workflow). */
  external: string | null;
  /** Raw bytes for viewer kinds; refreshed on external change. */
  bytes: Uint8Array | null;
  /** Set when the file was refused rather than loaded — a binary blob, or past
   *  the size cap for its viewer. `bytes` stays null in that case: the point is
   *  that the contents were never read. */
  blocked?: import("./fileOpen").OpenBlock | null;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** The projection of one agent hook event that the app actually reads. The raw
 *  line can carry tens of KB of tool payload (tool_input/tool_response) and
 *  used to be re-JSON.parsed by every consumer on every render — it is parsed
 *  exactly once, at ingest, and only these fields are kept. */
export interface AgentEventData {
  sessionId: string;
  cwd: string;
  /** canopy_pty stamp; null when the agent's hooks can't carry it (codex). */
  pty: number | null;
  /** hook_event_name, falling back to codex's `type`. */
  event: string;
  tool: string;
  /** Empty when the hook carried no agent stamp (a bare claude). */
  agent: string;
  message?: string;
  /** codex's turn-complete carries the agent's last words. */
  lastAssistantMessage?: string;
  transcriptPath?: string;
  /** AskUserQuestion payload, when this event is its PreToolUse. */
  questions?: PendingQuestion[];
}

export interface AgentEventEntry {
  ts: number;
  /** null: the line wasn't JSON. */
  data: AgentEventData | null;
}

/** Message severity for the toast. Everything used to render with a red
 *  border, so "Switched to origin" looked like a failure. */
export type NoticeKind = "info" | "success" | "warn" | "error";

export type Notify = (message: string, kind?: NoticeKind) => void;

/** Everything a view needs to talk to the team relay. State lives in App —
 *  the relay is app-wide (one process, one socket) — and every ProjectView
 *  renders the same handle. */
/** A file transfer in flight or just finished, for the progress UI. */
export interface RelayTransfer {
  id: string;
  direction: "in" | "out";
  name: string;
  done: number;
  total: number;
  status: "active" | "ok" | "failed";
  /** in+ok: saved path; out+ok: receiver's name; failed: reason. */
  detail?: string;
}

export interface RelayHandle {
  status: RelayStatus;
  /** Rolling transcript: everything received plus our own sent messages. */
  chat: RelayChatMsg[];
  /** Unread count per conversation: "" is the team channel, a member id is a
   *  DM. Absent/zero means nothing waiting. */
  unread: Record<string, number>;
  /** Commands awaiting action ("review this PR"), newest last. */
  inbox: RelayCommandMsg[];
  /** File transfers in flight or recently finished. */
  transfers: RelayTransfer[];
  /** Live-editing sessions and the offers that haven't been answered. The
   *  manager is the single owner of the doc -> session table; note it has no
   *  way at all to turn a doc id from the wire into a path. */
  collab: import("./collab").CollabManager;
  /** Bumped whenever an offer arrives or a session opens, so the panels that
   *  render them re-run — the manager itself is mutable and outside React. */
  collabTick: number;
  hostStart: (
    name: string,
    visibility: "local" | "public",
    port?: number,
  ) => Promise<void>;
  hostStop: () => Promise<void>;
  regenerateCode: () => Promise<void>;
  connect: (addr: string, code: string, name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  sendChat: (to: string | null, text: string) => Promise<void>;
  sendCommand: (
    to: string | null,
    kind: string,
    payload: unknown,
  ) => Promise<void>;
  dismissInbox: (id: string) => void;
  /** The conversation the user is looking at right now (null = team chat,
   *  undefined = none) — so App can skip toasts for messages already on
   *  screen. */
  reportActiveChat: (peer: string | null | undefined) => void;
}

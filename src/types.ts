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
}

export interface AgentEventEntry {
  raw: string;
  ts: number;
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
  /** Commands awaiting action ("review this PR"), newest last. */
  inbox: RelayCommandMsg[];
  /** File transfers in flight or recently finished. */
  transfers: RelayTransfer[];
  hostStart: (name: string, visibility: "local" | "public", port?: number) => Promise<void>;
  hostStop: () => Promise<void>;
  regenerateCode: () => Promise<void>;
  connect: (addr: string, code: string, name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  sendChat: (to: string | null, text: string) => Promise<void>;
  sendCommand: (to: string | null, kind: string, payload: unknown) => Promise<void>;
  dismissInbox: (id: string) => void;
  /** The conversation the user is looking at right now (null = team chat,
   *  undefined = none) — so App can skip toasts for messages already on
   *  screen. */
  reportActiveChat: (peer: string | null | undefined) => void;
}

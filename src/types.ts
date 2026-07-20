import type { ViewerKind } from "./components/viewers";

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

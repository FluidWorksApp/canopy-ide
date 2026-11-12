// Terminals opened here from another machine on the tailnet (Settings → Remote
// access → Tailscale → Connect). The backend owns the link; this is what the
// webview knows about it: which local pty is a link, to whom, and how it is
// doing, so the tab strip and the Settings row agree. Kept outside React so a
// tab opened from the Settings dialog is known to the strip at once.
import { useSyncExternalStore } from "react";
import * as ipc from "./ipc";

export type LinkPhase =
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "lost" }
  /** The other machine turned Allow off. The tab is closed. */
  | { kind: "revoked" }
  /** The remote process exited; the tab keeps its output. */
  | { kind: "ended"; exitCode: number | null };

export interface TailnetLink {
  ptyId: number;
  stableId: string;
  remoteId: number;
  machine: string;
  phase: LinkPhase;
}

/** What the row says about a machine after something happened to a link. */
export type TailnetNotice =
  | { kind: "revoked"; machine: string }
  | { kind: "ended"; machine: string; exitCode: number | null };

interface Snapshot {
  links: ReadonlyMap<number, TailnetLink>;
  notices: Readonly<Record<string, TailnetNotice>>;
}

let snapshot: Snapshot = { links: new Map(), notices: {} };
const listeners = new Set<() => void>();
let unlisten: Promise<() => void> | null = null;

const publish = (next: Snapshot) => {
  snapshot = next;
  for (const l of listeners) l();
};

function apply(e: ipc.TailnetRemoteState) {
  const link = snapshot.links.get(e.ptyId);
  if (!link) return;
  const phase: LinkPhase =
    e.state === "reconnecting"
      ? { kind: "reconnecting", attempt: e.attempt ?? 1 }
      : e.state === "ended"
        ? { kind: "ended", exitCode: e.exitCode }
        : { kind: e.state };
  const links = new Map(snapshot.links);
  links.set(e.ptyId, { ...link, phase });
  const notices = { ...snapshot.notices };
  if (e.state === "revoked") notices[link.stableId] = { kind: "revoked", machine: link.machine };
  if (e.state === "ended")
    notices[link.stableId] = { kind: "ended", machine: link.machine, exitCode: e.exitCode };
  publish({ links, notices });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1)
    // A shell without the event (before the backend lands) just never reports.
    try {
      unlisten = ipc.onTailnetRemoteState(apply).then((u) => u, () => () => {});
    } catch {
      unlisten = null;
    }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && unlisten) {
      const done = unlisten;
      unlisten = null;
      void done.then((u) => u());
    }
  };
}

const read = () => snapshot;

export function useTailnetRemote(): Snapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/** The link behind a local pty id, if it is one. */
export const linkForPty = (ptyId: number | null | undefined): TailnetLink | undefined =>
  ptyId == null ? undefined : snapshot.links.get(ptyId);

export const linkFor = (stableId: string, remoteId: number): TailnetLink | undefined =>
  [...snapshot.links.values()].find((l) => l.stableId === stableId && l.remoteId === remoteId);

export function registerLink(link: Omit<TailnetLink, "phase">) {
  const links = new Map(snapshot.links);
  links.set(link.ptyId, { ...link, phase: { kind: "connected" } });
  const notices = { ...snapshot.notices };
  delete notices[link.stableId];
  publish({ links, notices });
}

export function forgetLink(ptyId: number) {
  if (!snapshot.links.has(ptyId)) return;
  const links = new Map(snapshot.links);
  links.delete(ptyId);
  publish({ links, notices: snapshot.notices });
}

export function clearNotice(stableId: string) {
  if (!snapshot.notices[stableId]) return;
  const notices = { ...snapshot.notices };
  delete notices[stableId];
  publish({ links: snapshot.links, notices });
}

/** Typing is held back while a link is down: nothing is sent to a machine that
 *  is not there, and nothing is queued to arrive late. */
export const holdsInput = (ptyId: number | null | undefined): boolean => {
  const phase = linkForPty(ptyId)?.phase.kind;
  return phase === "reconnecting" || phase === "lost";
};

/** Let go of a link: tell the backend (best effort, a missing command is fine)
 *  and forget it here. Never ends the process on the other machine. */
export function closeLink(ptyId: number) {
  if (!snapshot.links.has(ptyId)) return;
  forgetLink(ptyId);
  void ipc.tailnetRemoteClose(ptyId).catch(() => {});
}

/** Event sent to the project view to open (or focus) the tab for a link. */
export const TAILNET_OPEN_EVENT = "canopy:tailnet-open";
export interface TailnetOpenDetail {
  ptyId: number;
  cwd: string;
  title: string;
  machine: string;
}

/** The tab title: the other machine's name in front. */
export const remoteTabTitle = (machine: string, title: string) => `${machine}: ${title}`;

/** Test hook. */
export function resetTailnetRemoteForTests() {
  snapshot = { links: new Map(), notices: {} };
}
export const applyRemoteStateForTests = apply;

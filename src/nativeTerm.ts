// The native terminal window (beta): a separate window process Canopy launches
// from its bundled `canopy-term-app`. Only the desktop app on a build that
// ships it has one, so the entries that open it are drawn only when this says
// so, never disabled.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MenuItem } from "./components/ContextMenu";
import { invoke, isRemoteHost, isWorkspaceHost } from "./host";

/** Whether this window can open a native terminal. False on a remote or
 *  workspace host (its folders are not on this computer), in dev builds and on
 *  Windows (no binary), and until the answer arrives. */
export async function nativeTermAvailable(): Promise<boolean> {
  if (isRemoteHost() || isWorkspaceHost()) return false;
  try {
    return (await invoke<boolean>("native_term_available")) === true;
  } catch {
    return false;
  }
}

export function useNativeTermAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void nativeTermAvailable().then((v) => live && setAvailable(v));
    return () => {
      live = false;
    };
  }, []);
  return available;
}

/** Opens a native terminal window in `cwd`. Rejects with the reason. */
export function openNativeTerminal(cwd: string): Promise<void> {
  return invoke<void>("native_term_open", { cwd });
}

// Handing a terminal of this app to a native window, and taking it back. Rust
// keeps who holds the session (src-tauri/src/pty/handover.rs); everything here
// is read from it, so a reloaded page shows the same thing.

/** Where a handed-over terminal is: `in_window` a window holds it, `detached`
 *  the window was closed and it still runs, `ended` it is gone (exited, or the
 *  host restarted), `unreachable` the host did not answer. */
export type HandoverState = "in_window" | "detached" | "ended" | "unreachable";

export interface HandoverStatus {
  /** Terminals whose child is in the terminal host and that are ordinary
   *  terminal tabs: the ones that can be handed over. */
  candidates: number[];
  handed: { pty_id: number; state: HandoverState }[];
}

export const NO_HANDOVER: HandoverStatus = { candidates: [], handed: [] };

/** Where terminal `ptyId` is if it is handed over, else null. */
export function handedState(status: HandoverStatus, ptyId: number | null | undefined): HandoverState | null {
  if (ptyId == null) return null;
  return status.handed.find((h) => h.pty_id === ptyId)?.state ?? null;
}

/** "Open in Native Window" for a terminal tab's menu: there only when this
 *  build has the native terminal and this terminal's child is in the terminal
 *  host (persistent terminals on), and not already in a window. Hidden, never
 *  disabled, so there is nothing to explain and no setting to point at. */
export function handoverMenuItem(opts: {
  available: boolean;
  status: HandoverStatus;
  ptyId: number | null | undefined;
  onOpen: () => void;
}): MenuItem | null {
  const { available, status, ptyId, onOpen } = opts;
  if (!available || ptyId == null) return null;
  if (!status.candidates.includes(ptyId) || handedState(status, ptyId) !== null) return null;
  return { label: "Open in Native Window", onClick: onOpen };
}

export const handOverToNative = (ptyId: number) => invoke<void>("native_term_hand_over", { ptyId });
export const takeBackFromNative = (ptyId: number) => invoke<void>("native_term_take_back", { ptyId });
/** The tab that showed the terminal is closed: let go of it without stopping it. */
export const forgetHandedOver = (ptyId: number) => invoke<boolean>("native_term_forget", { ptyId });

// Whether this build has the native terminal does not change while it runs.
let available: Promise<boolean> | null = null;

export async function nativeHandoverStatus(): Promise<HandoverStatus> {
  available ??= nativeTermAvailable();
  if (!(await available)) return NO_HANDOVER;
  try {
    const raw = await invoke<HandoverStatus>("native_term_handover_status");
    return {
      candidates: Array.isArray(raw?.candidates) ? raw.candidates : [],
      handed: Array.isArray(raw?.handed) ? raw.handed : [],
    };
  } catch {
    return NO_HANDOVER;
  }
}

/** How often the status is read while any tab is showing it. The strip only
 *  needs it to offer the menu entry and to notice a window closing. */
export const HANDOVER_POLL_MS = 3000;

// One poller for every project view: it runs while something is listening.
let current: HandoverStatus = NO_HANDOVER;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let reading = false;

function publish(next: HandoverStatus) {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  listeners.forEach((listener) => listener());
}

/** Reads the status now (after a hand-over or a take back, which should show at
 *  once rather than at the next poll). */
export async function refreshHandoverStatus(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    publish(await nativeHandoverStatus());
  } finally {
    reading = false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshHandoverStatus();
    timer = setInterval(() => void refreshHandoverStatus(), HANDOVER_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useHandoverStatus(): HandoverStatus {
  return useSyncExternalStore(subscribe, () => current, () => NO_HANDOVER);
}

/** Test only: forget what was read and stop polling. */
export function resetHandoverStatusForTest() {
  current = NO_HANDOVER;
  available = null;
  reading = false;
  listeners.clear();
  if (timer != null) clearInterval(timer);
  timer = null;
}

// "All workspaces" as a workspace choice: a view mode, not a place. On, the
// window shows the tabs and projects of every machine together. It is a
// selection like the active workspace (kept across restarts), not a setting.
import { useSyncExternalStore } from "react";

const KEY = "canopy:view-all-workspaces:v1";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let current = read();

const reflect = () => {
  if (typeof document !== "undefined") {
    if (current) document.documentElement.setAttribute("data-all-workspaces", "on");
    else document.documentElement.removeAttribute("data-all-workspaces");
  }
};
reflect();

export const isAllWorkspaces = (): boolean => current;

export function setAllWorkspaces(on: boolean): void {
  if (on === current) return;
  current = on;
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* The mode still holds for this run. */
  }
  reflect();
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useAllWorkspaces = (): boolean =>
  useSyncExternalStore(subscribe, () => current, () => false);

/** Test seam: re-read storage. */
export function resetAllWorkspacesForTest(): void {
  current = read();
  reflect();
  for (const listener of listeners) listener();
}

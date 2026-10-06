// Mounted local projects own their unsaved buffers. A client-mode reload may
// detach terminals safely, but must not silently discard those buffers.
const guards = new Set<() => boolean>();
export function registerExecutionModeGuard(canLeave: () => boolean): () => void {
  guards.add(canLeave);
  return () => { guards.delete(canLeave); };
}
export function canSwitchExecutionMode(): boolean {
  for (const canLeave of guards) {
    try { if (!canLeave()) return false; }
    catch { return false; }
  }
  return true;
}

export async function setExecutionMode(mode: "local" | "remote"): Promise<void> {
  const { isTauri, invoke } = await import("@tauri-apps/api/core");
  if (isTauri()) await invoke("execution_mode_set", { mode });
  localStorage.setItem("canopy.execution-mode", mode);
  window.location.reload();
}

export async function savedExecutionMode(): Promise<string | null> {
  const { isTauri, invoke } = await import("@tauri-apps/api/core");
  if (isTauri()) {
    const mode = await invoke<string | null>("execution_mode_get");
    if (mode) return mode;
  }
  return localStorage.getItem("canopy.execution-mode");
}

// Frontend half of opt-in crash reporting. The backend (crash.rs) owns the
// payload, the POST and the pending-native-crash file; this module is the thin
// bridge the renderer uses — report the React crash the user just hit, and on
// startup flush a native panic parked from a previous run. Every path here is
// gated on the `crashReporting` opt-in (default off), so nothing is sent unless
// the user asked for it.
import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings";

/** Whether the user has turned crash reporting on. */
export function crashReportingEnabled(): boolean {
  return getSettings().crashReporting === true;
}

/** Send a renderer (React) crash. Resolves on success; rejects with the
 *  backend's error string (e.g. no endpoint baked in, or the collector's
 *  status) so the caller can show why it failed. */
export async function reportRendererCrash(
  message: string,
  stack: string | null,
): Promise<void> {
  await invoke("report_crash", { source: "renderer", message, stack });
}

/** On startup, look for a native panic the previous run parked. The backend
 *  clears it on read (offered once, never a nag loop), so we only send when the
 *  user is opted in — otherwise the read simply discards it. Best-effort:
 *  swallows all errors so a failed report never blocks launch. */
export async function flushPendingCrash(): Promise<void> {
  try {
    const report = await invoke<unknown>("take_pending_crash");
    if (!report || !crashReportingEnabled()) return;
    await invoke("send_crash", { report });
  } catch {
    // Reporting is a courtesy, never a launch dependency.
  }
}

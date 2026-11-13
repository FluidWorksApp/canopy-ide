// Content-free stage codes for terminals a previous launch left running,
// written to the release resilience log (allowlisted in js_log). Timestamps
// on those lines show where a reconnect stalls: the workspace map arriving,
// a live session being routed to a project (or dropped as outside every
// project), and its tab appearing. Never ids, names, paths or counts.
import { invoke } from "./host";

export type ReconnectStage =
  | "routing-ready"
  | "routed"
  | "outside-project"
  | "tab-attached";

export function reconnectDiagnostic(stage: ReconnectStage): void {
  try {
    void invoke("js_log", { level: "boot", message: `reconnect-stage:${stage}` }).catch(() => {});
  } catch {
    /* Not running in Canopy. */
  }
}

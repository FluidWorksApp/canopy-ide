import { invoke } from "@tauri-apps/api/core";

/** Constant-size native preview-pressure lifecycle counters. */
export interface BrowserPressureReloadMetrics {
  enabled: boolean;
  decisions: number;
  targets: number;
  attempts: number;
  successes: number;
  failures: number;
  missingViews: number;
  suppressedTargets: number;
  /** Synchronous native reload-dispatch time, not page load/reclaimed-memory time. */
  dispatchLatencyMsTotal: number;
  dispatchLatencyMsLast: number;
  dispatchLatencyMsMax: number;
}

/** Read-only measurement hook for diagnostics and disposable-runner soaks. */
export const browserPressureReloadMetrics = () =>
  invoke<BrowserPressureReloadMetrics>("browser_pressure_reload_metrics");

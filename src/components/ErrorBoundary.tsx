// A render-phase throw with no boundary makes React 18's createRoot unmount the
// WHOLE tree — the app goes to a black void with only the native title bar left.
// For an IDE holding long-running agent sessions that is the worst failure mode:
// one panel's bug takes everything down. This catches the throw, keeps the rest
// of the app alive, shows a recoverable panel instead of a blank window, and
// reports the error to the Rust log (webview target) so the cause is findable.
//
// It's also where opt-in crash reporting surfaces: the crash the user is looking
// at is the one worth sending, so the offer lives right on the fallback. Nothing
// is sent without an explicit click, and when reporting is off the button is the
// moment the user turns it on (see reportRendererCrash / settings.crashReporting).
import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { crashReportingEnabled, reportRendererCrash } from "../crash";
import { updateSettings } from "../settings";

interface Props {
  /** Names the region in the fallback and the log — "the sidebar", "this tab". */
  label?: string;
  children: ReactNode;
}

type ReportState = "idle" | "sending" | "sent" | "error";

interface State {
  error: Error | null;
  /** React's component stack for the throw — carried into the report. */
  componentStack: string | null;
  reportState: ReportState;
  /** The backend's reason a send failed, shown so a misconfigured endpoint
   *  (or an offline machine) isn't a silent dead end. */
  reportError: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    componentStack: null,
    reportState: "idle",
    reportError: null,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = this.props.label ? ` in ${this.props.label}` : "";
    this.setState({ componentStack: info.componentStack ?? null });
    void invoke("js_log", {
      level: "error",
      message: `React crash${where}: ${error.stack || error.message}\n${info.componentStack ?? ""}`,
    }).catch(() => {});
  }

  private reset = () =>
    this.setState({
      error: null,
      componentStack: null,
      reportState: "idle",
      reportError: null,
    });

  /** Send the current crash. `enableFirst` flips the opt-in on before sending —
   *  it's how the "off" state's button doubles as the opt-in gesture. */
  private send = async (enableFirst: boolean) => {
    const { error, componentStack } = this.state;
    if (!error) return;
    if (enableFirst) updateSettings({ crashReporting: true });
    this.setState({ reportState: "sending", reportError: null });
    const stack = [error.stack, componentStack].filter(Boolean).join("\n") || null;
    try {
      await reportRendererCrash(error.message || String(error), stack);
      this.setState({ reportState: "sent" });
    } catch (e) {
      this.setState({ reportState: "error", reportError: String(e) });
    }
  };

  /** The report offer — a click-to-send button, plus the opt-in prompt when
   *  reporting is off. Kept out of render() to keep the fallback readable. */
  private renderReport() {
    const { reportState, reportError } = this.state;
    if (reportState === "sent") {
      return <div className="crash-report-done">Report sent — thank you.</div>;
    }
    const optedIn = crashReportingEnabled();
    const sending = reportState === "sending";
    return (
      <div className="crash-report">
        {!optedIn && (
          <div className="crash-report-note">
            Send an anonymous crash report to help fix this? It includes the error
            and stack, the app version and your OS — nothing else.
          </div>
        )}
        <button className="btn" disabled={sending} onClick={() => void this.send(!optedIn)}>
          {sending
            ? "Sending…"
            : optedIn
              ? "Report this crash"
              : "Enable crash reports & send"}
        </button>
        {reportState === "error" && (
          <div className="crash-report-err">
            Couldn't send{reportError ? `: ${reportError}` : ""}.
          </div>
        )}
      </div>
    );
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-fallback">
        <div className="crash-title">
          {this.props.label ? `${this.props.label} crashed` : "Something crashed"}
        </div>
        <div className="crash-msg">{error.message || String(error)}</div>
        <div className="crash-actions">
          <button className="btn btn-accent" onClick={this.reset}>
            Reload this panel
          </button>
          {this.renderReport()}
        </div>
      </div>
    );
  }
}

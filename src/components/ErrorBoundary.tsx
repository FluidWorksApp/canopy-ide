// A render-phase throw with no boundary makes React 18's createRoot unmount the
// WHOLE tree — the app goes to a black void with only the native title bar left.
// For an IDE holding long-running agent sessions that is the worst failure mode:
// one panel's bug takes everything down. This catches the throw, keeps the rest
// of the app alive, shows a recoverable panel instead of a blank window, and
// reports the error to the Rust log (webview target) so the cause is findable.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  /** Names the region in the fallback and the log — "the sidebar", "this tab". */
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = this.props.label ? ` in ${this.props.label}` : "";
    void invoke("js_log", {
      level: "error",
      message: `React crash${where}: ${error.stack || error.message}\n${info.componentStack ?? ""}`,
    }).catch(() => {});
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
        <button className="btn btn-accent" onClick={() => this.setState({ error: null })}>
          Reload this panel
        </button>
      </div>
    );
  }
}

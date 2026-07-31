// A render-phase throw with no boundary makes React 18's createRoot unmount the
// WHOLE tree — the app goes to a black void with only the native title bar left.
// For an IDE holding long-running agent sessions that is the worst failure mode:
// one panel's bug takes everything down. This catches the throw, keeps the rest
// of the app alive, shows a recoverable panel instead of a blank window, and
// reports the error to the Rust log (webview target) so the cause is findable.
//
// It's also where crash reporting surfaces: the crash the user is looking at is
// the one worth reporting, so the offer lives right on the fallback. Two routes
// out, and the default is the one that needs no infrastructure of ours — file a
// GitHub issue through the user's own `gh` login, which also hands them a URL to
// follow. Because that issue is public and carries their username, it is always
// shown in full and editable first; the anonymous email path stays available
// behind the settings opt-in for anyone who'd rather not be named.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  crashReportingEnabled,
  crashIssueDraft,
  fileCrashIssue,
  issueComposeUrl,
  issueFiler,
  reportRendererCrash,
  type CrashIssueDraft,
  type CrashIssueOutcome,
} from "../crash";
import { updateSettings } from "../settings";
import { Button } from "./ui";

interface Props {
  /** Names the region in the fallback and the log — "the sidebar", "this tab". */
  label?: string;
  children: ReactNode;
}

/** `preview` is the consent step for the public path; `sending`/`sent` belong to
 *  the anonymous collector. One flow at a time, so they share a phase. */
type Phase =
  | "idle"
  | "drafting"
  | "preview"
  | "filing"
  | "filed"
  | "sending"
  | "sent";

interface State {
  error: Error | null;
  /** React's component stack for the throw — carried into the report. */
  componentStack: string | null;
  phase: Phase;
  draft: CrashIssueDraft | null;
  /** The body as the user has it — starts as the draft's, stays editable. */
  body: string;
  /** Whether `gh` is installed *and* its token works, plus who as. */
  canFile: boolean;
  account: string;
  outcome: CrashIssueOutcome | null;
  /** Why the last attempt failed — a complete sentence, since the three routes
   *  fail for different reasons and each says its own. Shown rather than
   *  swallowed so a missing endpoint, an unauthorized token or an offline
   *  machine isn't a silent dead end. */
  failure: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    componentStack: null,
    phase: "idle",
    draft: null,
    body: "",
    canFile: false,
    account: "",
    outcome: null,
    failure: null,
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
      phase: "idle",
      draft: null,
      body: "",
      outcome: null,
      failure: null,
    });

  private stack(): string | null {
    const { error, componentStack } = this.state;
    return [error?.stack, componentStack].filter(Boolean).join("\n") || null;
  }

  /** Build the issue and show it. Two round trips — the draft and the `gh`
   *  probe — run together, since neither needs the other. */
  private startReport = async () => {
    const { error } = this.state;
    if (!error) return;
    this.setState({ phase: "drafting", failure: null });
    try {
      const [draft, filer] = await Promise.all([
        crashIssueDraft(error.message || String(error), this.stack()),
        issueFiler(),
      ]);
      this.setState({
        phase: "preview",
        draft,
        body: draft.body,
        canFile: filer.canFile,
        account: filer.account,
      });
    } catch (e) {
      this.setState({ phase: "idle", failure: `Couldn't prepare the report: ${e}` });
    }
  };

  /** Publish it. Stays on the preview when it fails, so an edited body isn't
   *  lost to a network blip or an under-scoped token. */
  private file = async () => {
    const { draft, body } = this.state;
    if (!draft) return;
    this.setState({ phase: "filing", failure: null });
    try {
      const outcome = await fileCrashIssue(draft.title, body, draft.fingerprint);
      this.setState({ phase: "filed", outcome });
    } catch (e) {
      // gh's own message names the cause — an expired or under-scoped token is
      // the usual one — so it goes through verbatim.
      this.setState({ phase: "preview", failure: `Couldn't file it: ${e}` });
    }
  };

  /** No working `gh`: hand the prefilled form to the browser and let the user
   *  press the last button. Their edits go with it. */
  private compose = () => {
    const { draft, body } = this.state;
    if (!draft) return;
    void openUrl(issueComposeUrl({ ...draft, body }));
    this.setState({ phase: "filed", outcome: null });
  };

  /** The anonymous route. `enableFirst` flips the opt-in on before sending —
   *  it's how the "off" state's button doubles as the opt-in gesture. */
  private sendAnonymously = async (enableFirst: boolean) => {
    const { error } = this.state;
    if (!error) return;
    if (enableFirst) updateSettings({ crashReporting: true });
    this.setState({ phase: "sending", failure: null });
    try {
      await reportRendererCrash(error.message || String(error), this.stack());
      this.setState({ phase: "sent" });
    } catch (e) {
      this.setState({ phase: "idle", failure: `Couldn't send: ${e}` });
    }
  };

  private renderFailure() {
    const { failure } = this.state;
    if (!failure) return null;
    return <div className="crash-report-err">{failure}</div>;
  }

  /** The consent step. Everything that would be published is on screen and
   *  editable — this is the only thing standing between a crash and a public,
   *  permanently attributed issue, so it says so plainly. */
  private renderPreview() {
    const { draft, body, canFile, account, phase, failure } = this.state;
    if (!draft) return null;
    const busy = phase === "filing";
    return (
      <div className="crash-report crash-report-preview">
        <div className="crash-report-note">
          This opens a <strong>public</strong> issue on <code>{draft.repo}</code>
          {canFile && account ? (
            <>
              {" "}
              as <code>@{account}</code>
            </>
          ) : null}
          . Anyone can read it and it stays on the record. Home-folder paths are
          already replaced with <code>~</code> — have a look for anything else
          you'd rather not share, and edit it out.
        </div>
        <div className="crash-report-subject">{draft.title}</div>
        <textarea
          className="crash-report-body"
          value={body}
          spellCheck={false}
          onChange={(e) => this.setState({ body: e.target.value })}
        />
        {!canFile && (
          <div className="crash-report-note">
            The GitHub CLI isn't signed in here, so this opens the prefilled form
            in your browser instead — you press Submit.
          </div>
        )}
        <div className="crash-report-row">
          <Button variant="accent"
            disabled={busy}
            onClick={canFile ? () => void this.file() : this.compose}>
            {busy ? "Filing…" : canFile ? "File this issue" : "Open GitHub to file it"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => this.setState({ phase: "idle", failure: null })}>
            Cancel
          </Button>
        </div>
        {failure && <div className="crash-report-err">{failure}</div>}
      </div>
    );
  }

  /** Where it landed. The URL is the whole point of this route, so it's the
   *  loudest thing here. */
  private renderFiled() {
    const { outcome } = this.state;
    if (!outcome) {
      return (
        <div className="crash-report-done">
          Opened GitHub in your browser — submit it there and thank you.
        </div>
      );
    }
    return (
      <div className="crash-report">
        <div className="crash-report-note">
          {outcome.existing
            ? "Someone had already reported this — your details are on the existing issue."
            : "Filed. Thank you."}
        </div>
        <Button onClick={() => void openUrl(outcome.url)}>
          {outcome.existing ? "View that issue" : "View your issue"}
        </Button>
      </div>
    );
  }

  /** The report offer. Kept out of render() to keep the fallback readable. */
  private renderReport() {
    const { phase } = this.state;
    if (phase === "preview" || phase === "filing") return this.renderPreview();
    if (phase === "filed") return this.renderFiled();
    if (phase === "sent") {
      return <div className="crash-report-done">Report sent — thank you.</div>;
    }

    const optedIn = crashReportingEnabled();
    const busy = phase === "drafting" || phase === "sending";
    return (
      <div className="crash-report">
        <div className="crash-report-row">
          <Button disabled={busy} onClick={() => void this.startReport()}>
            {phase === "drafting" ? "Preparing…" : "Report this crash"}
          </Button>
          <Button size="sm"
            disabled={busy}
            title={
              optedIn
                ? "Email the report to the maintainers with no name attached"
                : "Turns on anonymous crash reports, then sends this one"
            }
            onClick={() => void this.sendAnonymously(!optedIn)}>
            {phase === "sending" ? "Sending…" : "Send anonymously"}
          </Button>
        </div>
        <div className="crash-report-note">
          Reporting opens a public GitHub issue you can follow. Sending
          anonymously emails it to the maintainers instead — no name, no link
          back, nothing to watch.
        </div>
        {this.renderFailure()}
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
          <Button variant="accent" onClick={this.reset}>
            Reload this panel
          </Button>
          {this.renderReport()}
        </div>
      </div>
    );
  }
}

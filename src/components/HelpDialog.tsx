// Help: what Canopy is, how the agent features work, and every shortcut.
// Static on purpose — this must render instantly and work offline.
import { openUrl } from "@tauri-apps/plugin-opener";
import { format, helpRows } from "../shortcuts";
import { describeTrigger } from "../dictationTrigger";
import { formatHotkey, getSettings, modKeyLabel } from "../settings";
import { useEscape } from "../useEscape";
import { Button } from "./ui";

interface HelpDialogProps {
  onClose: () => void;
  /** Re-open the first-run walkthrough on demand. */
  onReplayIntro?: () => void;
}

export function HelpDialog({ onClose, onReplayIntro }: HelpDialogProps) {
  useEscape(onClose, true);
  const settings = getSettings();
  const rows = helpRows().map((row) =>
    row.id === "dictation"
      ? {
          ...row,
          keys: describeTrigger(
            settings.dictationTriggerMode,
            modKeyLabel(settings.dictationModKey),
            formatHotkey(settings.dictationHotkey),
          ),
          label: "Voice dictation (Esc cancels)",
        }
      : row,
  );
  const link = (url: string, label: string) => (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        void openUrl(url);
      }}
    >
      {label}
    </a>
  );
  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div className="confirm help-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="side-panel-head">
          <span>Canopy Help</span>
        </div>
        <div className="help-body">
          <div className="set-head">Getting started</div>
          <p>
            A <strong>project</strong> is one or more directories (frontend,
            backend, …) opened together. Create one with{" "}
            <code>{format("new-project")}</code>, then launch a
            shell or an agent CLI from the ＋ menu, the empty-state grid, or by
            right-clicking a directory in the sidebar. Terminals keep running
            when you switch projects.
          </p>
          {onReplayIntro && (
            <p>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onReplayIntro();
                }}
              >
                Replay the welcome walkthrough
              </a>
            </p>
          )}

          <div className="set-head">Agents</div>
          <p>
            Canopy detects agent CLIs (Claude Code, Codex, Antigravity, Aider,
            OpenCode, oh-my-pi, Amp) running in its terminals. With hooks set
            up (automatic at launch; buttons in the Agents panel → ?), agent
            questions and permission prompts surface as cards you can answer
            from the panel, finished turns show quietly, and past sessions can
            be restored with their history after a crash or restart.
          </p>
          <p>
            <strong>Shared context</strong> (per project, off by default) lets
            sessions in the same project see a short summary of each other's
            recent work. <strong>Run commands</strong> configured on a
            directory appear as ▶ buttons and run as services in the RUNS
            rail. The status bar shows the model, token usage and estimated
            cost of the active Claude session — click the model to switch it,
            click the cpu/mem figure for a per-project resource breakdown.
          </p>

          <div className="set-head">Keyboard shortcuts</div>
          <table className="help-keys">
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.keys}</code>
                  </td>
                  <td>{row.label}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="set-head">Support &amp; about</div>
          <p>
            <Button variant="accent"
              onClick={() => void openUrl("mailto:Sam@CauseConnect.ai")}>
              Contact support
            </Button>
          </p>
          <p>
            {link("https://canopyide.dev", "canopyide.dev")} ·{" "}
            {link("https://github.com/FluidWorksApp/canopy-ide", "GitHub")} ·{" "}
            {link(
              "https://github.com/FluidWorksApp/canopy-ide/issues/new",
              "Report an issue",
            )}{" "}
            ·{" "}
            {link("https://canopyide.dev/privacy", "Privacy")} ·{" "}
            {link("https://canopyide.dev/terms", "Terms")}
          </p>
        </div>
        <div className="confirm-actions">
          <Button variant="accent" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

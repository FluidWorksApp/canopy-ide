// Help: what Canopy is, how the agent features work, and every shortcut.
// Static on purpose — this must render instantly and work offline.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEscape } from "../useEscape";

interface HelpDialogProps {
  onClose: () => void;
  /** Re-open the first-run walkthrough on demand. */
  onReplayIntro?: () => void;
}

const SHORTCUTS: [string, string][] = [
  ["⌘N", "New project"],
  ["⌘O", "Open project folder"],
  ["⌘⇧M", "Manage projects (create, edit, delete)"],
  ["⌘⌥← / ⌘⌥→", "Previous / next project"],
  ["⌘T", "New terminal in the active project"],
  ["⌃⌘← / ⌃⌘→", "Previous / next tab"],
  ["⌘W", "Close tab"],
  ["⌘⇧W", "Close project"],
  ["⌘P", "Quick-open a file"],
  ["⌘⇧F", "Find in files"],
  ["⌘B", "Toggle sidebar"],
  ["⌘⇧Enter", "Focus mode (Esc leaves)"],
  ["⌘, ", "Settings"],
  ["⌥← / ⌥→", "Terminal: jump word left / right"],
  ["⌘← / ⌘→", "Terminal: start / end of line"],
  ["⌥⌫", "Terminal: delete word"],
  ["⌘⌫", "Terminal: delete line"],
];

export function HelpDialog({ onClose, onReplayIntro }: HelpDialogProps) {
  useEscape(onClose, true);
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
            backend, …) opened together. Create one with ⌘N, then launch a
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
              {SHORTCUTS.map(([keys, what]) => (
                <tr key={keys}>
                  <td>
                    <code>{keys}</code>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="set-head">Resources</div>
          <p>
            {link("https://canopyide.dev", "canopyide.dev")} ·{" "}
            {link("https://github.com/FluidWorksApp/canopy-ide", "GitHub")} ·{" "}
            {link(
              "https://github.com/FluidWorksApp/canopy-ide/issues/new",
              "Report an issue",
            )}
          </p>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-accent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

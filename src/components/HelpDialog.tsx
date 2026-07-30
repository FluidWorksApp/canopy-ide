// Help: what Canopy is, how the agent features work, and every shortcut.
// Static on purpose — this must render instantly and work offline.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEscape } from "../useEscape";
import { IS_MAC } from "../platform";
import { Button } from "./ui";

interface HelpDialogProps {
  onClose: () => void;
  /** Re-open the first-run walkthrough on demand. */
  onReplayIntro?: () => void;
}

const SHORTCUTS: [string, string][] = [
  ["⌘N", "New tab — shell, preview or an agent (type to filter, ↵ to open)"],
  ["⌘⇧N", "New project"],
  ["⌘O", "Open project folder"],
  ["⌘⇧M", "Manage projects (create, edit, delete)"],
  ["⌘1…9", "Jump to a tab — hold ⌘ and the tabs show their numbers"],
  ["⌥1…9", "Jump to a project — hold ⌥ and the pills show their numbers"],
  ["⌘⌥← / ⌘⌥→", "Previous / next project"],
  ["⌘T", "New terminal in the active project"],
  ["⌃⇥ / ⌃⇧⇥", "Next / previous tab"],
  ["⌃⌘← / ⌃⌘→", "Previous / next tab"],
  ["⌘W", "Close tab"],
  ["⌘⇧W", "Close project"],
  ["⌘P", "Quick-open a file"],
  ["⌘⇧F", "Find in files"],
  ["⌘K", "SpotSearch — search everything, or run what you type as a task"],
  ["⌘B", "Toggle sidebar"],
  ["⌘⇧Enter", "Focus mode (Esc leaves)"],
  ["⌘D", "Voice dictation — speak, press again to insert (Esc cancels)"],
  ["⌘, ", "Settings"],
  ["⌥← / ⌥→", "Terminal: jump word left / right"],
  ["⌘← / ⌘→", "Terminal: start / end of line"],
  ["⌥⌫", "Terminal: delete word"],
  ["⌘⌫", "Terminal: delete line"],
];

/** The table is written in macOS glyphs. Every accelerator is CmdOrCtrl-based,
 *  so off macOS the same chord is spelled with Ctrl/Alt/Shift — show that
 *  rather than teaching a Windows user a key their keyboard doesn't have. */
function forPlatform(keys: string): string {
  if (IS_MAC) return keys;
  return keys
    .replace(/[⌘⌃]/g, "Ctrl+")
    .replace(/⌥/g, "Alt+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌫/g, "Backspace")
    // Control+CmdOrCtrl collapses to one Ctrl off macOS, where both halves of
    // the chord are the same key.
    .replace(/(Ctrl\+)+/g, "Ctrl+")
    .replace(/\+ /g, "+");
}

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
                    <code>{forPlatform(keys)}</code>
                  </td>
                  <td>{what}</td>
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

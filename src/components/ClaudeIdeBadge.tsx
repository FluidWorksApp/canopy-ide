// The terminal tab's mark that Claude Code in it is connected to Canopy as
// its IDE — the same fact `/ide` shows as "✔ Canopy" inside the CLI.
import { useSyncExternalStore } from "react";
import { claudeIdeState, subscribeClaudeIde } from "../claudeIde";

export function ClaudeIdeBadge({ ptyId }: { ptyId: number | null | undefined }) {
  const connected = useSyncExternalStore(
    subscribeClaudeIde,
    () => ptyId != null && claudeIdeState().connections.has(ptyId),
  );
  if (!connected) return null;
  return (
    <span
      className="claude-ide-badge"
      title="Claude Code is connected to Canopy: edits open as diffs here, and it sees your selection"
      aria-label="Connected to Canopy"
    >
      ⧉
    </span>
  );
}

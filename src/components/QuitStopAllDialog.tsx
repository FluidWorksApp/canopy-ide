// "Quit and Stop All…" asking first, because agents are running. The decision
// to ask, and the counts, live in quitStopAll.ts.

import { stopAllMeta, stopAllTitle, type TerminalCounts } from "../quitStopAll";
import { format } from "../shortcuts";
import { Dialog } from "./Dialog";

export function QuitStopAllDialog({
  counts,
  onCancel,
  onQuit,
}: {
  counts: TerminalCounts;
  onCancel: () => void;
  /** `true` for Stop all, `false` for Quit only (the normal Quit). */
  onQuit: (stopAll: boolean) => void;
}) {
  return (
    <Dialog
      variant="danger"
      title={stopAllTitle(counts.agents)}
      hint={format("quit-stop-all") || undefined}
      body="Their work stops mid-turn."
      meta={stopAllMeta(counts)}
      dismissLabel="Cancel"
      onDismiss={onCancel}
      actions={[
        { label: "Quit only", onClick: () => onQuit(false) },
        { label: "Stop all", primary: true, onClick: () => onQuit(true) },
      ]}
    />
  );
}

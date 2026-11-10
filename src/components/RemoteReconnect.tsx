// What a terminal that ran on another machine shows after its project slept.
// Waking the project never connects to that machine (connecting wakes and bills
// a workspace); the session is still running there, and this is the one button
// that goes and gets it.
import { useState } from "react";
import { Button } from "./ui";

export function RemoteReconnect({
  machineName,
  onReconnect,
  onClose,
}: {
  machineName: string;
  /** Resolves with a reason when the session could not be taken back. */
  onReconnect: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="term-reconnect" role="status">
      <p>This terminal runs on {machineName}. It is not connected right now.</p>
      {problem && <p className="term-reconnect-problem">{problem}</p>}
      <div className="term-reconnect-actions">
        <Button
          variant="accent"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            void onReconnect()
              .then((reason) => setProblem(reason))
              .catch((error) => setProblem(String((error as Error)?.message ?? error)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Connecting…" : `Reconnect to ${machineName}`}
        </Button>
        <Button onClick={onClose}>Close tab</Button>
      </div>
    </div>
  );
}

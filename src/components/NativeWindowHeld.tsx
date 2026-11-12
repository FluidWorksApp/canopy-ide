// What a terminal tab shows while the terminal is open in a native window: the
// tab keeps its place, the window has the session, and one button takes it back.
// Modelled on RemoteReconnect, which does the same for a terminal that runs on
// another machine.
import { useState } from "react";
import type { HandoverState } from "../nativeTerm";
import { Button } from "./ui";

const TEXT: Record<HandoverState, string> = {
  in_window: "Open in native window",
  unreachable: "Open in native window",
  detached: "The native window was closed. This terminal is still running.",
  ended: "This terminal ended in the native window.",
};

export function NativeWindowHeld({
  state,
  onTakeBack,
  onClose,
}: {
  state: HandoverState;
  /** Resolves with a reason when the terminal could not be taken back. */
  onTakeBack: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="term-reconnect" role="status">
      <p>{TEXT[state]}</p>
      {state === "unreachable" && (
        <p className="term-reconnect-problem">The terminal host is not answering right now.</p>
      )}
      {problem && <p className="term-reconnect-problem">{problem}</p>}
      <div className="term-reconnect-actions">
        {state === "ended" ? (
          <Button variant="accent" onClick={onClose}>
            Close tab
          </Button>
        ) : (
          <Button
            variant="accent"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              void onTakeBack()
                .then((reason) => setProblem(reason))
                .catch((error) => setProblem(String((error as Error)?.message ?? error)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Taking back…" : "Take back"}
          </Button>
        )}
      </div>
    </div>
  );
}

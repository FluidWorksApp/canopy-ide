// "Quit and Stop All…" asking first, because agents are running (or to report
// that stopping failed). The decision to ask, and the counts, live in
// quitStopAll.ts.

import { useState } from "react";
import {
  errorText,
  lingerText,
  stopAllMeta,
  stopAllTitle,
  type QuitStopAllAsk,
} from "../quitStopAll";
import { format } from "../shortcuts";
import { Dialog, type DialogAction } from "./Dialog";

export function QuitStopAllDialog({
  ask,
  onCancel,
  onQuit,
}: {
  ask: QuitStopAllAsk;
  onCancel: () => void;
  /** `true` for Stop all, `false` for Quit only (the normal Quit). Resolves
   *  as the app quits; a rejection is shown here and the dialog stays. */
  onQuit: (stopAll: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(ask.error);
  const run = (stopAll: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    onQuit(stopAll).catch((e) => {
      setError(errorText(e));
      setBusy(false);
    });
  };
  const actions: DialogAction[] = [
    // With the host off a plain Quit stops everything too, so there is no
    // "Quit only" to offer.
    ...(ask.hostOn ? [{ label: "Quit only", disabled: busy, onClick: () => run(false) }] : []),
    { label: "Stop all", primary: true, disabled: busy, onClick: () => run(true) },
  ];
  return (
    <Dialog
      variant="danger"
      title={stopAllTitle(ask.counts.agents)}
      hint={format("quit-stop-all") || undefined}
      body={
        <>
          {ask.counts.agents > 0 && <div>Their work stops mid-turn.</div>}
          {(ask.background ?? 0) > 0 && (
            <div>
              {ask.background} of these {ask.background === 1 ? "is" : "are"} still running in the
              background from an earlier launch.
            </div>
          )}
          {(ask.counts.unknown ?? 0) > 0 && (
            <div>Unidentified ones could be agents.</div>
          )}
          {ask.hostOn && (ask.lingerSecs ?? 0) > 0 && (
            <div>Quit only keeps terminals running for {lingerText(ask.lingerSecs!)}.</div>
          )}
          {error && (
            <div role="alert" style={{ color: "var(--danger)" }}>
              {error}
            </div>
          )}
        </>
      }
      meta={stopAllMeta(ask.counts)}
      dismissLabel="Cancel"
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      actions={actions}
    />
  );
}

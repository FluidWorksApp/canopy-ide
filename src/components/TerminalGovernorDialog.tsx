import { useState } from "react";
import { fmtBytes } from "../cleanup";
import type {
  TerminalBudgetStatus,
  TerminalGovernorCapability,
} from "../ipc";
import { Dialog, type DialogAction } from "./Dialog";

interface Props {
  status: TerminalBudgetStatus;
  capability: TerminalGovernorCapability;
  busy?: boolean;
  error?: string | null;
  onGrant: (bytes: number, rememberForCli: boolean) => void;
  onStop: () => void;
  onDismiss: () => void;
}

export function TerminalGovernorDialog({
  status,
  capability,
  busy = false,
  error,
  onGrant,
  onStop,
  onDismiss,
}: Props) {
  const [rememberForCli, setRememberForCli] = useState(false);
  const request = status.grant_request;
  const actions: DialogAction[] = [
    ...(request?.increments ?? []).map((bytes, index) => ({
      label: `Allow +${fmtBytes(bytes)}`,
      primary: index === 0,
      disabled: busy,
      onClick: () => onGrant(bytes, rememberForCli),
    })),
    {
      label: "Stop terminal",
      disabled: busy,
      onClick: onStop,
    },
  ];
  const enforcement = capability.soft_limit
    ? "A verified operating-system soft boundary applies reclaim and throttling without a cgroup OOM kill; it is raised only after you approve the grant and may be exceeded under extreme conditions."
    : capability.hard_limit
      ? "The operating-system container will be raised only after you approve it."
      : "This platform is currently monitor-only; choosing Stop is the immediate containment action, and an allowance grant does not create a hard OS limit.";

  return (
    <Dialog
      variant={status.state === "over_allowance" ? "danger" : "accent"}
      title={`Terminal ${status.id} is using ${fmtBytes(status.current_bytes)}`}
      body={`Its one-session allowance is ${fmtBytes(status.allowance_bytes)}. ${enforcement}`}
      meta={
        error || (
          <>
            <span>{`Peak ${fmtBytes(status.peak_bytes)} · ${capability.measurement.replaceAll("_", " ")}`}</span>
            {status.cli_key && (
              <label className="terminal-governor-remember">
                <input
                  type="checkbox"
                  checked={rememberForCli}
                  disabled={busy}
                  onChange={(event) =>
                    setRememberForCli(event.currentTarget.checked)
                  }
                />
                Remember this increment for this CLI on this device
              </label>
            )}
          </>
        )
      }
      dismissLabel="Decide later"
      onDismiss={onDismiss}
      actions={actions}
    />
  );
}

import { useState } from "react";
import { fmtBytes } from "../cleanup";
import type {
  TerminalBudgetStatus,
  TerminalGovernorCapability,
} from "../ipc";
import type { TerminalMemoryQuotaGroup } from "../terminalMemoryPressure";
import { AGENT_MEMORY_MAXIMUM_CHOICES } from "../agentMemory";
import { Button, Select } from "./ui";
import {
  terminalDisplayName,
  type TerminalNameSource,
} from "../agentDisplayName";

interface Props {
  status: TerminalBudgetStatus;
  quota: TerminalMemoryQuotaGroup;
  members: Array<{
    status: TerminalBudgetStatus;
    session?: Omit<TerminalNameSource, "id">;
  }>;
  capability: TerminalGovernorCapability;
  busy?: boolean;
  error?: string | null;
  onGrant: (bytes: number, rememberForCli: boolean) => void;
  onMaximumChange: (bytes: number | null) => void;
  onStop: () => void;
  onDismiss: () => void;
}

export function TerminalGovernorCard({
  status,
  quota,
  members,
  capability,
  busy = false,
  error,
  onGrant,
  onMaximumChange,
  onStop,
  onDismiss,
}: Props) {
  const memberNames = members.map(({ status: member, session }) =>
    terminalDisplayName({ id: member.id, agent: false, ...session }),
  );
  const targetIndex = members.findIndex((member) => member.status.id === status.id);
  const terminalName = memberNames[targetIndex] ?? `Terminal ${status.id}`;
  const multiplexed = members.length > 1;
  const [rememberForCli, setRememberForCli] = useState(false);
  const request = status.grant_request;
  const title = multiplexed
    ? `${members.length}-agent multiplex is using ${fmtBytes(quota.current_bytes)}`
    : `${terminalName} is using ${fmtBytes(status.current_bytes)}`;
  const enforcement = capability.soft_limit
    ? "A verified operating-system soft boundary applies reclaim and throttling without a cgroup OOM kill; it is raised only after you approve the grant and may be exceeded under extreme conditions."
    : capability.hard_limit
      ? "The operating-system container will be raised only after you approve it."
      : "This platform is currently monitor-only; choosing Stop is the immediate containment action, and an allowance grant does not create a hard OS limit.";

  return (
    <section
      className="terminal-governor-card"
      role="region"
      aria-label={title}
    >
      <header className="terminal-governor-card-head">
        <div>
          <span>Memory decision</span>
          <strong>{title}</strong>
        </div>
        <Button icon title="Decide later" onClick={onDismiss}>×</Button>
      </header>
      <p>
        {multiplexed
          ? `Its combined allowance is ${fmtBytes(quota.allowance_bytes)} across ${members.length} agents. Grants remain per agent; this decision applies to ${terminalName}. ${enforcement}`
          : `Its one-agent allowance is ${fmtBytes(status.allowance_bytes)}. ${enforcement}`}
      </p>
      <div className="terminal-governor-controls">
        {multiplexed && (
          <div className="terminal-governor-members" aria-label="Per-agent memory allowances">
            {members.map(({ status: member }, index) => (
              <div key={member.id} className={member.id === status.id ? "is-target" : undefined}>
                <span>{memberNames[index]}</span>
                <span>
                  {fmtBytes(member.current_bytes)} / {fmtBytes(member.allowance_bytes)}
                  {member.max_allowance_bytes != null
                    ? ` · max ${fmtBytes(member.max_allowance_bytes)}`
                    : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        {status.cli_key && (
          <label className="terminal-governor-maximum">
            <span>Maximum allowance for {terminalName}</span>
            <Select
              aria-label={`Maximum allowance for ${terminalName}`}
              width="sm"
              size="sm"
              value={status.max_allowance_bytes ?? 0}
              disabled={busy}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                onMaximumChange(value === 0 ? null : value);
              }}
            >
              <option value={0}>Automatic</option>
              {status.max_allowance_bytes != null &&
                !AGENT_MEMORY_MAXIMUM_CHOICES.includes(status.max_allowance_bytes) && (
                  <option value={status.max_allowance_bytes}>
                    {fmtBytes(status.max_allowance_bytes)}
                  </option>
                )}
              {AGENT_MEMORY_MAXIMUM_CHOICES.map((bytes) => (
                <option key={bytes} value={bytes}>{fmtBytes(bytes)}</option>
              ))}
            </Select>
            <small>Caps future allowance grants; it does not create a hard OS limit.</small>
          </label>
        )}
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
        <div className={`terminal-governor-meta${error ? " is-error" : ""}`}>
          {error || `Peak ${fmtBytes(quota.peak_bytes)} · ${capability.measurement.replaceAll("_", " ")}`}
        </div>
      </div>
      <div className="terminal-governor-actions">
        <Button onClick={onDismiss} disabled={busy}>Decide later</Button>
        {(request?.increments ?? []).map((bytes, index) => (
          <Button
            key={bytes}
            variant={index === 0 ? "accent" : "default"}
            disabled={busy}
            onClick={() => onGrant(bytes, rememberForCli)}
          >
            Allow {multiplexed ? `${terminalName} ` : ""}+{fmtBytes(bytes)}
          </Button>
        ))}
        <Button onClick={onStop} disabled={busy}>Stop terminal</Button>
      </div>
    </section>
  );
}

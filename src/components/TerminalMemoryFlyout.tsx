import type { TerminalBudgetStatus } from "../ipc";
import type { TerminalMemoryQuotaGroup } from "../terminalMemoryPressure";
import { Button } from "./ui";
import {
  terminalDisplayName,
  type TerminalNameSource,
} from "../agentDisplayName";

const formatBytes = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

const stateCopy = (quota: TerminalMemoryQuotaGroup) => {
  if (quota.state === "over_allowance") return "This tab is over its combined per-agent allowance.";
  if (quota.state === "awaiting_grant") return "This tab is close to its combined per-agent allowance and is waiting for a memory decision.";
  return "This tab is using a relatively high share of its memory allowance.";
};

export function TerminalMemoryFlyout({
  members,
  quota,
  onPurge,
  onRestart,
  onHibernate,
  onClose,
}: {
  members: Array<{
    status: TerminalBudgetStatus;
    session?: Omit<TerminalNameSource, "id">;
  }>;
  quota: TerminalMemoryQuotaGroup;
  onPurge: () => void;
  onRestart: () => void;
  onHibernate: () => void;
  onClose: () => void;
}) {
  const names = members.map(({ status, session }) =>
    terminalDisplayName({ id: status.id, agent: false, ...session }),
  );
  const title = names.length > 1 ? `${names.length}-agent multiplex` : names[0];
  return (
    <aside className="terminal-memory-flyout" aria-label={`Memory actions for ${title}`}>
      <div className="terminal-memory-flyout-head">
        <div>
          <span className="terminal-memory-kicker">High memory</span>
          <strong>{title}</strong>
        </div>
        <Button icon title="Close memory actions" onClick={onClose}>×</Button>
      </div>
      <p>{stateCopy(quota)}</p>
      <div className="terminal-memory-reading">
        <span>Using {formatBytes(quota.current_bytes)}</span>
        <span>{formatBytes(quota.allowance_bytes)} combined allowance</span>
      </div>
      {members.length > 1 && (
        <div className="terminal-memory-members">
          {members.map(({ status }, index) => (
            <div key={status.id}>
              <span>{names[index]}</span>
              <span>{formatBytes(status.current_bytes)} / {formatBytes(status.allowance_bytes)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="terminal-memory-actions">
        <Button onClick={onPurge}>Purge / compact</Button>
        <Button onClick={onRestart}>Restart tab</Button>
        <Button variant="accent" onClick={onHibernate}>Hibernate</Button>
      </div>
    </aside>
  );
}

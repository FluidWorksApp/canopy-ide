import type { TerminalBudgetStatus } from "../ipc";
import { Button } from "./ui";

const formatBytes = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

const stateCopy = (status: TerminalBudgetStatus) => {
  if (status.state === "over_allowance") return "This tab is over its current memory allowance.";
  if (status.state === "awaiting_grant") return "This tab is close to its allowance and is waiting for a memory decision.";
  return "This tab is using a relatively high share of its memory allowance.";
};

export function TerminalMemoryFlyout({
  title,
  status,
  onPurge,
  onRestart,
  onHibernate,
  onClose,
}: {
  title: string;
  status: TerminalBudgetStatus;
  onPurge: () => void;
  onRestart: () => void;
  onHibernate: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="terminal-memory-flyout" aria-label={`Memory actions for ${title}`}>
      <div className="terminal-memory-flyout-head">
        <div>
          <span className="terminal-memory-kicker">High memory</span>
          <strong>{title}</strong>
        </div>
        <Button icon title="Close memory actions" onClick={onClose}>×</Button>
      </div>
      <p>{stateCopy(status)}</p>
      <div className="terminal-memory-reading">
        <span>Using {formatBytes(status.current_bytes)}</span>
        <span>{formatBytes(status.allowance_bytes)} allowance</span>
      </div>
      <div className="terminal-memory-actions">
        <Button onClick={onPurge}>Purge / compact</Button>
        <Button onClick={onRestart}>Restart tab</Button>
        <Button variant="accent" onClick={onHibernate}>Hibernate</Button>
      </div>
    </aside>
  );
}

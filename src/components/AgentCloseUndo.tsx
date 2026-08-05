import { memo } from "react";
import type { PendingAgentClose } from "../agentClose";
import { remainingCloseSeconds } from "../agentClose";
import { useSecondTick } from "../useSecondTick";

interface AgentCloseUndoProps {
  pending: PendingAgentClose[];
  onRestore: (id: string) => void;
}

function AgentCloseUndoImpl({ pending, onRestore }: AgentCloseUndoProps) {
  useSecondTick(pending.length > 0);
  if (pending.length === 0) return null;

  return (
    <div className="agent-close-stack" aria-live="polite">
      {pending.map((close) => (
        <div className="agent-close-undo" key={close.id} role="status">
          <span className="agent-close-copy">
            <strong>{close.title}</strong>
            <span>closes in {remainingCloseSeconds(close.deadline)}s</span>
          </span>
          <button type="button" onClick={() => onRestore(close.id)}>
            Restore
          </button>
        </div>
      ))}
    </div>
  );
}

export const AgentCloseUndo = memo(AgentCloseUndoImpl);

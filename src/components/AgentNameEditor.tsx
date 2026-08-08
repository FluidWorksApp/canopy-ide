import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";

export function AgentNameEditor({
  ptyId,
  name,
  className = "",
}: {
  ptyId: number;
  name: string;
  className?: string;
}) {
  const [saved, setSaved] = useState(name);
  const [draft, setDraft] = useState(name);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSaved(name);
    setDraft(name);
  }, [name]);

  const cancel = () => {
    setDraft(saved);
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    // Enter moves focus in some hosts, which can deliver blur in the same
    // frame. Keep the bridge mutation single-shot even before React commits
    // the busy state.
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await ipc.ptySetName(ptyId, draft);
      setSaved(next);
      setDraft(next);
      setEditing(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={`agent-name-editor ${className}`.trim()}
        aria-label={`Rename ${saved}`}
        title="Rename this agent"
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
      >
        {saved}
      </button>
    );
  }
  return (
    <span
      className="agent-name-editing"
      title={error ?? "Enter to save · Escape to cancel"}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        autoFocus
        value={draft}
        disabled={busy}
        aria-label="Agent name"
        aria-invalid={error ? true : undefined}
        maxLength={48}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          if (!busy) void save();
        }}
      />
    </span>
  );
}

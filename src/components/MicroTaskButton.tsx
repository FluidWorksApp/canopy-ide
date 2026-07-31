// The CTA a surface renders to launch a micro-task (microTasks.ts): one
// button, a small popover for optional user context, and go. Same handoff as
// AgentQueryBar, minus the free-text box — a micro-task always owns a fresh
// ephemeral session, which is what makes closing it safe.
import { useRef, useState } from "react";
import type { MicroTaskDef } from "../microTasks";
import { Button } from "./ui";

interface MicroTaskButtonProps<P> {
  task: MicroTaskDef<P>;
  payload: P;
  title?: string;
  onLaunch: (task: MicroTaskDef<P>, payload: P, userQuery: string) => void;
}

export function MicroTaskButton<P>({ task, payload, title, onLaunch }: MicroTaskButtonProps<P>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const go = () => {
    onLaunch(task, payload, query.trim());
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="review-send">
      <Button
        title={title ?? task.label}
        onClick={() => {
          setOpen((v) => !v);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}>
        {task.icon} {task.label}
      </Button>
      {open && (
        <div className="cli-menu review-menu" onMouseLeave={() => setOpen(false)}>
          <input
            ref={inputRef}
            className="agent-query-input"
            placeholder={task.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <button className="cli-menu-item" onClick={go}>
            Go
          </button>
        </div>
      )}
    </div>
  );
}

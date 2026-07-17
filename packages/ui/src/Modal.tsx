import { useEffect, type ReactNode } from "react";
import "./Modal.css";

interface BaseDialogProps {
  children: ReactNode;
  /** Backdrop click and Escape both route here. */
  onDismiss?: () => void;
  className?: string;
}

/** Escape-to-dismiss, shared by both weights. */
function useEscape(onDismiss?: () => void) {
  useEffect(() => {
    if (!onDismiss) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onDismiss();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onDismiss]);
}

/**
 * A task you work in — a form, a settings panel.
 *
 * Dismissal is wired to mousedown rather than click: a click that STARTS inside
 * the panel and ends on the backdrop (drag-selecting text, then releasing) is
 * still a backdrop click, and would close the dialog mid-edit.
 */
export function Modal({ children, onDismiss, className }: BaseDialogProps) {
  useEscape(onDismiss);
  return (
    <div className="cn-backdrop" onMouseDown={onDismiss}>
      <div
        className={["cn-modal", className].filter(Boolean).join(" ")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** A question you answer. Sits above a Modal — confirms are raised from them. */
export function Confirm({ children, onDismiss, className }: BaseDialogProps) {
  useEscape(onDismiss);
  return (
    <div className="cn-backdrop cn-backdrop-confirm" onMouseDown={onDismiss}>
      <div
        className={["cn-confirm", className].filter(Boolean).join(" ")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export interface PromptDialogProps extends BaseDialogProps {
  /** Fires on Enter and on the submit button alike. */
  onSubmit: () => void;
}

/**
 * A Confirm whose content is a form, so Enter submits natively.
 *
 * Use this for anything with a text field. Hanging submit off the input's
 * onKeyDown instead is how you end up with a dialog that has no submit button
 * and silently ignores Enter — the field is then the only way to submit, and
 * if focus never lands there, nothing works at all.
 */
export function PromptDialog({ children, onSubmit, onDismiss, className }: PromptDialogProps) {
  useEscape(onDismiss);
  return (
    <div className="cn-backdrop cn-backdrop-confirm" onMouseDown={onDismiss}>
      <form
        className={["cn-confirm", className].filter(Boolean).join(" ")}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </form>
    </div>
  );
}

/** Right-aligned action row. Order children cancel-first, confirm-last. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="cn-dialog-actions">{children}</div>;
}

/** The consequence line under a question. */
export function DialogSub({ children }: { children: ReactNode }) {
  return <p className="cn-dialog-sub">{children}</p>;
}

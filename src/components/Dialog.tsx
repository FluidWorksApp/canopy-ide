import {
  memo,
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
} from "react";
import { Button } from "./ui";
import { useEscapeLayer } from "../useEscape";

export interface DialogAction {
  label: string;
  /** Filled with accent (or danger when variant="danger"). Enter fires the
   *  first primary action, so exactly one action should carry it. */
  primary?: boolean;
  /** Mono shortcut shown inside the button, e.g. "⌘⌫". The primary action and
   *  the dismiss button get "⏎" / "esc" for free — pass this only to override. */
  hint?: string;
  /** Greys the button out and takes Enter away from it. */
  disabled?: boolean;
  onClick?: () => void;
}

export interface DialogProps {
  open?: boolean;
  title: string;
  body?: ReactNode;
  /** Mono consequence line — paths, counts, cost. Machine truth, not prose. */
  meta?: ReactNode;
  /** Mono chip in the header row, e.g. keyboard shortcut. */
  hint?: string;
  variant?: "default" | "danger" | "accent";
  size?: "sm" | "md" | "lg";
  /** Forces the status dot on a default dialog. */
  icon?: ReactNode;
  actions?: DialogAction[];
  /** Cancel-style button, rendered before actions. */
  dismissLabel?: string;
  onDismiss?: () => void;
  /** Absolute instead of fixed — for embedding inside a positioned container. */
  inline?: boolean;
  children?: ReactNode;
}

const SIZE_CLASS = { sm: "dlg-sm", md: "dlg-md", lg: "dlg-lg" } as const;

function DialogImpl({
  open = true,
  title,
  body,
  meta,
  hint,
  variant = "default",
  size = "md",
  icon,
  actions = [],
  dismissLabel,
  onDismiss,
  inline = false,
  children,
}: DialogProps) {
  const [alive, setAlive] = useState(open);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(null);
  // Read by the key listener, which must not re-subscribe on every render just
  // because the caller rebuilt its actions array inline.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  // While the dialog is up, Escape belongs to it and to nothing underneath.
  useEscapeLayer(alive && !closing);

  // Enter / exit lifecycle
  useEffect(() => {
    if (open) {
      setClosing(false);
      setAlive(true);
    } else if (alive) {
      setClosing(true);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unmount after exit animation finishes
  function handleAnimationEnd(e: AnimationEvent) {
    if (closing && e.target === e.currentTarget) {
      setAlive(false);
      setClosing(false);
    }
  }

  // Scroll lock, focus trap, Escape, focus restore
  useEffect(() => {
    if (!alive || closing) return;

    // Scroll lock
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Remember what had focus so we can restore it on close
    prevFocusRef.current = document.activeElement;

    // Autofocus: [data-autofocus] first, else first focusable
    const node = panelRef.current;
    if (node) {
      const target =
        (node.querySelector("[data-autofocus]") as HTMLElement | null) ??
        (node.querySelector(
          "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
        ) as HTMLElement | null);
      target?.focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss?.();
        return;
      }
      // Enter commits the dialog wherever focus happens to be — that is the
      // whole point of one shared dialog: the answer is never "click it".
      if (e.key === "Enter") {
        const el = document.activeElement as HTMLElement | null;
        // A focused button already gets Enter natively (firing here too would
        // run two actions), and a textarea owns the key for newlines.
        if (
          el?.tagName === "BUTTON" ||
          el?.tagName === "TEXTAREA" ||
          el?.isContentEditable
        )
          return;
        const primary = actionsRef.current.find((a) => a.primary);
        if (!primary || primary.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        primary.onClick?.();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
      // Restore focus to whatever had it before the dialog opened
      if (prevFocusRef.current instanceof HTMLElement) {
        prevFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, [alive, closing, onDismiss]);

  if (!alive) return null;

  const showDot = icon !== undefined || variant !== "default";
  const enterAction = actions.find((a) => a.primary);

  return (
    <div
      className={`dlg-scrim${closing ? " dlg-scrim-out" : ""}${inline ? " dlg-inline" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss?.();
      }}
      onAnimationEnd={handleAnimationEnd}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dlg-panel ${SIZE_CLASS[size] ?? SIZE_CLASS.md}${closing ? " dlg-panel-out" : ""}`}
      >
        {/* Header */}
        <div className="dlg-header">
          <div className="dlg-title-row">
            {showDot && (
              <span className={`dlg-dot dlg-dot-${variant}`} aria-hidden="true" />
            )}
            <span className={`dlg-title${variant === "danger" ? " dlg-title-danger" : ""}`}>
              {title}
            </span>
            {hint && <span className="dlg-hint-chip">{hint}</span>}
          </div>
          {body && <div className="dlg-body">{body}</div>}
        </div>

        {/* Optional children slot (form field, checklist, etc.) */}
        {children && <div className="dlg-children">{children}</div>}

        {/* Mono consequence line */}
        {meta && <div className="dlg-meta">{meta}</div>}

        {/* Action row */}
        {(actions.length > 0 || dismissLabel) && (
          <div className="dlg-actions">
            <span className="dlg-actions-spacer" />
            {dismissLabel && (
              <DialogButton
                label={dismissLabel}
                hint="esc"
                kind="quiet"
                onClick={onDismiss}
              />
            )}
            {actions.map((a, i) => (
              <DialogButton
                key={i}
                label={a.label}
                // The button Enter fires says so; the rest keep their own hint.
                hint={a.hint ?? (a === enterAction ? "⏎" : undefined)}
                onClick={a.onClick}
                disabled={a.disabled}
                kind={a.primary ? (variant === "danger" ? "danger" : "accent") : "quiet"}
                // The action Enter fires is also the one holding focus, danger
                // included — a confirmation you can't answer from the keyboard
                // is the thing this dialog exists to stop. A field in the
                // children slot can still claim focus with its own
                // data-autofocus, since it comes first in the DOM.
                autoFocus={a === enterAction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DialogButton({
  label,
  hint,
  onClick,
  kind = "quiet",
  autoFocus,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick?: () => void;
  kind?: "quiet" | "accent" | "danger";
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={kind === "quiet" ? "default" : kind}
      onClick={onClick}
      disabled={disabled}
      data-autofocus={autoFocus && !disabled ? "" : undefined}
    >
      {label}
      {/* Hidden from the accessible name: the button is "Discard", not
          "Discard ⏎" — the key is already announced by the shortcut itself. */}
      {hint && (
        <span className="dlg-btn-hint" aria-hidden="true">
          {hint}
        </span>
      )}
    </Button>
  );
}

export const Dialog = memo(DialogImpl);

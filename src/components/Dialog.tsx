import {
  memo,
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
} from "react";

export interface DialogAction {
  label: string;
  /** Filled with accent (or danger when variant="danger"). */
  primary?: boolean;
  /** Mono shortcut shown inside the button, e.g. "⌘⌫". */
  hint?: string;
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
              <DialogButton label={dismissLabel} kind="quiet" onClick={onDismiss} />
            )}
            {actions.map((a, i) => (
              <DialogButton
                key={i}
                label={a.label}
                hint={a.hint}
                onClick={a.onClick}
                kind={a.primary ? (variant === "danger" ? "danger" : "accent") : "quiet"}
                autoFocus={Boolean(a.primary) && variant !== "danger"}
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
}: {
  label: string;
  hint?: string;
  onClick?: () => void;
  kind?: "quiet" | "accent" | "danger";
  autoFocus?: boolean;
}) {
  return (
    <button
      type="button"
      className={`dlg-btn dlg-btn-${kind}`}
      onClick={onClick}
      data-autofocus={autoFocus ? "" : undefined}
    >
      {label}
      {hint && <span className="dlg-btn-hint">{hint}</span>}
    </button>
  );
}

export const Dialog = memo(DialogImpl);

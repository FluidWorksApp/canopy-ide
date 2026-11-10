// While any modal layer is open, Tab and Shift+Tab stay inside it. Most of the
// app's pop-ups (pickers, palettes, confirmations) are positioned over the page
// rather than made with <dialog>, so the browser lets focus walk off behind
// them; this keeps one rule for all of them instead of one per component.
//
// A layer that already handled the key (the shared Dialog traps for itself)
// calls preventDefault first and is left alone.

const MODAL = '[role="dialog"], [aria-modal="true"], dialog[open]';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

/** The topmost modal layer: the last one in document order that is showing. */
export function topModal(root: ParentNode = document): HTMLElement | null {
  const all = Array.from(root.querySelectorAll<HTMLElement>(MODAL)).filter(visible);
  return all[all.length - 1] ?? null;
}

export function trapTab(event: KeyboardEvent, root: ParentNode = document): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const modal = topModal(root);
  if (!modal) return;
  const items = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
  // Radio groups are one tab stop: arrows move inside them, so a roving
  // tabindex of -1 is already excluded above.
  if (items.length === 0) {
    event.preventDefault();
    modal.focus?.();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const index = active ? items.indexOf(active) : -1;
  const inside = !!active && modal.contains(active);
  if (!inside) {
    event.preventDefault();
    items[event.shiftKey ? items.length - 1 : 0].focus();
    return;
  }
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    items[items.length - 1].focus();
  } else if (!event.shiftKey && index === items.length - 1) {
    event.preventDefault();
    items[0].focus();
  }
}

/** Install once; returns the remover. */
export function installModalFocusTrap(target: Document = document): () => void {
  const handler = (event: KeyboardEvent) => trapTab(event, target);
  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}
